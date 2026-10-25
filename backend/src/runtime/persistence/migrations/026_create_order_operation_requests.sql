-- migrate:up
CREATE TABLE IF NOT EXISTS order_operation_requests (
  approval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refund_request', 'cancel')),
  order_id TEXT NOT NULL,
  line_item_ids TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_operation_requests_order
  ON order_operation_requests(tenant_id, scope_id, principal_id, order_id, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS idx_order_operation_requests_order;
DROP TABLE IF EXISTS order_operation_requests;
