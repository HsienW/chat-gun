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
