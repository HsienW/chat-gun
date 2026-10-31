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
import { PgOrderOperationRequestStore } from "./operation-requests.js";
import { PgOrderOperationStatusReader } from "./operation-status.js";
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
    await pool.query("DELETE FROM order_operation_requests WHERE tenant_id LIKE $1", [tenants]);
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
    const statusReader = new PgOrderOperationStatusReader(db, { originalOperationResolver: new PgOriginalOperationResolver(db) });
    const orderTools = createOrderToolSet({ provider, statusReader });
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
        operationRequests: new PgOrderOperationRequestStore(db),
        audit: vi.fn(async () => undefined),
      },
      { checkpointer: new MemorySaver() }
    );

    /** A thread and run of its own, with the runtime task and step the ledger refers to. */
    async function startRun(label: string, principalId: string) {
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
      return { context, config: { configurable: { thread_id: threadId, execution_context: context } } };
    }

    /** Requests one order change in its own thread and run, stopping at the approval interrupt. */
    async function request(label: string, call: ToolCallSpec, principalId = SHOPPER_A) {
      const { context, config } = await startRun(label, principalId);
      nextCalls = [call];
      const waiting = await graph.invoke({ messages: [new HumanMessage("order change")] }, config);
      const descriptor = waiting.pendingAuthorization as ConfirmationRequiredDescriptor | null | undefined;
      if (!descriptor) throw new Error(`No approval for ${label}: ${JSON.stringify(waiting.operations)}`);
      const decide = (decision: "approve" | "deny") =>
        graph.invoke(
          new Command({
            resume: {
              type: "tool_authorization_confirmation",
              schemaVersion: descriptor.schemaVersion,
              approvalId: descriptor.approvalId,
              decisionId: descriptor.decisionId,
              decision,
            },
          }),
          config
        );
      return {
        descriptor,
        context,
        toolCallId: call.id,
        approve: () => decide("approve"),
        deny: () => decide("deny"),
      };
    }

    /** Looks an operation up through the status tool in a fresh thread with no earlier conversation. */
    async function lookup(label: string, args: { operationId?: string; orderId?: string }, principalId = SHOPPER_A) {
      const { config } = await startRun(label, principalId);
      nextCalls = [{ name: "order_operation_status", id: `lookup-${label}`, args }];
      const state = await graph.invoke({ messages: [new HumanMessage("status")] }, config);
      return String(state.messages.at(-1)?.content ?? "");
    }

    return { request, lookup, runnerAudit, composition, statusReader };
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

  it("retains old ledger and status across epoch reset and deduplicates a same-epoch restart", async () => {
    const { tenantId } = await newTenant("binding-reset");
    const providerFor = (epoch: string) => new MockOrderProvider({
      fixture: synthetic,
      ownerBinding: { sourceTenantId: tenantId, sourcePrincipalId: SHOPPER_A,
        targetTenantId: "synthetic-tenant", targetOwnerPrincipalId: SHOPPER_A, epoch },
      now: () => new Date("2026-10-24T12:00:00Z"),
    });
    const firstProvider = providerFor("e1");
    const firstHarness = harness(tenantId, firstProvider);
    const first = await firstHarness.request("binding-e1", refund("binding-call-e1"));
    expect((await first.approve()).operations["binding-call-e1"]?.state).toBe("confirmed");
    const oldRows = await committedEffects(tenantId);
    expect(oldRows).toHaveLength(1);
    const restartedProvider = providerFor("e1");
    const restarted = await harness(tenantId, restartedProvider).request("binding-restart", refund("binding-call-restart"));
    expect((await restarted.approve()).operations["binding-call-restart"]).toMatchObject({ state: "deduplicated", dedup: { of: first.descriptor.approvalId } });
    expect(restartedProvider.submissions).toBe(0);
    const resetProvider = providerFor("e2");
    const resetHarness = harness(tenantId, resetProvider);
    const reset = await resetHarness.request("binding-e2", refund("binding-call-e2"));
    expect((await reset.approve()).operations["binding-call-e2"]?.state).toBe("confirmed");
    expect(resetProvider.submissions).toBe(1);
    const rows = await committedEffects(tenantId);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining(oldRows));
    await expect(resetHarness.statusReader.read({ tenantId, scopeId: tenantId, principalId: SHOPPER_A, operationId: first.descriptor.approvalId }))
      .resolves.toMatchObject({ state: "confirmed" });
  });

  it("commits parallel bound operations in one epoch only once", async () => {
    const { tenantId } = await newTenant("binding-concurrent");
    const gate = commitGate();
    const provider = new MockOrderProvider({ fixture: synthetic,
      ownerBinding: { sourceTenantId: tenantId, sourcePrincipalId: SHOPPER_A,
        targetTenantId: "synthetic-tenant", targetOwnerPrincipalId: SHOPPER_A, epoch: "e1" },
      beforeCommit: gate.beforeCommit, now: () => new Date("2026-10-24T12:00:00Z"),
    });
    const first = await harness(tenantId, provider).request("bound-conc-a", refund("bound-call-a"));
    const second = await harness(tenantId, provider).request("bound-conc-b", refund("bound-call-b"));
    const running = first.approve();
    await gate.inCommit;
    try {
      expect((await second.approve()).operations["bound-call-b"]).toMatchObject({ state: "deduplicated", dedup: { of: first.descriptor.approvalId } });
      expect(provider.submissions).toBe(1);
    } finally {
      gate.release();
    }
    expect((await running).operations["bound-call-a"]?.state).toBe("confirmed");
    expect(await committedEffects(tenantId)).toHaveLength(1);
  });

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

  /** What the status lookup reads straight from the runtime database for a shopper. */
  function statusOf(
    h: ReturnType<typeof harness>,
    tenantId: string,
    query: { operationId?: string; orderId?: string },
    principalId = SHOPPER_A
  ) {
    return h.statusReader.read({ tenantId, scopeId: tenantId, principalId, ...query });
  }

  it("reports a waiting approval with the order it names, by operation id or order id", async () => {
    const { tenantId, h } = await setup("status-waiting");
    const waiting = await h.request(
      "status-waiting",
      refund("call-1", {
        orderId: "ORD-1002",
        lineItems: [
          { lineItemId: "LI-1002-2", quantity: 1 },
          { lineItemId: "LI-1002-1", quantity: 1 },
        ],
        note: "keep this out",
      })
    );

    const expected = {
      schemaVersion: "order_operation_status@1",
      operationRef: { toolCallId: "call-1", operationId: waiting.descriptor.approvalId },
      kind: "refund_request",
      orderRef: { orderId: "ORD-1002" },
      state: "awaiting_approval",
      stateVersion: 2,
      approvalExpiresAt: waiting.descriptor.expiresAt,
    };
    expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId })).toEqual(expected);
    expect(await statusOf(h, tenantId, { orderId: "ORD-1002" })).toEqual(expected);
    expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId, orderId: "ORD-1001" })).toBeNull();
    const summary = await pool.query("SELECT * FROM order_operation_requests WHERE approval_id = $1", [waiting.descriptor.approvalId]);
    expect(summary.rows[0]).toMatchObject({
      tenant_id: tenantId,
      scope_id: tenantId,
      principal_id: SHOPPER_A,
      tool_call_id: "call-1",
      kind: "refund_request",
      order_id: "ORD-1002",
      line_item_ids: ["LI-1002-1", "LI-1002-2"],
    });
    expect(JSON.stringify(summary.rows[0])).not.toContain("keep this out");
  });

  it("reports an overdue approval as expired without writing it, and a late approval still expires", async () => {
    vi.stubEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", "1000");
    try {
      const { tenantId, provider, h } = await setup("status-overdue");
      const waiting = await h.request("status-overdue", refund("call-1"));
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const approval = () =>
        pool.query("SELECT status, consumed_at, withdrawn_at FROM authorization_confirmations WHERE approval_id = $1", [
          waiting.descriptor.approvalId,
        ]);
      const before = (await approval()).rows[0];

      expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId })).toMatchObject({
        state: "approval_expired",
        stateVersion: 6,
      });
      expect(before).toEqual({ status: "pending", consumed_at: null, withdrawn_at: null });
      expect((await approval()).rows[0]).toEqual(before);

      const late = await waiting.approve();

      expect(late.operations["call-1"]?.state).toBe("approval_expired");
      expect(provider.submissions).toBe(0);
      expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId })).toMatchObject({ state: "approval_expired" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tells a denied approval from a withdrawn one", async () => {
    const { tenantId, h } = await setup("status-decided");
    const denied = await h.request("status-denied", refund("call-1"));
    await denied.deny();
    const withdrawn = await h.request("status-withdrawn", refund("call-2", { orderId: "ORD-1002" }));
    await expect(
      h.composition.confirmationStore.withdraw({ descriptor: withdrawn.descriptor, executionContext: withdrawn.context })
    ).resolves.toMatchObject({ ok: true, status: "withdrawn" });

    expect(await statusOf(h, tenantId, { operationId: denied.descriptor.approvalId })).toMatchObject({ state: "approval_denied" });
    expect(await statusOf(h, tenantId, { operationId: withdrawn.descriptor.approvalId })).toMatchObject({
      state: "cancelled_before_effect",
      reasonCode: "CONFIRMATION_CANCELLED",
    });
  });

  it("links a confirmed change and its duplicate to the business effect and the external operation", async () => {
    const { tenantId, h } = await setup("status-confirmed");
    const first = await h.request("status-confirmed", refund("call-1"));
    await first.approve();
    const [effect] = await committedEffects(tenantId);

    expect(await statusOf(h, tenantId, { operationId: first.descriptor.approvalId })).toEqual({
      schemaVersion: "order_operation_status@1",
      operationRef: { toolCallId: "call-1", operationId: first.descriptor.approvalId },
      kind: "refund_request",
      orderRef: { orderId: "ORD-1001" },
      state: "confirmed",
      stateVersion: 6,
      businessEffectId: effect!.business_effect_id,
      externalOperationId: `ext-${tenantId}-1`,
    });

    const again = await h.request("status-again", refund("call-2"));
    await again.approve();

    // The held-off submission carries its own decision, so its approval still finds it.
    expect(await statusOf(h, tenantId, { operationId: again.descriptor.approvalId })).toMatchObject({
      state: "deduplicated",
      businessEffectId: effect!.business_effect_id,
      externalOperationId: `ext-${tenantId}-1`,
      dedup: { reason: "committed_result_reused", of: first.descriptor.approvalId },
    });
    expect(await statusOf(h, tenantId, { orderId: "ORD-1001" })).toMatchObject({
      operationRef: { toolCallId: "call-2", operationId: again.descriptor.approvalId },
    });
  });

  it("answers through the status tool in a new thread without any earlier conversation", async () => {
    const { h } = await setup("status-tool");
    const first = await h.request("status-tool", refund("call-1"));
    await first.approve();

    const reply = await h.lookup("status-tool-lookup", { operationId: first.descriptor.approvalId });

    expect(reply).toContain("ORD-1001");
    expect(reply).toContain("已完成");
  });

  it("reports an unknown outcome with its reconciliation task", async () => {
    const { tenantId, h } = await setup("status-unknown", {
      faults: { afterDispatch: { kind: "response_lost", committed: true }, lookupIndeterminate: true },
    });
    const waiting = await h.request("status-unknown", refund("call-1"));
    await waiting.approve();
    const task = await pool.query("SELECT reconciliation_task_id FROM reconciliation_tasks WHERE tenant_id = $1", [tenantId]);

    expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId })).toMatchObject({
      state: "outcome_unknown",
      stateVersion: 5,
      reconciliationTaskId: task.rows[0]?.reconciliation_task_id,
    });
  });

  it("reports the committed effect of the ledger even while a persistence task is still open", async () => {
    const { tenantId, h } = await setup("status-persist-lost", {}, undefined, failingCommit("after_write_once"));
    const waiting = await h.request("status-persist-lost", refund("call-1"));
    const state = await waiting.approve();

    expect(state.operations["call-1"]?.state).toBe("outcome_unknown");
    expect(await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId })).toMatchObject({
      state: "confirmed",
      externalOperationId: `ext-${tenantId}-1`,
    });
  });

  it("reports a released not-committed change as failed", async () => {
    const { tenantId, used, h } = await setup("status-failed", {}, (inner) => new SwitchableProvider(inner));
    (used as SwitchableProvider).unavailable = true;
    const waiting = await h.request("status-failed", refund("call-1"));
    await waiting.approve();

    const status = await statusOf(h, tenantId, { operationId: waiting.descriptor.approvalId });

    expect(status).toMatchObject({ state: "failed", stateVersion: 6 });
    expect(status?.reasonCode).toBeUndefined();
  });

  it("answers another shopper, tenant or scope as not found, and a summary without an approval too", async () => {
    const { tenantId, h } = await setup("status-foreign");
    const waiting = await h.request("status-foreign", refund("call-1"));
    const operationId = waiting.descriptor.approvalId;

    expect(await statusOf(h, tenantId, { operationId }, SHOPPER_B)).toBeNull();
    expect(await statusOf(h, tenantId, { orderId: "ORD-1001" }, SHOPPER_B)).toBeNull();
    expect(await h.statusReader.read({ tenantId: `${tenantId}-other`, scopeId: tenantId, principalId: SHOPPER_A, operationId })).toBeNull();
    expect(await h.statusReader.read({ tenantId, scopeId: `${tenantId}-other`, principalId: SHOPPER_A, operationId })).toBeNull();
    expect(await h.lookup("status-foreign-lookup", { operationId }, SHOPPER_B)).toContain("查無此操作");

    await new PgOrderOperationRequestStore(db).record({
      approvalId: `orphan-${tenantId}`,
      tenantId,
      scopeId: tenantId,
      principalId: SHOPPER_A,
      toolCallId: "call-orphan",
      kind: "cancel",
      orderId: "ORD-1003",
    });
    expect(await statusOf(h, tenantId, { operationId: `orphan-${tenantId}` })).toBeNull();
    expect(await statusOf(h, tenantId, { orderId: "ORD-1003" })).toBeNull();
  });

  it("names the submission holding a reclaimed effect as the original, not the released attempt", async () => {
    const gate = commitGate();
    const { tenantId, used, h, anotherInstance } = await setup(
      "status-reclaim",
      { beforeCommit: gate.beforeCommit },
      (inner) => new SwitchableProvider(inner)
    );
    const provider = used as SwitchableProvider;
    provider.unavailable = true;
    const released = await h.request("status-reclaim-a", refund("call-1"));
    await released.approve();
    provider.unavailable = false;
    const holder = await h.request("status-reclaim-b", refund("call-2"));
    const duplicate = await anotherInstance().request("status-reclaim-c", refund("call-3"));

    const holderRun = holder.approve();
    await gate.inCommit;
    const held = await duplicate.approve();

    expect(held.operations["call-3"]).toMatchObject({
      state: "deduplicated",
      dedup: { reason: "in_flight_duplicate", of: holder.descriptor.approvalId },
    });
    expect(await statusOf(h, tenantId, { operationId: duplicate.descriptor.approvalId })).toMatchObject({
      state: "deduplicated",
      dedup: { reason: "in_flight_duplicate", of: holder.descriptor.approvalId },
    });

    gate.release();
    expect((await holderRun).operations["call-2"]?.state).toBe("confirmed");
    expect(provider.inner.submissions).toBe(1);
    expect(await statusOf(h, tenantId, { operationId: duplicate.descriptor.approvalId })).toMatchObject({
      dedup: { reason: "in_flight_duplicate", of: holder.descriptor.approvalId },
    });
  });
});
