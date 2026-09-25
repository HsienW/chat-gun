import type { Queryable } from "../persistence/rows.js";
import {
  serializeKey,
  type IdempotencyKey,
  type IdempotencyRecord,
  type IdempotencyStatus,
} from "./idempotency-key.js";

export type AcquireResult =
  | { acquired: true; record: IdempotencyRecord }
  | {
      acquired: false;
      existing: IdempotencyRecord;
      reason: "already_locked" | "already_completed" | "already_failed";
    };

export interface IdempotencyGuard {
  acquire(key: IdempotencyKey, ttlMs: number): Promise<AcquireResult>;
  markCompleted(key: IdempotencyKey, result?: unknown): Promise<void>;
  markFailed(key: IdempotencyKey): Promise<void>;
  getRecord(key: IdempotencyKey): Promise<IdempotencyRecord | null>;
}

interface IdempotencyRecordRow extends Record<string, unknown> {
  key: string;
  namespace: string;
  resource_key: string;
  version: string;
  status: string;
  result: unknown;
  created_at: string | Date;
  expires_at: string | Date;
}

const RECORD_COLUMNS = `
  key, namespace, resource_key, version, status, result, created_at, expires_at
`;

function isIdempotencyStatus(value: string): value is IdempotencyStatus {
  return value === "locked" || value === "completed" || value === "failed";
}

function toIsoString(value: string | Date, fieldName: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName} returned from idempotency_records`);
  }
  return date.toISOString();
}

function mapRecord(row: IdempotencyRecordRow): IdempotencyRecord {
  if (!isIdempotencyStatus(row.status)) {
    throw new Error(`Unknown idempotency status from database: ${row.status}`);
  }

  return {
    key: row.key,
    status: row.status,
    ...(row.result !== null ? { result: row.result } : {}),
    createdAt: toIsoString(row.created_at, "created_at"),
    expiresAt: toIsoString(row.expires_at, "expires_at"),
  };
}

function existingResult(record: IdempotencyRecord): AcquireResult {
  const reason = {
    locked: "already_locked",
    completed: "already_completed",
    failed: "already_failed",
  } as const;

  return {
    acquired: false,
    existing: record,
    reason: reason[record.status],
  };
}

export class PgIdempotencyGuard implements IdempotencyGuard {
  constructor(private readonly db: Queryable) {}

  async acquire(key: IdempotencyKey, ttlMs: number): Promise<AcquireResult> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Idempotency TTL must be a positive finite number");
    }

    const inserted = await this.tryInsert(key, ttlMs);
    if (inserted) return { acquired: true, record: inserted };

    let existing = await this.getRecord(key);
    if (!existing) {
      const recovered = await this.tryInsert(key, ttlMs);
      if (recovered) return { acquired: true, record: recovered };
      existing = await this.getRecord(key);
    }

    if (!existing) {
      throw new Error("Idempotency record disappeared during acquire");
    }

    if (existing.status === "failed") {
      const serialized = serializeKey(key);
      const deletion = await this.db.query(
        `DELETE FROM idempotency_records
         WHERE key = $1 AND status = 'failed'`,
        [serialized]
      );

      if ((deletion.rowCount ?? 0) > 0) {
        const retried = await this.tryInsert(key, ttlMs);
        if (retried) return { acquired: true, record: retried };
      }

      existing = await this.getRecord(key);
      if (!existing) {
        throw new Error("Idempotency record disappeared during failed retry");
      }
    }

    if (new Date(existing.expiresAt).getTime() < Date.now()) {
      const serialized = serializeKey(key);
      const deletion = await this.db.query(
        `DELETE FROM idempotency_records
         WHERE key = $1 AND expires_at < NOW()`,
        [serialized]
      );

      if ((deletion.rowCount ?? 0) > 0) {
        const reclaimed = await this.tryInsert(key, ttlMs);
        if (reclaimed) return { acquired: true, record: reclaimed };
      }

      existing = await this.getRecord(key);
      if (!existing) {
        throw new Error("Idempotency record disappeared during reclaim");
      }
    }

    return existingResult(existing);
  }

  async markCompleted(key: IdempotencyKey, result?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_records
       SET status = 'completed', result = $2
       WHERE key = $1`,
      [serializeKey(key), result ?? null]
    );
  }

  async markFailed(key: IdempotencyKey): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_records
       SET status = 'failed', result = NULL
       WHERE key = $1`,
      [serializeKey(key)]
    );
  }

  async getRecord(key: IdempotencyKey): Promise<IdempotencyRecord | null> {
    const queryResult = await this.db.query<IdempotencyRecordRow>(
      `SELECT ${RECORD_COLUMNS}
       FROM idempotency_records
       WHERE key = $1`,
      [serializeKey(key)]
    );
    const row = queryResult.rows[0];
    return row ? mapRecord(row) : null;
  }

  private async tryInsert(
    key: IdempotencyKey,
    ttlMs: number
  ): Promise<IdempotencyRecord | null> {
    const queryResult = await this.db.query<IdempotencyRecordRow>(
      `INSERT INTO idempotency_records
         (key, namespace, resource_key, version, status, expires_at)
       VALUES ($1, $2, $3, $4, 'locked', NOW() + interval '1 millisecond' * $5)
       ON CONFLICT (key) DO NOTHING
       RETURNING ${RECORD_COLUMNS}`,
      [serializeKey(key), key.namespace, key.resourceKey, key.version, ttlMs]
    );
    const row = queryResult.rows[0];
    return row ? mapRecord(row) : null;
  }
}
