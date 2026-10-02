-- migrate:up
CREATE TABLE IF NOT EXISTS subject_correlation_index (
  correlation_key TEXT PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL,
  principal_id VARCHAR(128) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (correlation_key)
);

CREATE INDEX IF NOT EXISTS idx_subject_correlation_account
  ON subject_correlation_index(account_id, tenant_id, principal_id);

CREATE TABLE IF NOT EXISTS subject_right_workflows (
  workflow_id VARCHAR(128) PRIMARY KEY,
  workflow_type VARCHAR(32) NOT NULL,
  account_id VARCHAR(128) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL,
  principal_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  completed_store_ids JSONB NOT NULL DEFAULT '[]',
  retryable_store_ids JSONB NOT NULL DEFAULT '[]',
  deletion_parts JSONB NOT NULL DEFAULT '{}',
  export_parts JSONB NOT NULL DEFAULT '{}',
  receipt_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS deletion_receipts (
  receipt_id VARCHAR(128) PRIMARY KEY,
  workflow_id VARCHAR(128) NOT NULL REFERENCES subject_right_workflows(workflow_id),
  result_parts JSONB NOT NULL,
  verification_parts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_records (
  consent_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(128) NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  status VARCHAR(32) NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  scope VARCHAR(64) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_records_account_scope
  ON consent_records(account_id, scope, recorded_at DESC);

CREATE TABLE IF NOT EXISTS data_tombstones (
  subject_id_hash CHAR(64) NOT NULL,
  object_id_hash CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  deleted_at TIMESTAMPTZ NOT NULL,
  tombstone_version INTEGER NOT NULL CHECK (tombstone_version > 0),
  deletion_reason VARCHAR(128) NOT NULL,
  PRIMARY KEY (subject_id_hash, object_id_hash)
);

-- migrate:down
DROP TABLE IF EXISTS data_tombstones;
DROP TABLE IF EXISTS consent_records;
DROP TABLE IF EXISTS deletion_receipts;
DROP TABLE IF EXISTS subject_right_workflows;
DROP INDEX IF EXISTS idx_subject_correlation_account;
DROP TABLE IF EXISTS subject_correlation_index;
