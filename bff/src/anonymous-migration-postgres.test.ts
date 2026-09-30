import { describe, expect, it, vi } from "vitest";

import { PgAnonymousMigrationStore } from "./anonymous-migration-postgres.js";
import type { PgQueryable } from "./identity-postgres.js";

describe("PgAnonymousMigrationStore", () => {
  it("uses an atomic insert and parameterized ownership lookup", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.startsWith("INSERT") ? [{ anonymous_id: "anonymous_01" }] : [],
    }));
    const store = new PgAnonymousMigrationStore({
      query: query as unknown as PgQueryable["query"],
    });
    await expect(store.claim({
      anonymousId: "anonymous_01",
      accountId: "account_01",
      idempotencyKey: "migration-secret-key",
    })).resolves.toBe("claimed");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (anonymous_id) DO NOTHING");
    expect(query.mock.calls[0]?.[1]).not.toContain("migration-secret-key");
    expect(String(query.mock.calls[0]?.[1]?.[2])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns conflict without revealing the existing account", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.startsWith("INSERT")
        ? []
        : [{ anonymous_id: "anonymous_01", account_id: "account_other", status: "complete" }],
    }));
    const store = new PgAnonymousMigrationStore({
      query: query as unknown as PgQueryable["query"],
    });
    await expect(store.claim({
      anonymousId: "anonymous_01",
      accountId: "account_01",
      idempotencyKey: "migration_01",
    })).resolves.toBe("conflict");
  });
});
