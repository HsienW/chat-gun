-- migrate:up
CREATE TABLE IF NOT EXISTS authorization_confirmations (
  approval_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES permission_decisions(decision_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  principal_ids TEXT[] NOT NULL,
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  step_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  descriptor JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_authorization_confirmations_pending_expiry
  ON authorization_confirmations(expires_at)
  WHERE status = 'pending';

-- migrate:down
DROP INDEX IF EXISTS idx_authorization_confirmations_pending_expiry;
DROP TABLE IF EXISTS authorization_confirmations;
