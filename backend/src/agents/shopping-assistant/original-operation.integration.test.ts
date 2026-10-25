import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createConfirmationRequiredDescriptor, PgAuthorizationConfirmationStore } from "../../runtime/authorization/confirmation.js";
import { runMigrations } from "../../runtime/persistence/migration-runner.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import { createDispatchReadinessCheck } from "./dispatch-readiness.js";
import { PgOriginalOperationResolver } from "./original-operation.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const suiteId = randomUUID();
const tenantId = `original-operation-${suiteId}`;
const owner = "synthetic-shopper-a";

describePostgres("PgOriginalOperationResolver against Postgres", () => {
  let pool: Pool;
  let db: Queryable;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = {
      query: async (text, values = []) => {
        const result = await pool.query(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    await runMigrations("up", db);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM tool_executions WHERE run_id LIKE $1", [`run-%-${suiteId}`]);
    await pool.query("DELETE FROM business_effects WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM authorization_confirmations WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM permission_decisions WHERE tenant_id = $1", [tenantId]);
    await pool.end();
  });

  /** An approved order change whose execution holds a business effect, linked by decisionId. */
  async function approvedEffect(label: string, linkDecision = true) {
    const runId = `run-${label}-${suiteId}`;
    const decisionId = `decision-${label}-${suiteId}`;
    const businessEffectId = `effect-${label}-${suiteId}`;
    await pool.query(
      `INSERT INTO permission_decisions (
         decision_id, principal_id, principal_type, tenant_id, scope_id, action,
         resource_type, resource_id, effect, reason_code, created_at
       ) VALUES ($1, $2, 'user', $3, $3, 'tool:write', 'tool', 'order_refund_request',
                 'require_confirmation', 'REQUIRES_CONFIRMATION', NOW())`,
      [decisionId, owner, tenantId]
    );
    const descriptor = createConfirmationRequiredDescriptor({
      decisionId,
      executionContext: {
        requestId: `request-${label}`,
        threadId: `thread-${suiteId}`,
        runId,
        taskId: `task-${label}`,
        stepId: `step-${label}`,
        toolCallId: `call-${label}`,
        attempt: 1,
        principal: {
          principalId: owner,
          principalType: "user",
          tenantId,
          roles: [],
          scopes: [],
          authSource: "trusted_gateway",
          authenticatedAt: "2026-10-25T00:00:00.000Z",
        },
        scope: { scopeId: tenantId, scopeType: "tenant", tenantId },
      },
      action: "tool:write",
      toolName: "order_refund_request",
      resource: { resourceType: "tool", resourceId: "order_refund_request", tenantId },
      policyVersion: "runtime-authorization-v1",
      timeoutMs: 60_000,
    });
    await new PgAuthorizationConfirmationStore(db).upsertPending(descriptor);
    await pool.query(
      `INSERT INTO business_effects (business_effect_id, scope_id, tenant_id, business_effect_key, commit_state)
       VALUES ($1, $2, $2, $3, 'committed')`,
      [businessEffectId, tenantId, `key-${label}-${suiteId}`]
    );
    await pool.query(
      `INSERT INTO tool_executions (
         tool_execution_id, business_effect_id, replay_key, run_id, step_id,
         tool_name, tool_version, call_index, status, request_hash, decision_id
       ) VALUES ($1, $2, $3, $4, 'step-1', 'order_refund_request', '1.0.0', 0, 'committed', 'hash', $5)`,
      [`exec-${label}-${suiteId}`, businessEffectId, `replay-${label}-${suiteId}`, runId, linkDecision ? decisionId : null]
    );
    return { businessEffectId, approvalId: descriptor.approvalId };
  }

  it("resolves the original approval only for the requester's own tenant, scope and principal", async () => {
    const { businessEffectId, approvalId } = await approvedEffect("own");
    const resolver = new PgOriginalOperationResolver(db);
    const query = { businessEffectId, tenantId, scopeId: tenantId, principalId: owner };

    await expect(resolver.resolveApprovalId(query)).resolves.toBe(approvalId);
    await expect(resolver.resolveApprovalId({ ...query, principalId: "synthetic-shopper-b" })).resolves.toBeNull();
    await expect(resolver.resolveApprovalId({ ...query, tenantId: "another-tenant" })).resolves.toBeNull();
    await expect(resolver.resolveApprovalId({ ...query, scopeId: "another-scope" })).resolves.toBeNull();
  });

  it("returns null when the execution carries no decision link", async () => {
    const { businessEffectId } = await approvedEffect("unlinked", false);

    await expect(
      new PgOriginalOperationResolver(db).resolveApprovalId({ businessEffectId, tenantId, scopeId: tenantId, principalId: owner })
    ).resolves.toBeNull();
  });

  it("reports dispatch as ready when the ledger and approval tables answer", async () => {
    await expect(createDispatchReadinessCheck(db)()).resolves.toBe(true);
  });
});
