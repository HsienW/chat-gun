-- migrate:up
CREATE TABLE IF NOT EXISTS reconciliation_tasks (
  reconciliation_task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  business_effect_id TEXT NOT NULL UNIQUE REFERENCES business_effects(business_effect_id),
  tool_execution_id TEXT NOT NULL REFERENCES tool_executions(tool_execution_id),
  external_operation_id TEXT,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_tasks_tenant_scope
  ON reconciliation_tasks(tenant_id, scope_id);

-- migrate:down
DROP INDEX IF EXISTS idx_reconciliation_tasks_tenant_scope;
DROP TABLE IF EXISTS reconciliation_tasks;
