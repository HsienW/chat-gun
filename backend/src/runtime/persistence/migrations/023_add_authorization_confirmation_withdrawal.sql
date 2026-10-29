-- migrate:up
ALTER TABLE authorization_confirmations
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawn_by_principal_id TEXT;

-- migrate:down
ALTER TABLE authorization_confirmations
  DROP COLUMN IF EXISTS withdrawn_by_principal_id,
  DROP COLUMN IF EXISTS withdrawn_at;
