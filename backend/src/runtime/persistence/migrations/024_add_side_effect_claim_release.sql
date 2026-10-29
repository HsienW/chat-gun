-- migrate:up
ALTER TABLE business_effects
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

ALTER TABLE tool_executions
  ADD COLUMN IF NOT EXISTS claim_disposition VARCHAR(32)
    CHECK (claim_disposition IN ('not_claimed'));

-- migrate:down
ALTER TABLE tool_executions
  DROP COLUMN IF EXISTS claim_disposition;

ALTER TABLE business_effects
  DROP COLUMN IF EXISTS released_at;
