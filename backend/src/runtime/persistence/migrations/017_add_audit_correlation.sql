-- migrate:up
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS thread_id TEXT,
  ADD COLUMN IF NOT EXISTS run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_thread_id ON audit_events(thread_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);

-- migrate:down
DROP INDEX IF EXISTS idx_audit_events_run_id;
DROP INDEX IF EXISTS idx_audit_events_thread_id;
DROP INDEX IF EXISTS idx_audit_events_request_id;
ALTER TABLE audit_events
  DROP COLUMN IF EXISTS run_id,
  DROP COLUMN IF EXISTS thread_id,
  DROP COLUMN IF EXISTS request_id;
