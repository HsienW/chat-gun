import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { Pool } from "pg";

import { runMigrations } from "../persistence/migration-runner.js";
import type { Queryable } from "../persistence/rows.js";
import { createConfirmationInterruptId, createConfirmationInterruptManifest } from "../recovery/confirmation-manifest.js";
import { PgInterruptManifestRepository } from "../recovery/interrupt-manifest-repository.js";
import {
  createConfirmationRequiredDescriptor,
  parseConfirmationResume,
  PgAuthorizationConfirmationStore,
} from "./confirmation.js";
import { PgConsumedAuthorizationVerifier } from "./consumed-authorization-verifier.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const suiteId = randomUUID();
const tenantId = `confirmation-integration-${suiteId}`;

const executionManifest = {
  manifestVersion: "1.0.0" as const,
  graphId: "shopping_assistant",
  graphConfigHash: "c".repeat(64),
  schemaVersions: {
    runtimeEventEnvelope: "1.0.0",
    toolDescriptor: "1.0",
    authorizationPolicy: "1.0",
    normalizedInput: "1.0",
  },
};

function contextFor(runId: string) {
  return {
    requestId: `request-${runId}`,
    threadId: `thread-${suiteId}`,
    runId,
    taskId: `task-${runId}`,
    stepId: `step-${runId}`,
    toolCallId: `call-${runId}`,
    attempt: 1,
    principal: {
      principalId: "principal-1",
      principalType: "user" as const,
      tenantId,
      roles: ["customer"],
      scopes: ["tool:write"],
      authSource: "trusted_gateway" as const,
      authenticatedAt: "2026-10-24T00:00:00.000Z",
    },
    scope: { scopeId: tenantId, scopeType: "tenant" as const, tenantId },
  };
}

describePostgres("PgAuthorizationConfirmationStore withdrawal against Postgres", () => {
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
    await pool.query("DELETE FROM interrupt_manifests WHERE scope_id = $1", [tenantId]);
    await pool.query("DELETE FROM authorization_confirmations WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM permission_decisions WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM agent_tasks WHERE task_id LIKE $1", [`task-run-%-${suiteId}`]);
    await pool.end();
  });

  async function pendingConfirmation(label: string) {
    const waitingRun = `run-${label}-${suiteId}`;
    const executionContext = contextFor(waitingRun);
    const decisionId = `decision-${label}-${suiteId}`;
    await pool.query(
      `INSERT INTO agent_tasks (task_id, task_type, status, metadata, created_at, updated_at)
       VALUES ($1, 'interaction_runtime', 'running', '{}'::jsonb, NOW(), NOW())`,
      [executionContext.taskId]
    );
    await pool.query(
      `INSERT INTO task_steps (step_id, task_id, step_name, status)
       VALUES ($1, $2, 'order_refund_request', 'running')`,
      [executionContext.stepId, executionContext.taskId]
    );
    await pool.query(
      `INSERT INTO permission_decisions (
         decision_id, principal_id, principal_type, tenant_id, scope_id, action,
         resource_type, resource_id, effect, reason_code, created_at
       ) VALUES ($1, 'principal-1', 'user', $2, $2, 'tool:write', 'order', 'order-1',
                 'require_confirmation', 'REQUIRES_CONFIRMATION', NOW())`,
      [decisionId, tenantId]
    );
    const descriptor = createConfirmationRequiredDescriptor({
      decisionId,
      executionContext,
      action: "tool:write",
      toolName: "order_refund_request",
      resource: { resourceType: "order", resourceId: "order-1", tenantId },
      policyVersion: "runtime-authorization-v1",
      timeoutMs: 60_000,
    });
    const store = new PgAuthorizationConfirmationStore(db);
    await store.upsertPending(descriptor);
    await new PgInterruptManifestRepository(db).create(
      createConfirmationInterruptManifest({ descriptor, executionManifest })
    );
    return { store, descriptor, executionContext };
  }

  it("withdraws as denied plus withdrawn_at, supersedes the manifest, and blocks a later approval", async () => {
    const { store, descriptor, executionContext } = await pendingConfirmation("withdraw");
    const cancelling = contextFor(`run-cancel-${suiteId}`);

    await expect(store.withdraw({ descriptor, executionContext: cancelling })).resolves.toEqual({
      ok: true,
      status: "withdrawn",
    });

    const stored = await pool.query(
      `SELECT status, withdrawn_at, withdrawn_by_principal_id
       FROM authorization_confirmations WHERE approval_id = $1`,
      [descriptor.approvalId]
    );
    expect(stored.rows[0]).toMatchObject({
      status: "denied",
      withdrawn_by_principal_id: "principal-1",
    });
    expect(stored.rows[0]?.withdrawn_at).not.toBeNull();
    const decision = await pool.query(
      "SELECT effect, reason_code FROM permission_decisions WHERE decision_id = $1",
      [descriptor.decisionId]
    );
    expect(decision.rows[0]).toEqual({ effect: "deny", reason_code: "CONFIRMATION_CANCELLED" });
    const manifest = await new PgInterruptManifestRepository(db).findWaitingConfirmationByThread({
      threadId: executionContext.threadId,
      scopeId: tenantId,
    });
    expect(
      manifest?.kind === "confirmation" &&
        manifest.decisionRef.approvalId === descriptor.approvalId
    ).toBe(false);
    const manifestStatus = await pool.query(
      "SELECT status FROM interrupt_manifests WHERE scope_id = $1 AND thread_id = $2",
      [tenantId, executionContext.threadId]
    );
    expect(manifestStatus.rows.map((row) => row.status)).toContain("superseded");

    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });
    await expect(store.consume({ descriptor, resume, executionContext })).resolves.toEqual({
      ok: false,
      reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED",
    });
    await expect(store.withdraw({ descriptor, executionContext: cancelling })).resolves.toEqual({
      ok: true,
      status: "withdrawn",
    });
    await expect(store.findStatus(descriptor)).resolves.toMatchObject({
      status: "denied",
      withdrawn: true,
    });
  });

  it("rolls back every write and keeps the confirmation pending when a step of the withdrawal fails", async () => {
    const { store, descriptor } = await pendingConfirmation("fault");
    const triggerName = `x43_withdraw_fault_${suiteId.replace(/-/g, "_")}`;
    await pool.query(
      `CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
       BEGIN
         IF NEW.status = 'superseded' AND NEW.scope_id = '${tenantId}' THEN
           RAISE EXCEPTION 'injected manifest failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON interrupt_manifests
       FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`
    );
    try {
      await expect(store.withdraw({
        descriptor,
        executionContext: contextFor(`run-fault-cancel-${suiteId}`),
      })).resolves.toEqual({ ok: false, reasonCode: "CONFIRMATION_WITHDRAW_FAILED" });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON interrupt_manifests`);
      await pool.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
    }

    const stored = await pool.query(
      "SELECT status, withdrawn_at FROM authorization_confirmations WHERE approval_id = $1",
      [descriptor.approvalId]
    );
    expect(stored.rows[0]).toEqual({ status: "pending", withdrawn_at: null });
    const decision = await pool.query(
      "SELECT effect, reason_code FROM permission_decisions WHERE decision_id = $1",
      [descriptor.decisionId]
    );
    expect(decision.rows[0]).toEqual({
      effect: "require_confirmation",
      reason_code: "REQUIRES_CONFIRMATION",
    });
  });

  it("lets exactly one of a concurrent withdrawal and approval take effect", async () => {
    const { store, descriptor, executionContext } = await pendingConfirmation("race");
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });

    const [withdrawn, consumed] = await Promise.all([
      store.withdraw({ descriptor, executionContext: contextFor(`run-race-cancel-${suiteId}`) }),
      store.consume({ descriptor, resume, executionContext }),
    ]);

    const withdrawWon = withdrawn.ok && withdrawn.status === "withdrawn";
    const approveWon = consumed.ok && consumed.status === "approved";
    expect([withdrawWon, approveWon].filter(Boolean)).toHaveLength(1);
    if (approveWon) {
      expect(withdrawn).toEqual({ ok: false, reasonCode: "CONFIRMATION_ALREADY_DECIDED" });
    }
  });

  describe("consumed authorization verification", () => {
    function approveResume(descriptor: { approvalId: string; decisionId: string }) {
      return parseConfirmationResume({
        type: "tool_authorization_confirmation",
        schemaVersion: "1.0",
        approvalId: descriptor.approvalId,
        decisionId: descriptor.decisionId,
        decision: "approve",
      });
    }

    it("accepts only an approved, consumed confirmation for the same principal, tool and call", async () => {
      const { store, descriptor, executionContext } = await pendingConfirmation("verify-approved");
      const verifier = new PgConsumedAuthorizationVerifier(db);
      const check = (overrides: Partial<Parameters<typeof verifier.verify>[0]> = {}) =>
        verifier.verify({
          decisionId: descriptor.decisionId,
          toolName: "order_refund_request",
          executionContext,
          ...overrides,
        });

      await expect(check()).resolves.toBe(false);

      await expect(
        store.consume({ descriptor, resume: approveResume(descriptor), executionContext })
      ).resolves.toEqual({ ok: true, status: "approved" });

      await expect(check()).resolves.toBe(true);
      await expect(check({ decisionId: `forged-${suiteId}` })).resolves.toBe(false);
      await expect(check({ toolName: "order_cancel" })).resolves.toBe(false);
      await expect(
        check({ executionContext: { ...executionContext, toolCallId: "call-other" } })
      ).resolves.toBe(false);
      await expect(
        check({
          executionContext: {
            ...executionContext,
            principal: { ...executionContext.principal, principalId: "principal-other" },
          },
        })
      ).resolves.toBe(false);
      await expect(
        check({
          executionContext: {
            ...executionContext,
            scope: { ...executionContext.scope, scopeId: "scope-other" },
          },
        })
      ).resolves.toBe(false);
    });

    it("rejects a withdrawn confirmation", async () => {
      const { store, descriptor, executionContext } = await pendingConfirmation("verify-withdrawn");
      await store.withdraw({ descriptor, executionContext: contextFor(`run-verify-cancel-${suiteId}`) });

      await expect(
        new PgConsumedAuthorizationVerifier(db).verify({
          decisionId: descriptor.decisionId,
          toolName: "order_refund_request",
          executionContext,
        })
      ).resolves.toBe(false);
    });

    it("accepts a direct allow only for the tool it was recorded for", async () => {
      const decisionId = `decision-allow-${suiteId}`;
      await pool.query(
        `INSERT INTO permission_decisions (
           decision_id, principal_id, principal_type, tenant_id, scope_id, action,
           resource_type, resource_id, effect, reason_code, context_summary, created_at
         ) VALUES ($1, 'principal-1', 'user', $2, $2, 'tool:read', 'order', 'order-1',
                   'allow', 'POLICY_ALLOWED', $3::jsonb, NOW())`,
        [decisionId, tenantId, JSON.stringify({ toolName: "order_operation_status" })]
      );
      const verifier = new PgConsumedAuthorizationVerifier(db);
      const executionContext = contextFor(`run-verify-allow-${suiteId}`);

      await expect(
        verifier.verify({ decisionId, toolName: "order_operation_status", executionContext })
      ).resolves.toBe(true);
      await expect(
        verifier.verify({ decisionId, toolName: "order_refund_request", executionContext })
      ).resolves.toBe(false);
    });
  });

  describe("PgInterruptManifestRepository status writes", () => {
    it("moves a waiting confirmation manifest to resumed and writes a real timestamp", async () => {
      const { descriptor } = await pendingConfirmation("manifest-transition");
      const repository = new PgInterruptManifestRepository(db);
      const interruptId = createConfirmationInterruptId(descriptor);
      const now = new Date();

      const resumed = await repository.transitionStatus({ interruptId, expectedStatus: "waiting", nextStatus: "resumed", now });

      expect(resumed?.status).toBe("resumed");
      const row = await pool.query("SELECT status, updated_at FROM interrupt_manifests WHERE interrupt_id = $1", [interruptId]);
      expect(row.rows[0]?.status).toBe("resumed");
      expect((row.rows[0]?.updated_at as Date).toISOString()).toBe(now.toISOString());
      await expect(
        repository.transitionStatus({ interruptId, expectedStatus: "waiting", nextStatus: "rejected" })
      ).resolves.toBeNull();
    });

    it("consumes a waiting manifest only before it expires", async () => {
      const { descriptor, executionContext } = await pendingConfirmation("manifest-consume");
      const repository = new PgInterruptManifestRepository(db);
      const interruptId = createConfirmationInterruptId(descriptor);
      const binding = {
        interruptId,
        runId: executionContext.runId,
        taskId: executionContext.taskId,
        scopeId: executionContext.scope.scopeId,
      };

      await expect(repository.consume({ ...binding, now: new Date(Date.now() + 120_000) })).resolves.toBeNull();
      await expect(repository.consume(binding)).resolves.toMatchObject({ status: "resumed" });
      await expect(repository.consume(binding)).resolves.toBeNull();
    });
  });
});
