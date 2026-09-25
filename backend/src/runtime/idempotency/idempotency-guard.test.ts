import { describe, expect, it } from "vitest";

import { PgIdempotencyGuard } from "./idempotency-guard.js";
import type { IdempotencyStatus } from "./idempotency-key.js";
import type { Queryable } from "../persistence/rows.js";

interface StoredRecord {
  key: string;
  namespace: string;
  resource_key: string;
  version: string;
  status: IdempotencyStatus;
  result: unknown;
  created_at: Date;
  expires_at: Date;
}

class FakeIdempotencyDb implements Queryable {
  private record: StoredRecord | null = null;

  seed(status: IdempotencyStatus, expiresAt: Date, result: unknown = null): void {
    this.record = {
      key: "tool_execution:task-abc:step-1:v1",
      namespace: "tool_execution",
      resource_key: "task-abc:step-1",
      version: "1",
      status,
      result,
      created_at: new Date("2026-08-01T00:00:00.000Z"),
      expires_at: expiresAt,
    };
  }

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: TResult[]; rowCount: number | null }> {
    if (text.includes("INSERT INTO idempotency_records")) {
      if (this.record) return { rows: [], rowCount: 0 };

      const now = new Date();
      this.record = {
        key: String(values[0]),
        namespace: String(values[1]),
        resource_key: String(values[2]),
        version: String(values[3]),
        status: "locked",
        result: null,
        created_at: now,
        expires_at: new Date(now.getTime() + Number(values[4])),
      };
      return { rows: [this.record as unknown as TResult], rowCount: 1 };
    }

    if (text.includes("SELECT") && text.includes("idempotency_records")) {
      const rows = this.record
        ? [this.record as unknown as TResult]
        : [];
      return { rows, rowCount: rows.length };
    }

    if (text.includes("DELETE FROM idempotency_records")) {
      const canDelete = Boolean(
        this.record &&
          (text.includes("status = 'failed'")
            ? this.record.status === "failed"
            : this.record.expires_at.getTime() < Date.now())
      );
      if (canDelete) this.record = null;
      return { rows: [], rowCount: canDelete ? 1 : 0 };
    }

    if (text.includes("status = 'completed'")) {
      if (this.record) {
        this.record.status = "completed";
        this.record.result = values[1] ?? null;
      }
      return { rows: [], rowCount: this.record ? 1 : 0 };
    }

    if (text.includes("status = 'failed'")) {
      if (this.record) {
        this.record.status = "failed";
        this.record.result = null;
      }
      return { rows: [], rowCount: this.record ? 1 : 0 };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

const key = {
  namespace: "tool_execution",
  resourceKey: "task-abc:step-1",
  version: "1",
};

describe("PgIdempotencyGuard", () => {
  it("acquires a missing key", async () => {
    const guard = new PgIdempotencyGuard(new FakeIdempotencyDb());

    const acquired = await guard.acquire(key, 60_000);

    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      expect(acquired.record.status).toBe("locked");
      expect(new Date(acquired.record.expiresAt).getTime()).toBeGreaterThan(
        Date.now()
      );
    }
  });

  it.each([
    ["locked", "already_locked"],
    ["completed", "already_completed"],
  ] as const)("returns the existing %s state", async (status, reason) => {
    const db = new FakeIdempotencyDb();
    db.seed(status, new Date(Date.now() + 60_000), { output: "cached" });
    const guard = new PgIdempotencyGuard(db);

    const acquired = await guard.acquire(key, 60_000);

    expect(acquired).toMatchObject({
      acquired: false,
      reason,
      existing: { status },
    });
    if (!acquired.acquired && status === "completed") {
      expect(acquired.existing.result).toEqual({ output: "cached" });
    }
  });

  it("reclaims a failed record for a new attempt", async () => {
    const db = new FakeIdempotencyDb();
    db.seed("failed", new Date(Date.now() + 60_000));
    const guard = new PgIdempotencyGuard(db);

    const acquired = await guard.acquire(key, 60_000);

    expect(acquired).toMatchObject({
      acquired: true,
      record: { status: "locked" },
    });
  });

  it("reclaims an expired lock with a fresh TTL", async () => {
    const db = new FakeIdempotencyDb();
    db.seed("locked", new Date(Date.now() - 1_000));
    const guard = new PgIdempotencyGuard(db);

    const acquired = await guard.acquire(key, 60_000);

    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      expect(new Date(acquired.record.expiresAt).getTime()).toBeGreaterThan(
        Date.now()
      );
    }
  });

  it("marks completed and failed records and retrieves them", async () => {
    const db = new FakeIdempotencyDb();
    const guard = new PgIdempotencyGuard(db);
    await guard.acquire(key, 60_000);

    await guard.markCompleted(key, { output: "result" });
    await expect(guard.getRecord(key)).resolves.toMatchObject({
      status: "completed",
      result: { output: "result" },
    });

    await guard.markFailed(key);
    await expect(guard.getRecord(key)).resolves.toMatchObject({
      status: "failed",
    });
    expect((await guard.getRecord(key))?.result).toBeUndefined();
  });
});
