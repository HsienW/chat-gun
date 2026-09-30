import { createHash } from "node:crypto";

import type {
  AccountRecord,
  AccountTombstone,
  CredentialRecord,
  IdentityLifecycleStorePort,
  SessionRecord,
} from "./identity-lifecycle.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export const CONSUMER_IDENTITY_UP_SQL = `
CREATE TABLE IF NOT EXISTS identity_accounts (
  account_id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL UNIQUE,
  tenant_id VARCHAR(128) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_users (
  user_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL REFERENCES identity_accounts(account_id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_tenants (
  tenant_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL UNIQUE REFERENCES identity_accounts(account_id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_credentials (
  credential_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL REFERENCES identity_accounts(account_id) ON DELETE CASCADE,
  device_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  rotated_from_credential_id VARCHAR(128),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_sessions (
  session_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL REFERENCES identity_accounts(account_id) ON DELETE CASCADE,
  principal_id VARCHAR(128) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  credential_id VARCHAR(128) NOT NULL REFERENCES identity_credentials(credential_id),
  status VARCHAR(32) NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_account_tombstones (
  account_id_hash CHAR(64) PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL,
  tombstone_version INTEGER NOT NULL,
  deletion_reason VARCHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_anonymous_migrations (
  anonymous_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL REFERENCES identity_accounts(account_id) ON DELETE CASCADE,
  idempotency_key_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_sessions_account_id_idx ON identity_sessions(account_id);
CREATE INDEX IF NOT EXISTS identity_sessions_principal_id_idx ON identity_sessions(principal_id);
CREATE INDEX IF NOT EXISTS identity_sessions_credential_id_idx ON identity_sessions(credential_id);
CREATE INDEX IF NOT EXISTS identity_tenants_account_id_idx ON identity_tenants(account_id);
CREATE INDEX IF NOT EXISTS identity_anonymous_migrations_account_id_idx ON identity_anonymous_migrations(account_id);
`;

export const CONSUMER_IDENTITY_DOWN_SQL = `
DROP TABLE IF EXISTS identity_anonymous_migrations;
DROP TABLE IF EXISTS identity_sessions;
DROP TABLE IF EXISTS identity_credentials;
DROP TABLE IF EXISTS identity_tenants;
DROP TABLE IF EXISTS identity_users;
DROP TABLE IF EXISTS identity_accounts;
DROP TABLE IF EXISTS identity_account_tombstones;
`;

type AccountRow = {
  account_id: string;
  user_id: string;
  tenant_id: string;
  status: AccountRecord["status"];
  created_at: Date | string;
  updated_at: Date | string;
};

type SessionRow = {
  session_id: string;
  account_id: string;
  principal_id: string;
  device_id: string;
  credential_id: string;
  status: SessionRecord["status"];
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type CredentialRow = {
  credential_id: string;
  account_id: string;
  device_id: string;
  status: CredentialRecord["status"];
  rotated_from_credential_id: string | null;
  absolute_expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    credentialId: row.credential_id,
    status: row.status,
    idleExpiresAt: iso(row.idle_expires_at),
    absoluteExpiresAt: iso(row.absolute_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PgIdentityLifecycleStore implements IdentityLifecycleStorePort {
  constructor(private readonly database: PgQueryable) {}

  async findAccount(accountId: string): Promise<AccountRecord | null> {
    const result = await this.database.query<AccountRow>(
      "SELECT account_id, user_id, tenant_id, status, created_at, updated_at FROM identity_accounts WHERE account_id = $1",
      [accountId],
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async saveAccount(account: AccountRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO identity_accounts (account_id, user_id, tenant_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [account.accountId, account.userId, account.tenantId, account.status, account.createdAt, account.updatedAt],
    );
  }

  async removeAccount(accountId: string): Promise<void> {
    await this.database.query("DELETE FROM identity_accounts WHERE account_id = $1", [accountId]);
  }

  async findTombstone(accountId: string): Promise<AccountTombstone | null> {
    const hash = createHash("sha256").update(accountId, "utf8").digest("hex");
    const result = await this.database.query<{
      account_id_hash: string;
      deleted_at: Date | string;
      tombstone_version: 1;
      deletion_reason: string;
    }>(
      "SELECT account_id_hash, deleted_at, tombstone_version, deletion_reason FROM identity_account_tombstones WHERE account_id_hash = $1",
      [hash],
    );
    const row = result.rows[0];
    return row ? {
      accountIdHash: row.account_id_hash,
      deletedAt: iso(row.deleted_at),
      tombstoneVersion: row.tombstone_version,
      deletionReason: row.deletion_reason,
    } : null;
  }

  async saveTombstone(_accountId: string, tombstone: AccountTombstone): Promise<void> {
    await this.database.query(
      "INSERT INTO identity_account_tombstones (account_id_hash, deleted_at, tombstone_version, deletion_reason) VALUES ($1, $2, $3, $4) ON CONFLICT (account_id_hash) DO NOTHING",
      [tombstone.accountIdHash, tombstone.deletedAt, tombstone.tombstoneVersion, tombstone.deletionReason],
    );
  }

  async saveUser(userId: string, accountId: string, updatedAt: string): Promise<void> {
    await this.database.query(
      "INSERT INTO identity_users (user_id, account_id, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET updated_at = EXCLUDED.updated_at",
      [userId, accountId, updatedAt],
    );
  }

  async savePersonalTenant(tenantId: string, accountId: string, updatedAt: string): Promise<void> {
    await this.database.query(
      "INSERT INTO identity_tenants (tenant_id, account_id, updated_at) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET updated_at = EXCLUDED.updated_at",
      [tenantId, accountId, updatedAt],
    );
  }

  async findSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.database.query<SessionRow>(
      "SELECT session_id, account_id, principal_id, device_id, credential_id, status, idle_expires_at, absolute_expires_at, created_at, updated_at FROM identity_sessions WHERE session_id = $1",
      [sessionId],
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO identity_sessions (session_id, account_id, principal_id, device_id, credential_id, status, idle_expires_at, absolute_expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, idle_expires_at = EXCLUDED.idle_expires_at, updated_at = EXCLUDED.updated_at`,
      [session.sessionId, session.accountId, session.principalId, session.deviceId, session.credentialId, session.status, session.idleExpiresAt, session.absoluteExpiresAt, session.createdAt, session.updatedAt],
    );
  }

  private async listSessions(column: "principal_id" | "credential_id", value: string): Promise<SessionRecord[]> {
    const result = await this.database.query<SessionRow>(
      `SELECT session_id, account_id, principal_id, device_id, credential_id, status, idle_expires_at, absolute_expires_at, created_at, updated_at FROM identity_sessions WHERE ${column} = $1`,
      [value],
    );
    return result.rows.map(sessionFromRow);
  }

  listSessionsByPrincipal(principalId: string): Promise<SessionRecord[]> {
    return this.listSessions("principal_id", principalId);
  }

  listSessionsByCredential(credentialId: string): Promise<SessionRecord[]> {
    return this.listSessions("credential_id", credentialId);
  }

  async markCredentialCompromised(credentialId: string, updatedAt: string): Promise<void> {
    await this.database.query(
      "UPDATE identity_credentials SET status = 'compromised', updated_at = $2 WHERE credential_id = $1",
      [credentialId, updatedAt],
    );
  }


  async findCredential(credentialId: string): Promise<CredentialRecord | null> {
    const result = await this.database.query<CredentialRow>(
      "SELECT credential_id, account_id, device_id, status, rotated_from_credential_id, absolute_expires_at, created_at, updated_at FROM identity_credentials WHERE credential_id = $1",
      [credentialId],
    );
    const row = result.rows[0];
    return row ? {
      credentialId: row.credential_id,
      accountId: row.account_id,
      deviceId: row.device_id,
      status: row.status,
      ...(row.rotated_from_credential_id ? { rotatedFromCredentialId: row.rotated_from_credential_id } : {}),
      absoluteExpiresAt: iso(row.absolute_expires_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    } : null;
  }

  async saveCredential(credential: CredentialRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO identity_credentials (credential_id, account_id, device_id, status, rotated_from_credential_id, absolute_expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (credential_id) DO UPDATE SET status = EXCLUDED.status, absolute_expires_at = EXCLUDED.absolute_expires_at, updated_at = EXCLUDED.updated_at`,
      [credential.credentialId, credential.accountId, credential.deviceId, credential.status, credential.rotatedFromCredentialId ?? null, credential.absoluteExpiresAt, credential.createdAt, credential.updatedAt],
    );
  }
}

export async function applyConsumerIdentityMigration(database: PgQueryable): Promise<void> {
  await database.query(CONSUMER_IDENTITY_UP_SQL);
}

export async function rollbackConsumerIdentityMigration(database: PgQueryable): Promise<void> {
  await database.query(CONSUMER_IDENTITY_DOWN_SQL);
}
