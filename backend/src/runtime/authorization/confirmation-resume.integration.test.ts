import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createShoppingAssistantGraph } from "../../agents/shopping-assistant/graph.js";
import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import { applyToolGovernance } from "../../platform/tool-governance.js";
import { PgAuditLogger } from "../audit/pg-audit-logger.js";
import { readExecutionContext } from "../execution-context/read-execution-context.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { createConfirmationInterruptId } from "../recovery/confirmation-manifest.js";
import { createExecutionManifestRef } from "../recovery/execution-manifest.js";
import { PgInterruptManifestRepository } from "../recovery/interrupt-manifest-repository.js";
import { createToolAuthorizationGraphNodes, type AuthorizationGraphState } from "./confirmation-graph.js";
import { createConfirmationRequiredDescriptor, PgAuthorizationConfirmationStore } from "./confirmation.js";
import { ToolRiskRegistry } from "./tool-risk.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schema = `x43_tr_${randomUUID().replaceAll("-", "")}`;

describePostgres("TR durable confirmation resume", () => {
  let admin: Pool;
  let db: Pool;
  let saver: PostgresSaver;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMigrations("up", db);
    saver = PostgresSaver.fromConnString(databaseUrl!, { schema });
    await saver.setup();
  });

  afterAll(async () => {
    await saver?.end();
    await db?.end();
    if (admin) {
      // The identifier is generated locally above, never supplied by a caller.
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function harness(graphId: "shopping_assistant" | "mcp_agent") {
    const id = randomUUID();
    const context = {
      requestId: `request-${id}`, threadId: `thread-${id}`, runId: `waiting-${id}`, taskId: `task-${id}`,
      stepId: `step-${id}`, attempt: 1,
      principal: { principalId: "shopper", principalType: "user" as const, tenantId: "tr-tenant",
        roles: [], scopes: [], authSource: "trusted_gateway" as const, authenticatedAt: new Date().toISOString() },
      scope: { scopeId: "tr-tenant", scopeType: "tenant" as const, tenantId: "tr-tenant" },
    };
    const decisionId = `decision-${id}`;
    const toolName = graphId === "mcp_agent" ? "write_file" : "order_refund_request";
    const args = graphId === "mcp_agent" ? { path: "fixture.txt" } : { orderId: "ORD-1001", reasonCode: "damaged" };
    await db.query("INSERT INTO agent_tasks (task_id, task_type, status, metadata) VALUES ($1, 'interaction_runtime', 'running', '{}')", [context.taskId]);
    await db.query("INSERT INTO task_steps (step_id, task_id, step_name, status) VALUES ($1, $2, $3, 'running')", [context.stepId, context.taskId, toolName]);
    await db.query(`INSERT INTO permission_decisions (decision_id, principal_id, principal_type, tenant_id, scope_id, action, resource_type, resource_id, effect, reason_code, created_at)
      VALUES ($1, 'shopper', 'user', 'tr-tenant', 'tr-tenant', 'tool:write', 'tool', $2, 'require_confirmation', 'REQUIRES_CONFIRMATION', NOW())`, [decisionId, toolName]);
    const logger = new PgAuditLogger(db);
    const record = vi.fn((event: string, payload: Record<string, unknown>) => logger.record(event, payload));
    const store = new PgAuthorizationConfirmationStore(db, { record });
    const manifests = new PgInterruptManifestRepository(db);
    const consume = vi.spyOn(store, "consume");
    const invoked = vi.fn(async () => "fixture operation completed");
    const source = tool(invoked, { name: toolName, description: "Synthetic TR fixture", schema: z.object({}).passthrough() });
    const [governed] = applyToolGovernance([source], {
      riskRegistry: new ToolRiskRegistry([{ toolName, riskTier: "sensitive", actions: ["tool:write"], requireConfirmation: true,
        resourceRefResolver: (_input, scope) => ({ resourceType: "tool", resourceId: toolName, tenantId: scope.tenantId }) }], { unregisteredToolDefault: "deny" }),
      authorizationEngine: { authorize: async () => ({ decisionId, effect: "require_confirmation", reasonCode: "REQUIRES_CONFIRMATION", createdAt: new Date().toISOString() }) },
      decisionStore: { record: async () => undefined }, policyVersion: "tr-v1",
      resolveExecutionContext: (config) => readExecutionContext(undefined, config, "production"),
      onRequireConfirmation: (_decision, request, executionContext) => createConfirmationRequiredDescriptor({
        decisionId, executionContext: executionContext!, action: request.action, toolName, resource: request.resource,
        policyVersion: "tr-v1", timeoutMs: 900_000,
      }),
    });
    const initial = { configurable: { thread_id: context.threadId, execution_context: context } };
    const resumed = { configurable: { ...initial.configurable, execution_context: { ...context, runId: `resume-${id}` },
      "x-active-run-id": "untrusted-hint" } };
    const call = { toolName, toolCallId: "call-1", input: args };
    const nodes = createToolAuthorizationGraphNodes({ tools: [governed], confirmationStore: store, confirmationAudit: { record },
      interruptManifestRepository: manifests, executionManifest: createExecutionManifestRef({ graphId, graphConfig: { fixture: "TR" } }) });
    const state = Annotation.Root({
      messages: Annotation<unknown[]>({ reducer: (left, right) => [...left, ...right], default: () => [] }),
      toolQueue: Annotation<AuthorizationGraphState["toolQueue"]>({ reducer: (_left, right) => right, default: () => [] }),
      activeToolCall: Annotation<AuthorizationGraphState["activeToolCall"]>,
      pendingAuthorization: Annotation<AuthorizationGraphState["pendingAuthorization"]>,
    });
    // The MCP approval path uses the production shared gate/confirmation/dispatch nodes.
    const mcpGraph = new StateGraph(state).addNode("gate", nodes.authorizationGate)
      .addNode("confirm", nodes.authorizationConfirmation).addNode("dispatch", nodes.physicalDispatch)
      .addEdge(START, "gate").addEdge("gate", "confirm")
      .addConditionalEdges("confirm", (value) => value.activeToolCall ? "dispatch" : END)
      .addEdge("dispatch", END).compile({ checkpointer: saver });
    const orderModel: ChatModelInvoker = { invoke: async () => new AIMessage({ content: "", tool_calls: [{ id: "call-1", name: toolName, args }] }) };
    orderModel.bindTools = () => orderModel;
    const shoppingGraph = createShoppingAssistantGraph({ tools: [governed], confirmationStore: store, interruptManifestRepository: manifests,
      confirmationWithdrawal: store, intentRouter: { promptVersion: "tr-fixture", route: async () => ({ status: "routed", intent: "order_operation", rationaleCode: "requests_order_change", attempts: 1 }) },
      createProductRequestModel: () => orderModel, createOrderRequestModel: () => orderModel,
      policyAnswerSynthesizer: { promptVersion: "tr-fixture", synthesize: vi.fn() }, checkDispatchReadiness: async () => true,
      originalOperationResolver: { resolveApprovalId: async () => null }, operationRequests: { record: async () => undefined }, audit: record,
    }, { checkpointer: saver });
    const graph = graphId === "mcp_agent" ? mcpGraph : shoppingGraph;
    if (graphId === "mcp_agent") await mcpGraph.invoke({ toolQueue: [call] }, initial);
    else await shoppingGraph.invoke({ messages: [new HumanMessage("退款 ORD-1001")] }, initial);
    const waiting = await graph.getState(initial);
    const descriptor = (waiting.values as AuthorizationGraphState).pendingAuthorization!;
    const approval = new Command<unknown, never, never>({ resume: { type: "tool_authorization_confirmation", schemaVersion: "1.0",
      approvalId: descriptor.approvalId, decisionId, decision: "approve" } });
    const invoke = (config: RunnableConfig = resumed) => graphId === "mcp_agent"
      ? mcpGraph.invoke(approval, config) : shoppingGraph.invoke(approval, config);
    return { graph, store, manifests, record, invoked, consume, descriptor, context, initial, resumed, waiting, invoke };
  }

  describe.each(["mcp_agent", "shopping_assistant"] as const)("%s", (graphId) => {
    it.each([false, true])("dispatches once and rejects checkpoint replay (same run: %s)", async (sameRun) => {
      const h = await harness(graphId);
      const config = sameRun ? h.initial : h.resumed;
      await h.invoke(config);
      expect(h.invoked).toHaveBeenCalledOnce();
      expect(h.consume).toHaveBeenCalledOnce();
      expect(h.record).toHaveBeenCalledWith("authorization.confirmation.consumed", {
        decisionId: h.descriptor.decisionId, status: "approved", waitingRunId: h.context.runId,
        resumeRunId: config.configurable.execution_context.runId,
      });
      h.consume.mockClear();
      const replay = await h.invoke({ configurable: { ...h.resumed.configurable, ...h.waiting.config.configurable,
        execution_context: h.resumed.configurable.execution_context } });
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.invoked).toHaveBeenCalledOnce();
      expect(replay.messages).toContainEqual(expect.objectContaining({ content: JSON.stringify({ errorCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" }) }));
      const audit = await db.query("SELECT payload FROM audit_events WHERE action = 'authorization.confirmation.consumed' AND payload->>'decisionId' = $1", [h.descriptor.decisionId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].payload).not.toHaveProperty("approvalId");
      const manifest = await h.manifests.findByInterruptId(createConfirmationInterruptId(h.descriptor));
      expect(manifest).toMatchObject({ status: "resumed", runId: h.context.runId, taskId: h.context.taskId });
    });

    it.each(["thread", "principal", "expired", "withdrawn"] as const)("rejects %s on a new run and audits without dispatch", async (scenario) => {
      const h = await harness(graphId);
      const config = structuredClone(h.resumed);
      if (scenario === "thread") config.configurable.execution_context.threadId = "wrong-thread";
      if (scenario === "principal") config.configurable.execution_context.principal.principalId = "wrong-principal";
      if (scenario === "expired") await db.query("UPDATE authorization_confirmations SET expires_at = NOW() - INTERVAL '1 second' WHERE decision_id = $1", [h.descriptor.decisionId]);
      if (scenario === "withdrawn") await h.store.withdraw({ descriptor: h.descriptor, executionContext: h.resumed.configurable.execution_context });
      const result = await h.invoke(config);
      const reasonCode = scenario === "expired" ? "CONFIRMATION_TIMEOUT" : scenario === "withdrawn" ? "CONFIRMATION_REPLAYED_OR_EXPIRED" : "CONFIRMATION_BINDING_MISMATCH";
      expect(h.invoked).not.toHaveBeenCalled();
      if (scenario === "thread" || scenario === "withdrawn") expect(h.consume).not.toHaveBeenCalled();
      expect(result.messages.filter((message: unknown) => message instanceof ToolMessage).some((message: ToolMessage) => JSON.parse(String(message.content)).errorCode === reasonCode)).toBe(true);
      expect(h.record).toHaveBeenCalledWith("authorization.confirmation.rejected", {
        decisionId: h.descriptor.decisionId, reasonCode, waitingRunId: h.context.runId, resumeRunId: h.resumed.configurable.execution_context.runId,
      });
    });
  });
});
