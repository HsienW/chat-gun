import { tool } from "@langchain/core/tools";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  applyToolGovernance,
  getGovernedToolExecutor,
} from "../../platform/tool-governance.js";
import type {
  AuthorizationConfirmationStore,
  AuthorizationConfirmationWithdrawalStore,
} from "./confirmation.js";
import { createConfirmationRequiredDescriptor } from "./confirmation.js";
import { ToolRiskRegistry } from "./tool-risk.js";
import type { ExecutionProfileEnforcerPort } from "../tool-dispatch/execution-profile.js";
import type { InterruptManifestRepository } from "../recovery/interrupt-manifest-repository.js";
import {
  createToolAuthorizationGraphNodes,
  routeAfterAuthorizationConfirmation,
  routeAfterAuthorizationGate,
  routeAfterPhysicalDispatch,
  resolveConfirmationOutcome,
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
  it("uses the shared enforcement primitive in physicalDispatch", async () => {
    const invoked = vi.fn(async () => "ok");
    const source = tool(invoked, {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
    });
    const enforcer: ExecutionProfileEnforcerPort = {
      enforce: vi.fn(async ({ config }) => ({
        type: "allowed" as const,
        config,
        evidence: {
          executionProfileVersion: "1.0",
          effectiveCapabilities: {
            executionMode: "trusted_in_process" as const,
          },
          secretRefsUsed: [],
          egressDecision: null,
        },
      })),
    };
    const [governed] = applyToolGovernance(
      [source],
      undefined,
      { executionProfileEnforcer: enforcer }
    );
    const nodes = createToolAuthorizationGraphNodes({
      tools: [governed],
      confirmationStore: {
        upsertPending: vi.fn(async () => undefined),
        consume: vi.fn(),
      },
      interruptManifestRepository: {
        create: vi.fn(),
        findByInterruptId: vi.fn(),
        consume: vi.fn(),
        transitionStatus: vi.fn(),
      },
      executionManifest: {
        manifestVersion: "1.0.0",
        graphId: "mcp_agent",
        graphConfigHash: "a".repeat(64),
        schemaVersions: {
          runtimeEventEnvelope: "1.0.0",
          toolDescriptor: "1.0",
          authorizationPolicy: "1.0",
          normalizedInput: "1.0",
        },
      },
    });

    await nodes.physicalDispatch(
      {
        messages: [],
        toolQueue: [],
        activeToolCall: {
          toolName: "read_file",
          toolCallId: "call-1",
          input: { path: "a.txt" },
        },
      },
      { configurable: { execution_context: executionContext } }
    );

    expect(enforcer.enforce).toHaveBeenCalledOnce();
    expect(invoked).toHaveBeenCalledOnce();
  });
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
    let persistedManifest: Awaited<
      ReturnType<InterruptManifestRepository["create"]>
    > | null = null;
    const createManifest = vi.fn<InterruptManifestRepository["create"]>(
      async (manifest) => {
        persistedManifest = manifest;
        return manifest;
      }
    );
    const findManifest = vi.fn<InterruptManifestRepository["findByInterruptId"]>(
      async () => persistedManifest
    );
    const consumeManifest = vi.fn<InterruptManifestRepository["consume"]>(
      async () =>
        persistedManifest
          ? { ...persistedManifest, status: "resumed" as const }
          : null
    );
    const transitionStatus = vi.fn<InterruptManifestRepository["transitionStatus"]>(
      async () => null
    );
    const nodes = createToolAuthorizationGraphNodes({
      tools: [governed],
      confirmationStore: { upsertPending, consume },
      interruptManifestRepository: {
        create: createManifest,
        findByInterruptId: findManifest,
        consume: consumeManifest,
        transitionStatus,
      },
      executionManifest: {
        manifestVersion: "1.0.0",
        graphId: "mcp_agent",
        graphConfigHash: "a".repeat(64),
        schemaVersions: {
          runtimeEventEnvelope: "1.0.0",
          toolDescriptor: "1.0",
          authorizationPolicy: "1.0",
          normalizedInput: "1.0",
        },
      },
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
    const governedExecutor = getGovernedToolExecutor(governed);
    if (!governedExecutor) throw new Error("Expected a governed executor");
    const dispatchSpy = vi.spyOn(governedExecutor, "executeAuthorizedTyped");

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
    const payload = interruptedWithPayload.__interrupt__[0].value;
    expect(createManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "confirmation",
        status: "waiting",
        decisionRef: expect.objectContaining({
          decisionId: payload.decisionId,
          approvalId: payload.approvalId,
        }),
      })
    );
    expect(invoked).not.toHaveBeenCalled();

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
    expect(consumeManifest).not.toHaveBeenCalled();
    expect(transitionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: "waiting",
        nextStatus: "resumed",
      })
    );
    expect(invoked).toHaveBeenCalledOnce();
    // The consumed approval's decision travels to dispatch from server state.
    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy.mock.calls[0]?.[2]).toEqual({
      decisionId: payload.decisionId,
    });

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

describe("authorization decision hand-off to dispatch", () => {
  const executionManifest = {
    manifestVersion: "1.0.0" as const,
    graphId: "mcp_agent",
    graphConfigHash: "a".repeat(64),
    schemaVersions: {
      runtimeEventEnvelope: "1.0.0",
      toolDescriptor: "1.0",
      authorizationPolicy: "1.0",
      normalizedInput: "1.0",
    },
  };

  function governedWriteTool(decisionId: string) {
    const source = tool(async () => "ok", {
      name: "write_file",
      description: "writes a file",
      schema: z.object({ path: z.string() }),
    });
    const [governed] = applyToolGovernance([source], {
      riskRegistry: new ToolRiskRegistry([{
        toolName: "write_file",
        riskTier: "write",
        actions: ["tool:write"],
        requireConfirmation: false,
        resourceRefResolver: (_input, scope) => ({
          resourceType: "mcp_tool",
          resourceId: "filesystem:write_file",
          tenantId: scope.tenantId,
        }),
      }], { unregisteredToolDefault: "deny" }),
      authorizationEngine: {
        authorize: vi.fn(async () => ({
          decisionId,
          effect: "allow" as const,
          reasonCode: "POLICY_ALLOWED" as const,
          createdAt: "2026-09-21T00:00:00.000Z",
        })),
      },
      decisionStore: { record: vi.fn(async () => undefined) },
      policyVersion: "runtime-authorization-v1",
      resolveExecutionContext: () => executionContext,
    });
    const executor = getGovernedToolExecutor(governed);
    if (!executor) throw new Error("Expected a governed executor");
    return { governed, executor };
  }

  function nodesFor(governed: Parameters<typeof createToolAuthorizationGraphNodes>[0]["tools"][number]) {
    return createToolAuthorizationGraphNodes({
      tools: [governed],
      confirmationStore: { upsertPending: vi.fn(), consume: vi.fn() },
      interruptManifestRepository: {
        create: vi.fn(),
        findByInterruptId: vi.fn(),
        consume: vi.fn(),
        transitionStatus: vi.fn(),
      },
      executionManifest,
    });
  }

  it("carries the gate's allow decision to dispatch and ignores a value already on the call", async () => {
    const { governed, executor } = governedWriteTool("decision-allow");
    const dispatchSpy = vi.spyOn(executor, "executeAuthorizedTyped");
    const nodes = nodesFor(governed);
    const config = { configurable: { execution_context: executionContext } };

    const gated = await nodes.authorizationGate({
      messages: [],
      toolQueue: [{
        toolName: "write_file",
        toolCallId: "call-1",
        input: { path: "a.txt" },
        authorizationDecisionId: "forged-decision",
      }],
    }, config);
    expect(gated.messages).toBeUndefined();
    expect(gated.activeToolCall?.authorizationDecisionId).toBe("decision-allow");

    await nodes.physicalDispatch(
      { messages: [], toolQueue: [], activeToolCall: gated.activeToolCall },
      config
    );
    expect(dispatchSpy.mock.calls[0]?.[2]).toEqual({ decisionId: "decision-allow" });
  });

  it("passes no decision when the active call has none", async () => {
    const { governed, executor } = governedWriteTool("decision-unused");
    const dispatchSpy = vi.spyOn(executor, "executeAuthorizedTyped");
    const nodes = nodesFor(governed);

    await nodes.physicalDispatch(
      {
        messages: [],
        toolQueue: [],
        activeToolCall: { toolName: "write_file", toolCallId: "call-1", input: { path: "a.txt" } },
      },
      { configurable: { execution_context: executionContext } }
    );

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("opt-in confirmation request recorder", () => {
  const executionManifest = {
    manifestVersion: "1.0.0" as const,
    graphId: "shopping_assistant",
    graphConfigHash: "b".repeat(64),
    schemaVersions: {
      runtimeEventEnvelope: "1.0.0",
      toolDescriptor: "1.0",
      authorizationPolicy: "1.0",
      normalizedInput: "1.0",
    },
  };

  function governedConfirmationTool() {
    const source = tool(async () => "ok", {
      name: "write_file",
      description: "writes a file",
      schema: z.object({ path: z.string() }),
    });
    const [governed] = applyToolGovernance([source], {
      riskRegistry: new ToolRiskRegistry([{
        toolName: "write_file",
        riskTier: "sensitive",
        actions: ["tool:write"],
        requireConfirmation: true,
        resourceRefResolver: (_input, scope) => ({
          resourceType: "tool",
          resourceId: "write_file",
          tenantId: scope.tenantId,
        }),
      }], { unregisteredToolDefault: "deny" }),
      authorizationEngine: {
        authorize: vi.fn(async () => ({
          decisionId: "decision-confirm",
          effect: "require_confirmation" as const,
          reasonCode: "REQUIRES_CONFIRMATION" as const,
          createdAt: "2026-09-21T00:00:00.000Z",
        })),
      },
      decisionStore: { record: vi.fn(async () => undefined) },
      policyVersion: "runtime-authorization-v1",
      resolveExecutionContext: () => executionContext,
      onRequireConfirmation: (decision, request, context) =>
        createConfirmationRequiredDescriptor({
          decisionId: decision.decisionId,
          executionContext: context!,
          action: request.action,
          toolName: "write_file",
          resource: request.resource,
          policyVersion: "runtime-authorization-v1",
          timeoutMs: 60_000,
        }),
    });
    return governed;
  }

  function nodesWith(
    recorder?: Parameters<typeof createToolAuthorizationGraphNodes>[0]["confirmationRequestRecorder"]
  ) {
    const order: string[] = [];
    const upsertPending = vi.fn(async () => {
      order.push("approval");
    });
    const create = vi.fn(async () => {
      order.push("manifest");
      return {} as never;
    });
    const nodes = createToolAuthorizationGraphNodes({
      tools: [governedConfirmationTool()],
      confirmationStore: { upsertPending, consume: vi.fn() },
      interruptManifestRepository: {
        create,
        findByInterruptId: vi.fn(),
        consume: vi.fn(),
        transitionStatus: vi.fn(),
      } as unknown as InterruptManifestRepository,
      executionManifest,
      ...(recorder ? { confirmationRequestRecorder: recorder } : {}),
    });
    return { nodes, order, upsertPending, create };
  }

  const state = () => ({
    messages: [],
    toolQueue: [{ toolName: "write_file", toolCallId: "call-1", input: { path: "a.txt" } }],
  });
  const config = { configurable: { execution_context: executionContext } };

  it("creates the approval exactly as before when the option is disabled", async () => {
    const { nodes, order } = nodesWith();

    const gated = await nodes.authorizationGate(state(), config);

    expect(order).toEqual(["approval", "manifest"]);
    expect(gated.pendingAuthorization?.decisionId).toBe("decision-confirm");
  });

  it("records the request before the approval and its interrupt", async () => {
    const records: unknown[] = [];
    const { nodes, order } = nodesWith({
      unavailableErrorCode: "ORDER_DISPATCH_NOT_READY",
      record: async (input) => {
        order.push("request");
        records.push({
          approvalId: input.descriptor.approvalId,
          toolCallId: input.call.toolCallId,
          principalId: input.executionContext.principal.principalId,
        });
      },
    });

    const gated = await nodes.authorizationGate(state(), config);

    expect(order).toEqual(["request", "approval", "manifest"]);
    expect(records).toEqual([
      { approvalId: gated.pendingAuthorization?.approvalId, toolCallId: "call-1", principalId: "principal-1" },
    ]);
  });

  it("creates no approval or interrupt and ends the call when the request cannot be recorded", async () => {
    const { nodes, upsertPending, create } = nodesWith({
      unavailableErrorCode: "ORDER_DISPATCH_NOT_READY",
      record: async () => {
        throw new Error("store down");
      },
    });

    const gated = await nodes.authorizationGate(state(), config);

    expect(upsertPending).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(gated.pendingAuthorization).toBeNull();
    expect(gated.activeToolCall).toBeNull();
    expect(
      (gated.messages as { tool_call_id: string; content: unknown }[]).map((message) => [
        message.tool_call_id,
        JSON.parse(String(message.content)),
      ])
    ).toEqual([["call-1", { errorCode: "ORDER_DISPATCH_NOT_READY" }]]);
    expect(routeAfterAuthorizationGate({ ...state(), ...gated, toolQueue: [] })).toBe("model");
  });
});

describe("opt-in confirmation outcome", () => {
  function buildConfirmationGraph(input: {
    consumeResult: Awaited<ReturnType<AuthorizationConfirmationStore["consume"]>>;
    findStatus?: AuthorizationConfirmationWithdrawalStore["findStatus"];
    enableOutcome: boolean;
  }) {
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
    let persistedManifest: Awaited<
      ReturnType<InterruptManifestRepository["create"]>
    > | null = null;
    const findStatus =
      input.findStatus ??
      vi.fn<AuthorizationConfirmationWithdrawalStore["findStatus"]>(async () => null);
    const nodes = createToolAuthorizationGraphNodes({
      tools: [governed],
      confirmationStore: {
        upsertPending: vi.fn(async () => undefined),
        consume: vi.fn(async () => input.consumeResult),
      },
      interruptManifestRepository: {
        create: vi.fn<InterruptManifestRepository["create"]>(async (manifest) => {
          persistedManifest = manifest;
          return manifest;
        }),
        findByInterruptId: vi.fn<InterruptManifestRepository["findByInterruptId"]>(
          async () => persistedManifest
        ),
        consume: vi.fn<InterruptManifestRepository["consume"]>(async () => null),
        transitionStatus: vi.fn<InterruptManifestRepository["transitionStatus"]>(
          async () => null
        ),
      },
      executionManifest: {
        manifestVersion: "1.0.0",
        graphId: "shopping_assistant",
        graphConfigHash: "b".repeat(64),
        schemaVersions: {
          runtimeEventEnvelope: "1.0.0",
          toolDescriptor: "1.0",
          authorizationPolicy: "1.0",
          normalizedInput: "1.0",
        },
      },
      ...(input.enableOutcome
        ? { confirmationOutcome: { statusReader: { findStatus } } }
        : {}),
    });
    const baseChannels = {
      messages: Annotation<unknown[]>({ reducer: (left, right) => [...left, ...right], default: () => [] }),
      toolQueue: Annotation<AuthorizationGraphState["toolQueue"]>({ reducer: (_left, right) => right, default: () => [] }),
      activeToolCall: Annotation<AuthorizationGraphState["activeToolCall"]>({ reducer: (_left, right) => right, default: () => undefined }),
      pendingAuthorization: Annotation<AuthorizationGraphState["pendingAuthorization"]>({ reducer: (_left, right) => right, default: () => undefined }),
    };
    const GraphState = Annotation.Root({
      ...baseChannels,
      confirmationOutcome: Annotation<AuthorizationGraphState["confirmationOutcome"]>({
        reducer: (_left, right) => right,
        default: () => null,
      }),
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
    return { graph, invoked, findStatus };
  }

  async function runToDecision(
    graph: ReturnType<typeof buildConfirmationGraph>["graph"],
    threadId: string,
    decision: "approve" | "deny"
  ) {
    const config = {
      configurable: { thread_id: threadId, execution_context: executionContext },
    };
    const interrupted = (await graph.invoke({
      toolQueue: [{ toolName: "write_file", toolCallId: "call-1", input: { path: "a.txt" } }],
    }, config)) as unknown as {
      __interrupt__: Array<{ value: { approvalId: string; decisionId: string } }>;
    };
    const payload = interrupted.__interrupt__[0].value;
    const resumed = await graph.invoke(new Command({ resume: {
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: payload.approvalId,
      decisionId: payload.decisionId,
      decision,
    } }), config);
    return resumed as unknown as {
      messages: Array<{ content: unknown }>;
      confirmationOutcome?: unknown;
    };
  }

  it("keeps the tool message unchanged when the option is disabled", async () => {
    const { graph, invoked } = buildConfirmationGraph({
      consumeResult: { ok: true, status: "denied" },
      enableOutcome: false,
    });
    const result = await runToDecision(graph, "thread-disabled", "deny");

    expect(result.messages.at(-1)?.content).toBe('{"errorCode":"CONFIRMATION_CANCELLED"}');
    expect(result.confirmationOutcome).toBeNull();
    expect(invoked).not.toHaveBeenCalled();
  });

  it("adds a machine-readable denied outcome when the option is enabled", async () => {
    const { graph, invoked } = buildConfirmationGraph({
      consumeResult: { ok: true, status: "denied" },
      enableOutcome: true,
    });
    const result = await runToDecision(graph, "thread-denied", "deny");

    expect(JSON.parse(String(result.messages.at(-1)?.content))).toEqual({
      errorCode: "CONFIRMATION_CANCELLED",
      confirmationOutcome: "denied",
    });
    expect(result.confirmationOutcome).toEqual({ toolCallId: "call-1", outcome: "denied" });
    expect(invoked).not.toHaveBeenCalled();
  });

  it("maps an approve resume on a withdrawn confirmation to withdrawn without dispatch", async () => {
    const findStatus = vi.fn<AuthorizationConfirmationWithdrawalStore["findStatus"]>(
      async () => ({
        status: "denied",
        withdrawn: true,
        expiresAt: "2026-09-21T00:01:00.000Z",
      })
    );
    const { graph, invoked } = buildConfirmationGraph({
      consumeResult: { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" },
      findStatus,
      enableOutcome: true,
    });
    const result = await runToDecision(graph, "thread-withdrawn", "approve");

    expect(JSON.parse(String(result.messages.at(-1)?.content))).toEqual({
      errorCode: "CONFIRMATION_REPLAYED_OR_EXPIRED",
      confirmationOutcome: "withdrawn",
    });
    expect(findStatus).toHaveBeenCalledOnce();
    expect(invoked).not.toHaveBeenCalled();
  });
});

describe("resolveConfirmationOutcome", () => {
  const descriptor = createConfirmationRequiredDescriptor({
    decisionId: "decision-1",
    executionContext,
    action: "tool:write",
    toolName: "write_file",
    resource: {
      resourceType: "mcp_tool",
      resourceId: "filesystem:write_file",
      tenantId: "tenant-1",
    },
    policyVersion: "runtime-authorization-v1",
    timeoutMs: 60_000,
  });
  const snapshot = (
    status: "pending" | "approved" | "denied" | "expired",
    withdrawn = false
  ) => ({ status, withdrawn, expiresAt: "2026-09-21T00:01:00.000Z" });

  it.each([
    ["a timeout", { ok: false, reasonCode: "CONFIRMATION_TIMEOUT" }, null, "expired"],
    ["a binding mismatch", { ok: false, reasonCode: "CONFIRMATION_BINDING_MISMATCH" }, null, undefined],
    ["a replay of an expired record", { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" }, snapshot("expired"), "expired"],
    ["a replay of a plain denial", { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" }, snapshot("denied"), "denied"],
    ["a replay of a withdrawal", { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" }, snapshot("denied", true), "withdrawn"],
    ["a replay of an approved record", { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" }, snapshot("approved"), undefined],
  ] as const)("maps %s", async (_label, consumed, current, expected) => {
    const findStatus = vi.fn<AuthorizationConfirmationWithdrawalStore["findStatus"]>(
      async () => current
    );
    await expect(
      resolveConfirmationOutcome(consumed, descriptor, { findStatus })
    ).resolves.toBe(expected);
  });

  it("does not guess when the status lookup fails", async () => {
    const findStatus = vi.fn<AuthorizationConfirmationWithdrawalStore["findStatus"]>(
      async () => {
        throw new Error("store unavailable");
      }
    );
    await expect(resolveConfirmationOutcome(
      { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" },
      descriptor,
      { findStatus }
    )).resolves.toBeUndefined();
  });
});
