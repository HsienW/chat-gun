-- migrate:up
CREATE TABLE IF NOT EXISTS recovery_records (
  record_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (
    classification IN (
      'user_cancelled', 'timed_out', 'superseded', 'crashed',
      'transport_disconnected'
    )
  ),
  reason JSONB NOT NULL,
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR
    cancellation_reason IN ('user_cancel', 'timeout', 'supersede', 'crash')
  ),
  transport_disconnect BOOLEAN NOT NULL DEFAULT FALSE,
  crash_fatal BOOLEAN,
  crash_phase TEXT,
  recovery_record JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (cancellation_reason = 'crash' AND crash_fatal IS NOT NULL AND crash_phase IS NOT NULL)
    OR (cancellation_reason IS DISTINCT FROM 'crash' AND crash_fatal IS NULL AND crash_phase IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_recovery_records_task_recorded
  ON recovery_records (task_id, recorded_at DESC);

-- migrate:down
DROP TABLE IF EXISTS recovery_records;
