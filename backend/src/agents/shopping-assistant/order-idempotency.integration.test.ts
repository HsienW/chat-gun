import { randomUUID } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import type { AuditLogger } from "../../platform/observability.js";
import { applyToolGovernance } from "../../platform/tool-governance.js";
import { createNoopSpanManager } from "../../platform/tracing/span-manager.js";
import type { ConfirmationRequiredDescriptor } from "../../runtime/authorization/confirmation.js";
import { PgConsumedAuthorizationVerifier } from "../../runtime/authorization/consumed-authorization-verifier.js";
import { PgGrantStore } from "../../runtime/authorization/grant-store.js";
import type { CompensationRegistry } from "../../runtime/compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../../runtime/compensation/saga-orchestrator.js";
import { NoopStepLock } from "../../runtime/lock/step-lock.js";
import { runMigrations } from "../../runtime/persistence/migration-runner.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import { PgBusinessEffectLedger, PgSideEffectDatabase, type BusinessEffectLedger } from "../../runtime/side-effect/business-effect-ledger.js";
import { PgReconciliationTaskStore } from "../../runtime/side-effect/reconciliation-task-store.js";
import { PgResultReferenceStore } from "../../runtime/side-effect/result-reference-store.js";
import { ToolExecutionRunner } from "../../runtime/side-effect/tool-execution-runner.js";
import { createRuntimeToolDispatchPipeline } from "../../runtime/tool-dispatch/pipeline.js";
import { RuntimeToolDescriptorRegistry } from "../../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { createRuntimeToolAuthorizationComposition } from "../../tools/authorization/tool-authorization.js";
import {
  MockOrderProvider,
  OrderProviderError,
  type MockOrderProviderOptions,
  type OrderProvider,
} from "../../tools/orders/mock-order-provider.js";
import { ORDER_TOOL_NAMES, createOrderToolRiskPolicies, createOrderToolSet } from "../../tools/orders/order-tools.js";
import { loadSyntheticOrderFixture, parseSyntheticOrderFixture, type SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { createDispatchReadinessCheck } from "./dispatch-readiness.js";
import { createShoppingAssistantGraph } from "./graph.js";
import { PgOriginalOperationResolver } from "./original-operation.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const suiteId = randomUUID().slice(0, 8);
/** Every test gets a tenant of its own, so no test sees another's ledger and cleanup touches nothing else. */
const TENANT_PREFIX = `x43-t7-${suiteId}-`;
const SHOPPER_A = "synthetic-shopper-a";
const SHOPPER_B = "synthetic-shopper-b";

type ToolCallSpec = { name: string; id: string; args: Record<string, unknown> };

const refund = (id: string, args: Record<string, unknown> = {}): ToolCallSpec => ({
  name: "order_refund_request",
  id,
  args: { orderId: "ORD-1001", reasonCode: "damaged", ...args },
});

/** Delegates to the mock order system; can be made unavailable before dispatch. */
class SwitchableProvider implements OrderProvider {
  unavailable = false;
  constructor(readonly inner: MockOrderProvider) {}
  submitRefund(request: Parameters<OrderProvider["submitRefund"]>[0]) {
    if (this.unavailable) return Promise.reject(new OrderProviderError("ORDER_PROVIDER_UNAVAILABLE"));
    return this.inner.submitRefund(request);
  }
  submitCancel(request: Parameters<OrderProvider["submitCancel"]>[0]) {
    if (this.unavailable) return Promise.reject(new OrderProviderError("ORDER_PROVIDER_UNAVAILABLE"));
    return this.inner.submitCancel(request);
  }
  lookup(query: Parameters<OrderProvider["lookup"]>[0]) {
    return this.inner.lookup(query);
  }
}

describePostgres("order idempotency against the Postgres ledger", () => {
  let pool: Pool;
  let db: Queryable;
  let synthetic: SyntheticOrderFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = {
      query: async (text, values = []) => {
        const result = await pool.query(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    await runMigrations("up", db);
    synthetic = await loadSyntheticOrderFixture();
  });

  /** A fresh tenant with the order tools granted and its own copy of the synthetic orders. */
  async function newTenant(label: string) {
    const tenantId = `${TENANT_PREFIX}${label}`;
    const grants = new PgGrantStore(db);
    for (const toolName of ORDER_TOOL_NAMES) {
      await grants.create({
        grantId: `${tenantId}-${toolName}`,
        resource: { resourceType: "tool", resourceId: toolName, tenantId, ownerScopeId: tenantId },
        granteeScopeId: tenantId,
        granteeTenantId: tenantId,
        actions: [toolName === "order_operation_status" ? "tool:read" : "tool:write"],
        grantedByPrincipalId: "master",
        grantedByScopeId: tenantId,
        canDelegate: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const fixture = parseSyntheticOrderFixture({
      ...synthetic,
      orders: synthetic.orders.map((order) => ({ ...order, tenantId })),
    });
    return { tenantId, fixture };
  }

  afterAll(async () => {
    const executions = "SELECT tool_execution_id FROM tool_executions WHERE run_id LIKE $1";
    const runs = `run-%-${suiteId}`;
    const tenants = `${TENANT_PREFIX}%`;
    await pool.query("DELETE FROM reconciliation_tasks WHERE tenant_id LIKE $1", [tenants]);
    await pool.query(`DELETE FROM tool_execution_attempts WHERE tool_execution_id IN (${executions})`, [runs]);
    await pool.query(`DELETE FROM result_references WHERE tool_execution_id IN (${executions})`, [runs]);
    await pool.query("DELETE FROM tool_executions WHERE run_id LIKE $1", [runs]);
    await pool.query("DELETE FROM business_effects WHERE tenant_id LIKE $1", [tenants]);
    await pool.query("DELETE FROM interrupt_manifests WHERE scope_id LIKE $1", [tenants]);
    await pool.query("DELETE FROM authorization_confirmations WHERE tenant_id LIKE $1", [tenants]);
    await pool.query("DELETE FROM permission_decisions WHERE tenant_id LIKE $1", [tenants]);
    await pool.query("DELETE FROM permission_grants WHERE resource_tenant_id LIKE $1", [tenants]);
    await pool.query("DELETE FROM agent_tasks WHERE task_id LIKE $1", [`task-run-%-${suiteId}`]);
    await pool.end();
  });

  function contextFor(tenantId: string, threadId: string, runId: string, principalId: string) {
    return {
      requestId: `request-${runId}`,
      threadId,
      runId,
      taskId: `task-${runId}`,
      stepId: `step-${runId}`,
      attempt: 1,
      principal: {
        principalId,
        principalType: "user" as const,
        tenantId,
        roles: [],
        scopes: [],
        authSource: "trusted_gateway" as const,
        authenticatedAt: "2026-10-25T00:00:00.000Z",
      },
      scope: { scopeId: tenantId, scopeType: "tenant" as const, tenantId },
    };
  }

  /** One shopping graph over the real ledger, approvals, decisions and reconciliation tasks. */
  function harness(tenantId: string, provider: OrderProvider, wrapLedger: (ledger: BusinessEffectLedger) => BusinessEffectLedger = (ledger) => ledger) {
    const composition = createRuntimeToolAuthorizationComposition({
      profile: "production",
      db,
      additionalPolicies: createOrderToolRiskPolicies(),
    });
    const orderTools = createOrderToolSet({ provider, statusReader: { read: async () => null } });
    const registry = new RuntimeToolDescriptorRegistry();
    for (const descriptor of orderTools.descriptors) {
      registry.register({ toolName: descriptor.toolName, toolVersion: descriptor.toolVersion }, descriptor);
    }
    const runnerAudit: AuditLogger = { record: vi.fn(async () => undefined) };
    const runner = new ToolExecutionRunner(
      wrapLedger(new PgBusinessEffectLedger(new PgSideEffectDatabase(pool))),
      new PgResultReferenceStore(db),
      { auditLogger: runnerAudit, spanManager: createNoopSpanManager(), recordMetric: vi.fn(async () => undefined) },
      undefined,
      new PgReconciliationTaskStore(db)
    );
    const compensationRegistry: CompensationRegistry = {
      register: vi.fn(), deregister: vi.fn(), getActions: vi.fn(() => []), hasActions: vi.fn(() => false),
    };
    const pipeline = createRuntimeToolDispatchPipeline({
      pool: null,
      registry,
      toolExecutionRunner: runner,
      retryBudgetFactory: (stepId, policy) => ({ stepId, maxAttempts: policy.maxAttempts, maxElapsedMs: policy.maxElapsedMs, startedAt: Date.now(), attempts: 0 }),
      taskStepAdapter: { start: vi.fn(async () => undefined), complete: vi.fn(async () => undefined), fail: vi.fn(async () => undefined) },
      compensationRegistry,
      sagaOrchestrator: { compensate: vi.fn() } as unknown as SagaOrchestrator,
      observability: { audit: vi.fn(async () => undefined), metric: vi.fn(async () => undefined) },
      stepLock: new NoopStepLock(),
      stepLockTtlMs: 30_000,
      emitDeduplicatedOutcome: true,
      consumedAuthorizationVerifier: new PgConsumedAuthorizationVerifier(db),
    });
    const tools = applyToolGovernance(orderTools.tools, composition.authorization, {
      createExecutor: (source, defaultExecutor) => pipeline.createExecutor(source.name, defaultExecutor),
    });
    let nextCalls: ToolCallSpec[] = [];
    const orderModel: ChatModelInvoker = {
      invoke: vi.fn(),
      bindTools: () => ({ invoke: async () => new AIMessage({ content: "", tool_calls: nextCalls }) }),
    };
    const graph = createShoppingAssistantGraph(
      {
        tools,
        confirmationStore: composition.confirmationStore,
        interruptManifestRepository: composition.interruptManifestRepository,
        intentRouter: {
          promptVersion: "shopping-intent-v1",
          route: async () => ({ status: "routed" as const, intent: "order_operation" as const, rationaleCode: "requests_order_change" as const, attempts: 1 }),
        },
        createProductRequestModel: () => {
          throw new Error("the order branch never binds kb_search");
        },
        policyAnswerSynthesizer: { promptVersion: "shopping-policy-answer-v1", synthesize: vi.fn() },
        createOrderRequestModel: () => orderModel,
        checkDispatchReadiness: createDispatchReadinessCheck(db),
        confirmationWithdrawal: composition.confirmationStore,
        originalOperationResolver: new PgOriginalOperationResolver(db),
        audit: vi.fn(async () => undefined),
      },
      { checkpointer: new MemorySaver() }
    );

    /** Requests one order change in its own thread and run, stopping at the approval interrupt. */
    async function request(label: string, call: ToolCallSpec, principalId = SHOPPER_A) {
      const threadId = `thread-${label}-${suiteId}`;
      const runId = `run-${label}-${suiteId}`;
      const context = contextFor(tenantId, threadId, runId, principalId);
      await pool.query(
        `INSERT INTO agent_tasks (task_id, task_type, status, metadata, created_at, updated_at)
         VALUES ($1, 'interaction_runtime', 'running', '{}'::jsonb, NOW(), NOW())`,
        [context.taskId]
      );
      await pool.query(
        `INSERT INTO task_steps (step_id, task_id, step_name, status) VALUES ($1, $2, 'order_branch', 'running')`,
        [context.stepId, context.taskId]
      );
      const config = { configurable: { thread_id: threadId, execution_context: context } };
      nextCalls = [call];
      const waiting = await graph.invoke({ messages: [new HumanMessage("order change")] }, config);
      const descriptor = waiting.pendingAuthorization as ConfirmationRequiredDescriptor | null | undefined;
      if (!descriptor) throw new Error(`No approval for ${label}: ${JSON.stringify(waiting.operations)}`);
      return {
        descriptor,
        toolCallId: call.id,
        approve: () =>
          graph.invoke(
            new Command({
              resume: {
                type: "tool_authorization_confirmation",
                schemaVersion: descriptor.schemaVersion,
                approvalId: descriptor.approvalId,
                decisionId: descriptor.decisionId,
                decision: "approve",
              },
            }),
            config
          ),
      };
    }

    return { request, runnerAudit };
  }

  /** A tenant, its mock order system and a graph over the shared Postgres runtime. */
  async function setup(
    label: string,
    options: Partial<MockOrderProviderOptions> = {},
    wrap?: (provider: MockOrderProvider) => OrderProvider,
    wrapLedger?: (ledger: BusinessEffectLedger) => BusinessEffectLedger
  ) {
    const { tenantId, fixture } = await newTenant(label);
    let next = 0;
    const provider = new MockOrderProvider({ fixture, createExternalOperationId: () => `ext-${tenantId}-${++next}`, ...options });
    const used = wrap ? wrap(provider) : provider;
    // Another harness is another backend instance: its own pipeline and scheduler over the same ledger and order system.
    return { tenantId, provider, used, h: harness(tenantId, used, wrapLedger), anotherInstance: () => harness(tenantId, used) };
  }

  async function committedEffects(tenantId: string) {
    const result = await pool.query(
      `SELECT e.business_effect_id, e.commit_state, e.external_operation_id, x.decision_id
         FROM business_effects e
         JOIN tool_executions x ON x.business_effect_id = e.business_effect_id AND x.status = 'committed'
          -- The execution that committed the effect, not a submission that reused it.
          AND x.termination_cause IS DISTINCT FROM 'deduplicated'
        WHERE e.tenant_id = $1 AND e.commit_state = 'committed'`,
      [tenantId]
    );
    return result.rows as { business_effect_id: string; external_operation_id: string; decision_id: string }[];
  }

  /** The order system holds the first submission inside its commit until released. */
  function commitGate() {
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const inCommit = new Promise<void>((resolve) => (entered = resolve));
    const gate = {
      holds: 0,
      release,
      inCommit,
      beforeCommit: async () => {
        gate.holds += 1;
        entered();
        await hold;
      },
    };
    return gate;
  }

  it("commits overlapping duplicates from two instances and threads once and reports the other as deduplicated", async () => {
    const gate = commitGate();
    const { tenantId, provider, h, anotherInstance } = await setup("conc", { beforeCommit: gate.beforeCommit });
    const first = await h.request("conc-a", refund("call-a"));
    const second = await anotherInstance().request("conc-b", refund("call-b"));

    const firstRun = first.approve();
    // The first submission now holds the claim inside the order system's commit.
    await gate.inCommit;
    // The second one runs to completion while the first is still held: the two overlap.
    const duplicate = await second.approve();
    const holds = gate.holds;

    expect(provider.submissions).toBe(1);
    expect(duplicate.operations["call-b"]).toMatchObject({
      state: "deduplicated",
      operationId: second.descriptor.approvalId,
      dedup: { reason: "in_flight_duplicate", of: first.descriptor.approvalId },
    });

    gate.release();
    const original = await firstRun;

    expect(original.operations["call-a"]).toMatchObject({ state: "confirmed", externalOperationId: `ext-${tenantId}-1` });
    expect(holds).toBe(1);
    expect(provider.submissions).toBe(1);
    const effects = await committedEffects(tenantId);
    expect(effects).toHaveLength(1);
    // The ledger links the committed effect to the approval decision and the order system's operation.
    expect(effects[0]).toMatchObject({ decision_id: first.descriptor.decisionId, external_operation_id: `ext-${tenantId}-1` });
  });

  it("queues a duplicate behind the held first submission on one instance and reuses its result", async () => {
    const gate = commitGate();
    const { tenantId, provider, h } = await setup("serial", { beforeCommit: gate.beforeCommit });
    const first = await h.request("serial-a", refund("call-a"));
    const second = await h.request("serial-b", refund("call-b"));

    const firstRun = first.approve();
    await gate.inCommit;
    let secondDone = false;
    const secondRun = second.approve().then((state) => {
      secondDone = true;
      return state;
    });
    // One instance dispatches mutations one at a time, so the duplicate waits for the held submission.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondDone).toBe(false);
    gate.release();
    const [original, duplicate] = await Promise.all([firstRun, secondRun]);

    expect(original.operations["call-a"]?.state).toBe("confirmed");
    expect(duplicate.operations["call-b"]).toMatchObject({
      state: "deduplicated",
      dedup: { reason: "committed_result_reused", of: first.descriptor.approvalId },
      externalOperationId: `ext-${tenantId}-1`,
    });
    expect(provider.submissions).toBe(1);
    expect(await committedEffects(tenantId)).toHaveLength(1);
  });

  it("deduplicates a later request of the same refund, also with another reason and thread", async () => {
    const { provider, h } = await setup("later");
    const original = await (await h.request("later-a", refund("call-1"))).approve();
    const again = await h.request("later-b", refund("call-2", { reasonCode: "other", note: "please" }));

    const reused = await again.approve();

    expect(original.operations["call-1"]?.state).toBe("confirmed");
    expect(provider.submissions).toBe(1);
    expect(reused.operations["call-2"]).toMatchObject({
      state: "deduplicated",
      operationId: again.descriptor.approvalId,
      externalOperationId: original.operations["call-1"]?.externalOperationId,
      dedup: { reason: "committed_result_reused" },
    });
    expect(reused.operations["call-2"]?.dedup?.of).toBe(original.operations["call-1"]?.operationId);
  });

  it("runs a request again after a not-committed failure instead of deduplicating it", async () => {
    const { used, h } = await setup("retry", {}, (inner) => new SwitchableProvider(inner));
    const provider = used as SwitchableProvider;
    provider.unavailable = true;
    const failed = await (await h.request("retry-a", refund("call-1"))).approve();
    provider.unavailable = false;

    const retried = await (await h.request("retry-b", refund("call-2"))).approve();

    expect(failed.operations["call-1"]).toMatchObject({ state: "failed", reasonCode: "ORDER_PROVIDER_UNAVAILABLE" });
    expect(retried.operations["call-2"]?.state).toBe("confirmed");
    expect(provider.inner.submissions).toBe(1);
  });

  it("answers another shopper's identical refund as not found, without any trace of the original", async () => {
    const { tenantId, h } = await setup("foreign");
    await (await h.request("foreign-a", refund("call-1"))).approve();

    const foreign = await (await h.request("foreign-b", refund("call-2"), SHOPPER_B)).approve();

    const record = foreign.operations["call-2"];
    expect(record).toMatchObject({ state: "failed", reasonCode: "ORDER_NOT_FOUND" });
    expect(record?.dedup).toBeUndefined();
    expect(record?.externalOperationId).toBeUndefined();
    expect(JSON.stringify(foreign.messages)).not.toContain(`ext-${tenantId}-1`);
    expect(await committedEffects(tenantId)).toHaveLength(1);
  });

  it("runs refunds of different line items independently", async () => {
    const { tenantId, h } = await setup("lines");

    const first = await (await h.request("lines-a", refund("call-1", { orderId: "ORD-1002", lineItems: [{ lineItemId: "LI-1002-1", quantity: 1 }] }))).approve();
    const second = await (await h.request("lines-b", refund("call-2", { orderId: "ORD-1002", lineItems: [{ lineItemId: "LI-1002-2", quantity: 1 }] }))).approve();

    expect(first.operations["call-1"]?.state).toBe("confirmed");
    expect(second.operations["call-2"]?.state).toBe("confirmed");
    expect(await committedEffects(tenantId)).toHaveLength(2);
  });

  it("confirms a lost response through reconciliation without submitting again", async () => {
    const { tenantId, provider, h } = await setup("lost-committed", { faults: { afterDispatch: { kind: "response_lost", committed: true } } });

    const state = await (await h.request("lost-committed", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "confirmed", externalOperationId: `ext-${tenantId}-1` });
    expect(provider.submissions).toBe(1);
    expect(provider.lookups).toBe(1);
    expect(h.runnerAudit.record).toHaveBeenCalledWith(
      "tool.side_effect.committed",
      expect.objectContaining({ source: "reconciled" }),
      expect.anything()
    );
  });

  it("fails a lost response confirmed as not committed, without retry, and releases the claim", async () => {
    const { provider, h } = await setup("lost-not-committed", { faults: { afterDispatch: { kind: "timeout", committed: false } } });

    const state = await (await h.request("lost-not-committed", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "failed", reasonCode: "SIDE_EFFECT_NOT_COMMITTED" });
    expect(provider.submissions).toBe(1);
    const effect = await pool.query(
      `SELECT e.commit_state, e.released_at FROM business_effects e
         JOIN tool_executions x ON x.business_effect_id = e.business_effect_id
        WHERE x.run_id = $1`,
      [`run-lost-not-committed-${suiteId}`]
    );
    expect(effect.rows[0]).toMatchObject({ commit_state: "prepared" });
    expect(effect.rows[0]?.released_at).not.toBeNull();
  });

  it("leaves an undeterminable outcome unknown with exactly one open reconciliation task", async () => {
    const { tenantId, provider, h } = await setup("lost-unknown", {
      faults: { afterDispatch: { kind: "response_lost", committed: true }, lookupIndeterminate: true },
    });

    const state = await (await h.request("lost-unknown", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "outcome_unknown", reasonCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED" });
    expect(provider.submissions).toBe(1);
    const tasks = await pool.query(
      `SELECT t.reconciliation_task_id, t.business_effect_id, t.tool_execution_id, t.reason_code, t.status, e.commit_state
         FROM reconciliation_tasks t
         JOIN business_effects e ON e.business_effect_id = t.business_effect_id
         JOIN tool_executions x ON x.tool_execution_id = t.tool_execution_id
        WHERE x.run_id = $1`,
      [`run-lost-unknown-${suiteId}`]
    );
    expect(tasks.rows).toHaveLength(1);
    const task = tasks.rows[0] as Record<string, string>;
    expect(task).toMatchObject({ reason_code: "ORDER_PROVIDER_LOOKUP_INDETERMINATE", status: "open", commit_state: "unknown" });

    // Opening it again for the same business effect is a no-op.
    const reopened = await new PgReconciliationTaskStore(db).open({
      tenantId,
      scopeId: tenantId,
      businessEffectId: task.business_effect_id!,
      toolExecutionId: task.tool_execution_id!,
      reasonCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
    });
    expect(reopened).toEqual({ reconciliationTaskId: task.reconciliation_task_id, created: false });
    const count = await pool.query("SELECT COUNT(*)::int AS n FROM reconciliation_tasks WHERE business_effect_id = $1", [task.business_effect_id]);
    expect(count.rows[0]).toEqual({ n: 1 });
  });

  /** The real ledger whose commit write fails the given way; every other call goes to Postgres unchanged. */
  function failingCommit(mode: "before_write_once" | "always" | "after_write_once") {
    let failures = 0;
    return (ledger: BusinessEffectLedger): BusinessEffectLedger =>
      Object.assign(Object.create(ledger) as BusinessEffectLedger, {
        commitExecutionAndBusinessEffect: async (input: Parameters<BusinessEffectLedger["commitExecutionAndBusinessEffect"]>[0]) => {
          if (mode === "always" || (mode === "before_write_once" && failures++ === 0)) {
            throw new Error("ledger write failed");
          }
          await ledger.commitExecutionAndBusinessEffect(input);
          // The transaction committed but its response was lost.
          if (mode === "after_write_once" && failures++ === 0) throw new Error("commit response lost");
        },
      });
  }

  async function effectAndTasks(tenantId: string) {
    const effects = await pool.query("SELECT business_effect_id, commit_state FROM business_effects WHERE tenant_id = $1", [tenantId]);
    const tasks = await pool.query("SELECT reason_code, status FROM reconciliation_tasks WHERE tenant_id = $1", [tenantId]);
    return { effects: effects.rows as { commit_state: string }[], tasks: tasks.rows as { reason_code: string; status: string }[] };
  }

  it("writes the commit again after a failed ledger write and confirms through reconciliation", async () => {
    const { tenantId, provider, h } = await setup("persist-retry", {}, undefined, failingCommit("before_write_once"));

    const state = await (await h.request("persist-retry", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "confirmed", externalOperationId: `ext-${tenantId}-1` });
    expect(provider.submissions).toBe(1);
    expect(provider.lookups).toBe(1);
    expect(await effectAndTasks(tenantId)).toEqual({ effects: [expect.objectContaining({ commit_state: "committed" })], tasks: [] });
  });

  it("stays unknown with an open task when the ledger write keeps failing", async () => {
    const { tenantId, provider, h } = await setup("persist-down", {}, undefined, failingCommit("always"));

    const state = await (await h.request("persist-down", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "outcome_unknown", reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" });
    expect(provider.submissions).toBe(1);
    expect(await effectAndTasks(tenantId)).toEqual({
      effects: [expect.objectContaining({ commit_state: "prepared" })],
      tasks: [{ reason_code: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", status: "open" }],
    });
  });

  it("opens a task without a second submission when the lost commit had actually been written", async () => {
    const { tenantId, provider, h } = await setup("persist-lost", {}, undefined, failingCommit("after_write_once"));

    const state = await (await h.request("persist-lost", refund("call-1"))).approve();

    expect(state.operations["call-1"]).toMatchObject({ state: "outcome_unknown", reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" });
    expect(provider.submissions).toBe(1);
    expect(await effectAndTasks(tenantId)).toEqual({
      effects: [expect.objectContaining({ commit_state: "committed" })],
      tasks: [{ reason_code: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", status: "open" }],
    });
  });
});
