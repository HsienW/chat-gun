import { tool } from "@langchain/core/tools";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { applyToolGovernance } from "../../platform/tool-governance.js";
import type { AuthorizationConfirmationStore } from "./confirmation.js";
import { createConfirmationRequiredDescriptor } from "./confirmation.js";
import { ToolRiskRegistry } from "./tool-risk.js";
import {
  createToolAuthorizationGraphNodes,
  routeAfterAuthorizationConfirmation,
  routeAfterAuthorizationGate,
  routeAfterPhysicalDispatch,
  type AuthorizationGraphState,
} from "./confirmation-graph.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: ["operator"],
    scopes: ["tool:approve"],
    authSource: "trusted_gateway" as const,
    authenticatedAt: "2026-09-20T00:00:00.000Z",
  },
  scope: {
    scopeId: "tenant-1",
    scopeType: "tenant" as const,
    tenantId: "tenant-1",
  },
};

describe("tool authorization confirmation graph adapter", () => {
  it("interrupts and resumes on the same thread before one physical dispatch", async () => {
    const invoked = vi.fn(async ({ path }: { path: string }) => `wrote:${path}`);
    const source = tool(invoked, {
      name: "write_file",
      description: "writes a file",
      schema: z.object({ path: z.string() }),
    });
    const decision = {
      decisionId: "decision-1",
      effect: "require_confirmation" as const,
      reasonCode: "REQUIRES_CONFIRMATION" as const,
      createdAt: "2026-09-21T00:00:00.000Z",
    };
    const [governed] = applyToolGovernance([source], {
      riskRegistry: new ToolRiskRegistry([{
        toolName: "write_file",
        riskTier: "sensitive",
        actions: ["tool:write"],
        requireConfirmation: true,
        resourceRefResolver: (_input, scope) => ({
          resourceType: "mcp_tool",
          resourceId: "filesystem:write_file",
          tenantId: scope.tenantId,
        }),
      }], { unregisteredToolDefault: "deny" }),
      authorizationEngine: { authorize: vi.fn(async () => decision) },
      decisionStore: { record: vi.fn(async () => undefined) },
      policyVersion: "runtime-authorization-v1",
      resolveExecutionContext: () => executionContext,
      onRequireConfirmation: (_decision, request) =>
        createConfirmationRequiredDescriptor({
          decisionId: decision.decisionId,
          executionContext,
          action: request.action,
          toolName: "write_file",
          resource: request.resource,
          policyVersion: "runtime-authorization-v1",
          timeoutMs: 60_000,
        }),
    });
    const upsertPending = vi.fn(async () => undefined);
    const consume = vi.fn<AuthorizationConfirmationStore["consume"]>(
      async () => ({ ok: true, status: "approved" })
    );
    const nodes = createToolAuthorizationGraphNodes({
      tools: [governed],
      confirmationStore: { upsertPending, consume },
    });
    const GraphState = Annotation.Root({
      messages: Annotation<unknown[]>({ reducer: (left, right) => [...left, ...right], default: () => [] }),
      toolQueue: Annotation<AuthorizationGraphState["toolQueue"]>({ reducer: (_left, right) => right, default: () => [] }),
      activeToolCall: Annotation<AuthorizationGraphState["activeToolCall"]>({ reducer: (_left, right) => right, default: () => undefined }),
      pendingAuthorization: Annotation<AuthorizationGraphState["pendingAuthorization"]>({ reducer: (_left, right) => right, default: () => undefined }),
    });
    const graph = new StateGraph(GraphState)
      .addNode("gate", nodes.authorizationGate)
      .addNode("confirm", nodes.authorizationConfirmation)
      .addNode("dispatch", nodes.physicalDispatch)
      .addEdge(START, "gate")
      .addConditionalEdges("gate", routeAfterAuthorizationGate, {
        confirmation: "confirm",
        dispatch: "dispatch",
        gate: "gate",
        model: END,
      })
      .addConditionalEdges("confirm", routeAfterAuthorizationConfirmation, {
        dispatch: "dispatch",
        gate: "gate",
        model: END,
      })
      .addConditionalEdges("dispatch", routeAfterPhysicalDispatch, {
        gate: "gate",
        model: END,
      })
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "thread-1", execution_context: executionContext },
    };

    const interrupted = await graph.invoke({
      toolQueue: [{ toolName: "write_file", toolCallId: "call-1", input: { path: "a.txt" } }],
    }, config);
    const interruptedWithPayload = interrupted as typeof interrupted & {
      __interrupt__: Array<{
        value: { approvalId: string; decisionId: string };
      }>;
    };
    expect(interruptedWithPayload.__interrupt__).toHaveLength(1);
    expect(upsertPending).toHaveBeenCalledOnce();
    expect(invoked).not.toHaveBeenCalled();
    const payload = interruptedWithPayload.__interrupt__[0].value;

    const resumed = await graph.invoke(new Command({ resume: {
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: payload.approvalId,
      decisionId: payload.decisionId,
      decision: "approve",
    } }), config);
    expect("__interrupt__" in resumed ? resumed.__interrupt__ : undefined).toBeUndefined();
    expect(upsertPending).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
    expect(invoked).toHaveBeenCalledOnce();

    upsertPending.mockRejectedValueOnce(new Error("confirmation store unavailable"));
    await expect(nodes.authorizationGate({
      messages: [],
      toolQueue: [{
        toolName: "write_file",
        toolCallId: "call-persistence-failure",
        input: { path: "blocked.txt" },
      }],
    }, config)).rejects.toThrow("confirmation store unavailable");
    expect(invoked).toHaveBeenCalledOnce();
  });
});
