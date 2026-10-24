import { afterEach, describe, expect, it, vi } from "vitest";

import { getGovernedToolExecutor } from "../platform/tool-governance.js";
import type { CompensationRegistry } from "../runtime/compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../runtime/compensation/saga-orchestrator.js";
import { NoopStepLock } from "../runtime/lock/step-lock.js";
import type { BusinessEffectLedger } from "../runtime/side-effect/business-effect-ledger.js";
import type { ResultReferenceStore } from "../runtime/side-effect/result-reference-store.js";
import {
  ToolExecutionRunner,
  type ToolExecutionRunResult,
} from "../runtime/side-effect/tool-execution-runner.js";
import { createRuntimeToolAuthorizationComposition } from "./authorization/tool-authorization.js";
import { SHOPPING_ASSISTANT_AGENT_MANIFEST } from "../agents/shopping-assistant/agent-manifest.js";
import { MockOrderProvider } from "./orders/mock-order-provider.js";
import { createOrderToolRiskPolicies, createOrderToolSet, registerOrderExecutionProfiles } from "./orders/order-tools.js";
import { loadSyntheticOrderFixture } from "./orders/synthetic-orders.js";
import { createLocalExecutionProfileRegistry } from "./production-runtime-tool-descriptors.js";
import {
  loadAgentToolRuntime,
  loadShoppingAssistantToolRuntime,
  ShoppingToolRuntimeError,
} from "./registry.js";
import {
  createOrderToolManifest,
  OrderToolRegistrationError,
  registerOrderToolManifest,
} from "./sdk/order-tool-manifest-adapter.js";

const ORDER_TOOLS = ["order_refund_request", "order_cancel", "order_operation_status"];

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "tool-call-1",
  attempt: 1,
  principal: {
    principalId: "synthetic-shopper-a",
    principalType: "user" as const,
    tenantId: "synthetic-tenant",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: "2026-10-24T00:00:00.000Z",
  },
  scope: {
    scopeId: "synthetic-tenant",
    scopeType: "tenant" as const,
    tenantId: "synthetic-tenant",
  },
};
const runnableConfig = { configurable: { execution_context: executionContext } };

async function orderProvider() {
  return new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() });
}

function pipelineDependencies(
  toolExecutionRunner: Pick<ToolExecutionRunner, "execute">
) {
  const compensationRegistry: CompensationRegistry = {
    register: vi.fn(),
    deregister: vi.fn(),
    getActions: vi.fn(() => []),
    hasActions: vi.fn(() => false),
  };
  const sagaOrchestrator: SagaOrchestrator = {
    compensate: vi.fn(async (taskId: string) => ({
      taskId,
      totalActions: 0,
      succeeded: 0,
      failed: 0,
      skippedIrreversible: 0,
      overallStatus: "no_actions_needed" as const,
      failures: [],
      skippedIrreversibleActions: [],
    })),
  };
  return {
    toolExecutionRunner,
    retryBudgetFactory: (stepId: string, policy: { maxAttempts: number; maxElapsedMs: number }) => ({
      stepId,
      maxAttempts: policy.maxAttempts,
      maxElapsedMs: policy.maxElapsedMs,
      startedAt: Date.now(),
      attempts: 0,
    }),
    taskStepAdapter: {
      start: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    },
    compensationRegistry,
    sagaOrchestrator,
    observability: {
      audit: vi.fn(async () => undefined),
      metric: vi.fn(async () => undefined),
    },
    consumedAuthorizationVerifier: { verify: vi.fn(async () => true) },
    stepLock: new NoopStepLock(),
    stepLockTtlMs: 30_000,
  };
}

function runnerReturning(result: ToolExecutionRunResult<unknown>) {
  return { execute: vi.fn(async () => result) as unknown as ToolExecutionRunner["execute"] };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shopping assistant tool runtime", () => {
  it("loads exactly the tools its agent manifest grants and records manifest evidence", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");

    const runtime = await loadShoppingAssistantToolRuntime({
      orderProvider: await orderProvider(),
      statusReader: { read: async () => null },
      dispatchPipelineDependencies: pipelineDependencies(runnerReturning({ type: "failed", errorCode: "UNUSED" })),
    });

    expect(runtime.tools.map((tool) => tool.name).sort()).toEqual(["kb_search", ...ORDER_TOOLS].sort());
    expect(runtime.manifests).toEqual(
      ORDER_TOOLS.map((toolId) => ({
        toolId,
        toolVersion: "1.0.0",
        manifestVersion: "1.0.0",
        sideEffectClass: toolId === "order_operation_status" ? "read-only" : "external_mutation",
        dataClassification: "commerce:internal-synthetic",
      }))
    );
  });

  it("does not hand order tools to any other graph", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    vi.stubEnv("TOOL_DISPATCH_PIPELINE_MCP_ENABLED", "true");

    const runtime = await loadAgentToolRuntime("mcp_agent", { includeMcp: true });

    expect(runtime.tools.length).toBeGreaterThan(0);
    for (const toolName of ORDER_TOOLS) {
      expect(runtime.tools.some((tool) => tool.name === toolName)).toBe(false);
    }
  });

  it("dispatches through the pipeline with the deduplicated outcome while every pipeline flag is off", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const effect = {
      schemaVersion: "order_effect_result@1",
      kind: "refund_request",
      orderId: "ORD-1001",
      effect: "committed",
      externalOperationId: "ext-original",
      providerRecordedAt: "2026-10-24T12:00:00.000Z",
    };
    const runner = runnerReturning({
      type: "succeeded",
      source: "cache",
      result: effect,
      toolExecutionId: "execution-2",
      reusedFrom: { businessEffectId: "effect-1", toolExecutionId: "execution-1" },
    });
    const runtime = await loadShoppingAssistantToolRuntime({
      orderProvider: await orderProvider(),
      statusReader: { read: async () => null },
      dispatchPipelineDependencies: pipelineDependencies(runner),
    });
    const refund = runtime.tools.find((tool) => tool.name === "order_refund_request");
    const executor = refund ? getGovernedToolExecutor(refund) : null;

    const outcome = await executor?.executeAuthorizedTyped?.(
      { orderId: "ORD-1001", reasonCode: "damaged" },
      runnableConfig,
      { decisionId: "decision-1" }
    );

    expect(runner.execute).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      type: "succeeded",
      result: {
        outcome: {
          type: "deduplicated",
          reason: "committed_result_reused",
          original: { businessEffectId: "effect-1" },
          result: effect,
        },
      },
    });
  });

  it("denies a refund with a typed failure and no provider call when the ledger is unavailable", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const ledger = {
      prepare: vi.fn(async () => ({ type: "unavailable", errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE" })),
      findExecutionByReplayKey: vi.fn(async () => null),
    } as unknown as BusinessEffectLedger;
    const runner = new ToolExecutionRunner(ledger, {} as ResultReferenceStore);
    const provider = await orderProvider();
    const runtime = await loadShoppingAssistantToolRuntime({
      orderProvider: provider,
      statusReader: { read: async () => null },
      dispatchPipelineDependencies: pipelineDependencies(runner),
    });
    const refund = runtime.tools.find((tool) => tool.name === "order_refund_request");
    const executor = refund ? getGovernedToolExecutor(refund) : null;

    const outcome = await executor?.executeAuthorizedTyped?.(
      { orderId: "ORD-1001", reasonCode: "damaged" },
      runnableConfig,
      { decisionId: "decision-1" }
    );

    expect(outcome).toMatchObject({
      type: "succeeded",
      result: { outcome: { errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE" } },
    });
    expect(provider.submissions).toBe(0);
  });

  it("rejects identity or approval fields as a schema error before authorization", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const runner = runnerReturning({ type: "failed", errorCode: "UNUSED" });
    const provider = await orderProvider();
    const runtime = await loadShoppingAssistantToolRuntime({
      orderProvider: provider,
      statusReader: { read: async () => null },
      dispatchPipelineDependencies: pipelineDependencies(runner),
    });
    const refund = runtime.tools.find((tool) => tool.name === "order_refund_request");
    const executor = refund ? getGovernedToolExecutor(refund) : null;

    const outcome = await executor?.executeTyped(
      { orderId: "ORD-1001", reasonCode: "damaged", principalId: "synthetic-shopper-b", approved: true },
      runnableConfig
    );

    expect(outcome).toEqual({ type: "rejected_before_dispatch", errorCode: "TOOL_INPUT_VALIDATION_FAILED" });
    expect(runner.execute).not.toHaveBeenCalled();
    expect(provider.submissions).toBe(0);
  });

  it.each([
    ["an unregistered tool", { toolId: "order_delete", toolVersion: "1.0.0" }, "AGENT_MANIFEST_TOOL_UNREGISTERED"],
    ["a tool at another version", { toolId: "order_refund_request", toolVersion: "2.0.0" }, "AGENT_MANIFEST_TOOL_UNREGISTERED"],
  ])("fails closed when the agent manifest references %s", async (_case, tool, code) => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");

    await expect(
      loadShoppingAssistantToolRuntime({
        orderProvider: await orderProvider(),
        statusReader: { read: async () => null },
        agentManifest: { ...SHOPPING_ASSISTANT_AGENT_MANIFEST, tools: [...SHOPPING_ASSISTANT_AGENT_MANIFEST.tools, tool] },
      })
    ).rejects.toMatchObject({ name: "ShoppingToolRuntimeError", code });
  });

  it("fails closed for an invalid agent manifest", async () => {
    const { tools: _tools, ...withoutTools } = SHOPPING_ASSISTANT_AGENT_MANIFEST;

    await expect(
      loadShoppingAssistantToolRuntime({
        orderProvider: await orderProvider(),
        statusReader: { read: async () => null },
        agentManifest: withoutTools,
      })
    ).rejects.toBeInstanceOf(ShoppingToolRuntimeError);
  });
});

describe("order tool manifest registration", () => {
  async function manifestInput(index: number) {
    const { authorization } = createRuntimeToolAuthorizationComposition({
      db: null,
      additionalPolicies: createOrderToolRiskPolicies(),
    });
    const profileRegistry = createLocalExecutionProfileRegistry();
    registerOrderExecutionProfiles(profileRegistry);
    const set = createOrderToolSet({ provider: await orderProvider(), statusReader: { read: async () => null } });
    const tool = set.tools[index]!;
    const descriptor = set.descriptors[index]!;
    return { tool, descriptor, riskPolicy: authorization.riskRegistry.get(tool.name), profileRegistry };
  }

  it("declares the refund tool as an approved external mutation that can only be reconciled", async () => {
    const manifest = createOrderToolManifest(await manifestInput(0));

    expect(manifest).toMatchObject({
      sideEffectClass: "external_mutation",
      requiredCapabilities: ["tool:write"],
      executionProfile: { egress: { destinations: [], protocols: [] } },
      idempotency: { kind: "business_effect_key" },
      approvalPolicyKey: "human_confirmation_required",
      compensation: "reconcile_only",
      dataClassification: "commerce:internal-synthetic",
    });
  });

  it.each(["approvalPolicyKey", "idempotency", "dataClassification", "requiredCapabilities"])(
    "fails closed when the refund manifest lacks %s",
    async (field) => {
      const input = await manifestInput(0);
      const manifest: Record<string, unknown> = { ...createOrderToolManifest(input) };
      delete manifest[field];

      await expect(registerOrderToolManifest(manifest, input.descriptor)).rejects.toBeInstanceOf(
        OrderToolRegistrationError
      );
    }
  );

  it("refuses a mutation whose risk policy does not require confirmation", async () => {
    const input = await manifestInput(1);

    expect(() =>
      createOrderToolManifest({ ...input, riskPolicy: { ...input.riskPolicy!, requireConfirmation: false } })
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_MISSING" }));
  });

  it("declares the status lookup as read-only without approval", async () => {
    const manifest = createOrderToolManifest(await manifestInput(2));

    expect(manifest).toMatchObject({
      sideEffectClass: "read-only",
      requiredCapabilities: ["tool:read"],
      idempotency: { kind: "read_only" },
      approvalPolicyKey: "none",
      compensation: "none",
    });
  });
});
