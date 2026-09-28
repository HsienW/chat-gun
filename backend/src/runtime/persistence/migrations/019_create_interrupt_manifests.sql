-- migrate:up
CREATE TABLE IF NOT EXISTS interrupt_manifests (
  interrupt_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'clarification')),
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  step_id TEXT REFERENCES task_steps(step_id) ON DELETE SET NULL,
  scope_id TEXT NOT NULL,
  expected_response_schema_ref TEXT NOT NULL,
  expiry_at TIMESTAMPTZ NOT NULL,
  execution_manifest JSONB NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('waiting', 'resumed', 'expired', 'superseded', 'rejected')
  ),
  decision_id TEXT,
  approval_id TEXT,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (kind = 'confirmation' AND decision_id IS NOT NULL AND approval_id IS NOT NULL)
    OR (kind = 'clarification' AND decision_id IS NULL AND approval_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_interrupt_manifests_waiting_expiry
  ON interrupt_manifests (status, expiry_at)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_interrupt_manifests_task
  ON interrupt_manifests (task_id, run_id);

-- migrate:down
DROP TABLE IF EXISTS interrupt_manifests;
