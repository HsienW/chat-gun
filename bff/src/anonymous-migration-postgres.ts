import { createHash } from "node:crypto";

import type {
  AnonymousMigrationStorePort,
  AnonymousOwnership,
} from "./anonymous-migration.js";
import type { PgQueryable } from "./identity-postgres.js";

type MigrationRow = {
  anonymous_id: string;
  account_id: string;
  status: "in_progress" | "complete";
};

export class PgAnonymousMigrationStore implements AnonymousMigrationStorePort {
  constructor(private readonly database: PgQueryable) {}

  async claim(input: {
    anonymousId: string;
    accountId: string;
    idempotencyKey: string;
  }): Promise<"claimed" | "resume" | "already_migrated" | "conflict"> {
    const idempotencyKeyHash = createHash("sha256")
      .update(input.idempotencyKey, "utf8")
      .digest("hex");
    const inserted = await this.database.query<{ anonymous_id: string }>(
      `INSERT INTO identity_anonymous_migrations
         (anonymous_id, account_id, idempotency_key_hash, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'in_progress', NOW(), NOW())
       ON CONFLICT (anonymous_id) DO NOTHING
       RETURNING anonymous_id`,
      [input.anonymousId, input.accountId, idempotencyKeyHash],
    );
    if (inserted.rows.length > 0) return "claimed";

    const existing = await this.database.query<MigrationRow>(
      "SELECT anonymous_id, account_id, status FROM identity_anonymous_migrations WHERE anonymous_id = $1",
      [input.anonymousId],
    );
    const row = existing.rows[0];
    if (!row || row.account_id !== input.accountId) return "conflict";
    return row.status === "complete" ? "already_migrated" : "resume";
  }

  async complete(anonymousId: string, accountId: string): Promise<void> {
    const result = await this.database.query<{ anonymous_id: string }>(
      `UPDATE identity_anonymous_migrations
       SET status = 'complete', updated_at = NOW()
       WHERE anonymous_id = $1 AND account_id = $2
       RETURNING anonymous_id`,
      [anonymousId, accountId],
    );
    if (result.rows.length === 0) throw new Error("ANONYMOUS_MIGRATION_OWNERSHIP_CHANGED");
  }

  async getOwnership(anonymousId: string): Promise<AnonymousOwnership | null> {
    const result = await this.database.query<MigrationRow>(
      "SELECT anonymous_id, account_id, status FROM identity_anonymous_migrations WHERE anonymous_id = $1",
      [anonymousId],
    );
    const row = result.rows[0];
    return row
      ? { anonymousId: row.anonymous_id, accountId: row.account_id, status: row.status }
      : null;
  }
}
