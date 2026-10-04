-- migrate:up
ALTER TABLE tool_executions
  ADD COLUMN IF NOT EXISTS execution_profile_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS effective_capabilities JSONB,
  ADD COLUMN IF NOT EXISTS secret_refs_used JSONB,
  ADD COLUMN IF NOT EXISTS egress_decision JSONB,
  ADD COLUMN IF NOT EXISTS termination_cause VARCHAR(64);

-- migrate:down
ALTER TABLE tool_executions
  DROP COLUMN IF EXISTS termination_cause,
  DROP COLUMN IF EXISTS egress_decision,
  DROP COLUMN IF EXISTS secret_refs_used,
  DROP COLUMN IF EXISTS effective_capabilities,
  DROP COLUMN IF EXISTS execution_profile_version;
