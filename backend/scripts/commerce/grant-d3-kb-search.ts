/**
 * D3 live smoke setup: grants the synthetic test principal's scope `tool:read`
 * on kb_search. Idempotent; the grant expires with the authorization that
 * allowed it. Usage: npx tsx scripts/commerce/grant-d3-kb-search.ts
 */
import { randomUUID } from "node:crypto";

import "dotenv/config";

import { PgGrantStore } from "../../src/runtime/authorization/grant-store.js";
import { getPool } from "../../src/runtime/persistence/connection.js";

const TENANT_ID = "synthetic-tenant";
const SCOPE_ID = "synthetic-tenant";
const EXPIRES_AT = "2026-10-31T15:59:59.000Z";

const pool = getPool();
if (pool === null) throw new Error("DATABASE_URL is not configured");
const store = new PgGrantStore(pool);
const resource = { resourceType: "tool", resourceId: "kb_search", tenantId: TENANT_ID, ownerScopeId: SCOPE_ID };

try {
  const existing = await store.findMatching({
    resource,
    granteeScopeId: SCOPE_ID,
    granteeTenantId: TENANT_ID,
    action: "tool:read",
  });
  const grant = existing ?? await store.create({
    grantId: `d3-live-smoke-${randomUUID()}`,
    resource,
    granteeScopeId: SCOPE_ID,
    granteeTenantId: TENANT_ID,
    actions: ["tool:read"],
    grantedByPrincipalId: "master",
    grantedByScopeId: SCOPE_ID,
    canDelegate: false,
    createdAt: new Date().toISOString(),
    expiresAt: EXPIRES_AT,
  });
  console.log(JSON.stringify({ created: existing === null, grantId: grant.grantId, actions: grant.actions, expiresAt: grant.expiresAt }));
} finally {
  await pool.end();
}
