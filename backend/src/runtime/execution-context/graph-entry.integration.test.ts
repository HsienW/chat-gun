import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createToolDispatchStepId } from "./tool-call-context.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schema = `x43_te_${randomUUID().replaceAll("-", "")}`;

function headers(threadId: string, runId: string, principalId: string, tenantId: string) {
  return {
    configurable: {
      thread_id: threadId, run_id: runId, "x-request-id": `request-${runId}`,
      "x-bff-principal-id": principalId, "x-bff-principal-type": "user",
      "x-bff-tenant-id": tenantId, "x-bff-roles": "member", "x-bff-scopes": "orders:write",
      "x-bff-auth-source": "trusted_gateway", "x-bff-authenticated-at": new Date().toISOString(),
      "x-bff-scope-id": tenantId, "x-bff-scope-type": "tenant",
    },
  };
}

function approve(descriptor: { schemaVersion: string; approvalId: string; decisionId: string }): never {
  return new Command({ resume: {
    type: "tool_authorization_confirmation", schemaVersion: descriptor.schemaVersion,
    approvalId: descriptor.approvalId, decisionId: descriptor.decisionId, decision: "approve",
  } }) as never;
}

/**
 * The real entry, approval stores, ledger and task-step adapter against an
 * isolated schema. No task or step rows are seeded and no context carries a
 * task or step id: the entry and the dispatch must create them (design §6.15,
 * §6.16).
 */
// Loading the production runtime modules takes several seconds on the first case.
describePostgres("TE graph entry task and dispatch step", { timeout: 60_000 }, () => {
  let admin: Pool;
  let db: Pool;
  let saver: PostgresSaver;
  let closePool: () => Promise<void>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const { runMigrations } = await import("../persistence/migration-runner.js");
    await runMigrations("up", db);
    saver = PostgresSaver.fromConnString(databaseUrl!, { schema });
    await saver.setup();
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("OPIK_ENABLED", "false");
    vi.stubEnv("TOOL_AUTHORIZATION_PROFILE", "production");
    // Single instance: the step lock is out of scope here and falls back to NoopStepLock.
    vi.stubEnv("REDIS_URI", "");
    vi.resetModules();
    ({ closePool } = await import("../persistence/connection.js"));
  });

  afterAll(async () => {
    await closePool?.();
    await saver?.end();
    await db?.end();
    if (admin) {
      // The identifier is generated locally above, never supplied by a caller.
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  async function rows(sql: string, values: unknown[]) {
    return (await db.query(sql, values)).rows;
  }

  async function expectEntryTask(taskId: string, initialRunId: string) {
    expect(await rows("SELECT task_type, metadata #>> '{graphEntry,initialRunId}' AS initial_run FROM agent_tasks WHERE task_id = $1", [taskId]))
      .toEqual([{ task_type: "graph_execution", initial_run: initialRunId }]);
    expect(await rows("SELECT step_id FROM interrupt_manifests WHERE task_id = $1", [taskId])).toEqual([{ step_id: null }]);
    expect(await rows("SELECT step_id FROM authorization_confirmations WHERE task_id = $1", [taskId])).toEqual([{ step_id: null }]);
  }

  it("runs a shopping refund through the production runtime with a server task and step", async () => {
    const { loadShoppingAssistantToolRuntime } = await import("../../tools/registry.js");
    const { MockOrderProvider } = await import("../../tools/orders/mock-order-provider.js");
    const { loadSyntheticOrderFixture } = await import("../../tools/orders/synthetic-orders.js");
    const { createShoppingAssistantGraph } = await import("../../agents/shopping-assistant/graph.js");
    const { createShoppingAssistantEntryResolver } = await import("../../agents/shopping-assistant/entry.js");
    const { createDispatchReadinessCheck } = await import("../../agents/shopping-assistant/dispatch-readiness.js");
    const { PgOrderOperationRequestStore } = await import("../../agents/shopping-assistant/operation-requests.js");
    const { instrumentGraphWithExecutionContext } = await import("./instrument-graph.js");
    const { getPool } = await import("../persistence/connection.js");
    const { auditLogger } = await import("../../platform/observability.js");

    const pool = getPool()!;
    const provider = new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() });
    const submitRefund = vi.spyOn(provider, "submitRefund");
    const runtime = await loadShoppingAssistantToolRuntime({ orderProvider: provider, statusReader: { read: async () => null } });
    const args = { orderId: "ORD-1001", reasonCode: "damaged" };
    const orderModel = { invoke: vi.fn(), bindTools: () => ({ invoke: async () => new AIMessage({ content: "", tool_calls: [{ id: "call-1", name: "order_refund_request", args }] }) }) };
    const graph = createShoppingAssistantGraph({
      tools: runtime.tools,
      confirmationStore: runtime.confirmationStore,
      interruptManifestRepository: runtime.interruptManifestRepository,
      intentRouter: { promptVersion: "te-fixture", route: async () => ({ status: "routed" as const, intent: "order_operation" as const, rationaleCode: "requests_order_change" as const, attempts: 1 }) },
      createProductRequestModel: () => { throw new Error("the order branch never binds kb_search"); },
      createOrderRequestModel: () => orderModel as never,
      policyAnswerSynthesizer: { promptVersion: "te-fixture", synthesize: vi.fn() },
      checkDispatchReadiness: createDispatchReadinessCheck(pool),
      confirmationWithdrawal: runtime.confirmationWithdrawal,
      originalOperationResolver: { resolveApprovalId: async () => null },
      operationRequests: new PgOrderOperationRequestStore(pool),
      audit: (eventName, payload, context) => auditLogger.record(eventName, payload, context),
    }, { checkpointer: saver });
    const entry = instrumentGraphWithExecutionContext(graph, createShoppingAssistantEntryResolver(graph));
    const threadId = `thread-${randomUUID()}`;
    // Agent Server run ids are unique; reusing one would reattach to its task.
    const run = randomUUID();
    const shopper = (runId: string) => headers(threadId, `${runId}-${run}`, "synthetic-shopper-a", "synthetic-tenant");

    await entry.invoke({ messages: [new HumanMessage("退款 ORD-1001，商品損壞")] }, shopper("run-1"));
    const waiting = await graph.getState({ configurable: { thread_id: threadId } });
    const values = waiting.values as { executionTaskId: string; pendingAuthorization: Parameters<typeof approve>[0] & { taskId: string } };
    const taskId = values.executionTaskId;
    expect(values.pendingAuthorization.taskId).toBe(taskId);
    await expectEntryTask(taskId, `run-1-${run}`);

    const resumed = await entry.invoke(approve(values.pendingAuthorization), shopper("resume-run"));
    expect(submitRefund).toHaveBeenCalledOnce();
    expect((resumed as { operations: Record<string, { state: string }> }).operations["call-1"]?.state).toBe("confirmed");
    const stepId = createToolDispatchStepId({ taskId, nodeName: "physical_dispatch", toolName: "order_refund_request", toolCallId: "call-1", input: args });
    expect(await rows("SELECT task_id, status FROM task_steps WHERE step_id = $1", [stepId])).toEqual([{ task_id: taskId, status: "succeeded" }]);
    expect(await rows("SELECT count(*)::int AS count FROM agent_tasks WHERE metadata #>> '{graphEntry,threadId}' = $1", [threadId]))
      .toEqual([{ count: 1 }]);

    // Replaying the waiting checkpoint reattaches to the same task and never dispatches again.
    await entry.invoke(approve(values.pendingAuthorization), { configurable: { ...shopper("replay-run").configurable, ...waiting.config.configurable } });
    expect(submitRefund).toHaveBeenCalledOnce();
  });

  describe.each([false, true])("mcp_agent write_file (pipeline: %s)", (pipeline) => {
    it("admits a task, resumes it on a new run and dispatches once", async () => {
      const { createRuntimeToolAuthorizationComposition } = await import("../../tools/authorization/tool-authorization.js");
      const { applyToolGovernance } = await import("../../platform/tool-governance.js");
      const { createRuntimeToolDispatchPipeline } = await import("../tool-dispatch/pipeline.js");
      const { RuntimeToolDescriptorRegistry } = await import("../tool-dispatch/runtime-tool-descriptor.js");
      const { createToolAuthorizationGraphNodes } = await import("../authorization/confirmation-graph.js");
      const { createExecutionManifestRef } = await import("../recovery/execution-manifest.js");
      const { createGraphEntryContextResolver } = await import("./graph-entry.js");
      const { PgGraphTaskAdmission } = await import("./graph-task-admission.js");
      const { instrumentGraphWithExecutionContext } = await import("./instrument-graph.js");
      const { readCanonicalExecutionContext, readExecutionContext } = await import("./read-execution-context.js");

      const composition = createRuntimeToolAuthorizationComposition();
      const written = vi.fn(async ({ path }: { path: string }) => `wrote:${path}`);
      const source = tool(written, { name: "write_file", description: "Synthetic TE fixture", schema: z.object({ path: z.string() }) });
      const registry = new RuntimeToolDescriptorRegistry();
      registry.register({ toolName: "write_file", toolVersion: "1.0" }, {
        toolName: "write_file", toolVersion: "1.0",
        inputSchema: z.object({ path: z.string() }).strict(), outputSchema: z.string(),
        riskTier: "write", isReadOnly: false, isConcurrencySafe: () => false,
        timeoutPolicy: { timeoutMs: 5_000 },
        retryPolicy: { maxAttempts: 1, maxElapsedMs: 5_000, retryableCategories: [], backoffStrategy: "fixed", jitter: false },
        interruptBehavior: "reconcile_first",
        sideEffect: {
          toolName: "write_file", toolVersion: "1.0",
          deriveBusinessEffectKey: (input: unknown) => JSON.stringify(input),
          reconcile: { reconcile: async () => ({ state: "unknown" as const }) },
          resultReferencePolicy: {
            toResultRef: (result: string) => ({ resultHash: `hash:${result}`, payloadRef: result }),
            resolveResultRef: async (payloadRef: string) => payloadRef,
            isReusable: () => false,
          },
        },
      });
      const dispatch = createRuntimeToolDispatchPipeline({ registry });
      const [governed] = applyToolGovernance([source], composition.authorization, pipeline
        ? { createExecutor: (candidate, fallback) => dispatch.createExecutor(candidate.name, fallback) }
        : undefined);
      const nodes = createToolAuthorizationGraphNodes({
        tools: [governed!], confirmationStore: composition.confirmationStore,
        interruptManifestRepository: composition.interruptManifestRepository,
        executionManifest: createExecutionManifestRef({ graphId: "mcp_agent", graphConfig: { fixture: "TE" } }),
      });
      const state = Annotation.Root({
        messages: Annotation<unknown[]>({ reducer: (left, right) => [...left, ...right], default: () => [] }),
        executionTaskId: Annotation<string | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
        toolQueue: Annotation<{ toolName: string; toolCallId: string; input: unknown }[]>({ reducer: (_left, right) => right, default: () => [] }),
        activeToolCall: Annotation<unknown>,
        pendingAuthorization: Annotation<unknown>,
      });
      // Stands in for call_model: the first node records the admitted task.
      const recordTask = (_value: unknown, config: RunnableConfig) => ({ executionTaskId: readCanonicalExecutionContext(config)?.taskId });
      const compiled = new StateGraph(state)
        .addNode("call_model", recordTask)
        .addNode("gate", nodes.authorizationGate as never)
        .addNode("confirm", nodes.authorizationConfirmation as never)
        .addNode("dispatch", nodes.physicalDispatch as never)
        .addEdge(START, "call_model").addEdge("call_model", "gate").addEdge("gate", "confirm")
        .addConditionalEdges("confirm", (value) => value.activeToolCall ? "dispatch" : END)
        .addEdge("dispatch", END)
        .compile({ checkpointer: saver });
      const entry = instrumentGraphWithExecutionContext(compiled, createGraphEntryContextResolver(
        compiled, new PgGraphTaskAdmission(), (input, config) => readExecutionContext(input, config, "production"),
      ));
      const threadId = `thread-${randomUUID()}`;
      const tenant = `te-tenant-${randomUUID()}`;
      const run = randomUUID();
      const caller = (runId: string) => headers(threadId, `${runId}-${run}`, "te-principal", tenant);
      const input = { path: "fixture.txt" };

      await entry.invoke({ toolQueue: [{ toolName: "write_file", toolCallId: "call-1", input }] }, caller("run-1"));
      const values = (await compiled.getState({ configurable: { thread_id: threadId } })).values as {
        executionTaskId: string; pendingAuthorization: Parameters<typeof approve>[0] & { taskId: string };
      };
      expect(values.pendingAuthorization.taskId).toBe(values.executionTaskId);
      await expectEntryTask(values.executionTaskId, `run-1-${run}`);

      await entry.invoke(approve(values.pendingAuthorization), caller("resume-run"));
      expect(written).toHaveBeenCalledOnce();
      const stepId = createToolDispatchStepId({ taskId: values.executionTaskId, nodeName: "physical_dispatch", toolName: "write_file", toolCallId: "call-1", input });
      expect(await rows("SELECT status FROM task_steps WHERE step_id = $1", [stepId]))
        .toEqual(pipeline ? [{ status: "succeeded" }] : []);
    });
  });
});
