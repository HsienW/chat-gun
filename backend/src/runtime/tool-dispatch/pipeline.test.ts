import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CompensationRegistry } from "../compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../compensation/saga-orchestrator.js";
import type { GovernedToolExecutor } from "../side-effect/governed-outcome.js";
import type { ToolExecutionRunner } from "../side-effect/tool-execution-runner.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import { RuntimeToolDescriptorRegistry } from "./runtime-tool-descriptor.js";
import {
  createRuntimeToolDispatchPipeline,
  type ToolDispatchTaskStepAdapter,
} from "./pipeline.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "tool-call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: "2026-09-23T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "principal" as const,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
  },
};

function createDescriptor(
  isReadOnly: boolean
): RuntimeToolDescriptor<unknown, string> {
  const toolName = isReadOnly ? "read_tool" : "mutation_tool";
  return {
    toolName,
    toolVersion: "1.0",
    inputSchema: z.object({ value: z.string() }).strict(),
    outputSchema: z.string(),
    riskTier: isReadOnly ? "read" : "write",
    isReadOnly,
    isConcurrencySafe: () => isReadOnly,
    timeoutPolicy: { timeoutMs: 1_000 },
    retryPolicy: {
      maxAttempts: 2,
      maxElapsedMs: 5_000,
      retryableCategories: ["timeout"],
      backoffStrategy: "fixed",
      jitter: false,
    },
    interruptBehavior: isReadOnly ? "cancel_safe" : "reconcile_first",
    ...(isReadOnly
      ? {}
      : {
          sideEffect: {
            toolName,
            toolVersion: "1.0",
            deriveBusinessEffectKey: (input: unknown) => JSON.stringify(input),
            reconcile: { reconcile: async () => ({ state: "unknown" as const }) },
            resultReferencePolicy: {
              toResultRef: (result: string) => ({
                resultHash: `hash:${result}`,
                payloadRef: result,
              }),
              resolveResultRef: async (payloadRef: string) => payloadRef,
              isReusable: (cacheState: string) => cacheState === "reusable",
            },
          },
        }),
  };
}

function createRegistry(...descriptors: RuntimeToolDescriptor<unknown, string>[]) {
  const registry = new RuntimeToolDescriptorRegistry();
  for (const descriptor of descriptors) {
    registry.register(
      { toolName: descriptor.toolName, toolVersion: descriptor.toolVersion },
      descriptor
    );
  }
  return registry;
}

function createSourceExecutor(): GovernedToolExecutor<unknown, string> {
  return {
    authorizeTyped: vi.fn(async () => ({
      type: "authorized" as const,
      decisionId: "decision-1",
    })),
    executeAuthorizedTyped: vi.fn(async () => ({
      type: "succeeded" as const,
      result: "ok",
    })),
    executeTyped: vi.fn(async () => ({
      type: "succeeded" as const,
      result: "ok",
    })),
  };
}

function createDependencies(
  registry: RuntimeToolDescriptorRegistry,
  runnerExecute = vi.fn(async () => ({
    type: "succeeded" as const,
    source: "live" as const,
    result: "ok",
  }))
) {
  const taskStepAdapter: ToolDispatchTaskStepAdapter = {
    start: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
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
    registry,
    toolExecutionRunner: {
      execute: runnerExecute as ToolExecutionRunner["execute"],
    },
    retryBudgetFactory: vi.fn((stepId: string, policy: { maxAttempts: number; maxElapsedMs: number }) => ({
      stepId,
      maxAttempts: policy.maxAttempts,
      maxElapsedMs: policy.maxElapsedMs,
      startedAt: 0,
      attempts: 0,
    })),
    taskStepAdapter,
    compensationRegistry,
    sagaOrchestrator,
    observability: {
      audit: vi.fn(async () => undefined),
      metric: vi.fn(async () => undefined),
    },
    runnerExecute,
  };
}

const runnableConfig = {
  configurable: { execution_context: executionContext },
};

describe("RuntimeToolDispatchPipeline", () => {
  it("denies an unregistered tool before any physical dispatch", async () => {
    const dependencies = createDependencies(createRegistry());
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);
    const executor = pipeline.createExecutor("unknown_tool", createSourceExecutor());

    const outcome = await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(outcome).toEqual({
      type: "rejected_before_dispatch",
      errorCode: "UNREGISTERED_TOOL_DENIED",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
  });

  it("fails closed when a mandatory dependency is unavailable", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const pipeline = createRuntimeToolDispatchPipeline({
      ...dependencies,
      taskStepAdapter: undefined,
    });
    const executor = pipeline.createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(outcome).toEqual({
      type: "rejected_before_dispatch",
      errorCode: "TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
  });

  it("fails closed when production authorization is missing", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);
    const executor = pipeline.createExecutor(descriptor.toolName, {
      executeTyped: vi.fn(async () => ({
        type: "succeeded" as const,
        result: "raw",
      })),
    });

    const outcome = await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(outcome).toEqual({
      type: "rejected_before_dispatch",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
  });

  it("dispatches read-only tools without a side-effect descriptor", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);
    const executor = pipeline.createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(dependencies.runnerExecute).toHaveBeenCalledWith(
      expect.objectContaining({ descriptor: undefined })
    );
    expect(outcome.type).toBe("succeeded");
    if (outcome.type === "succeeded") {
      expect(outcome.result).toMatchObject({
        schemaVersion: "1.0",
        kind: "tool_result",
        outcome: { type: "succeeded", result: "ok" },
      });
    }
    expect(dependencies.taskStepAdapter.complete).toHaveBeenCalledOnce();
  });

  it("dispatches mutation tools with side-effect and retry policies", async () => {
    const descriptor = createDescriptor(false);
    const dependencies = createDependencies(createRegistry(descriptor));
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);
    const executor = pipeline.createExecutor(descriptor.toolName, createSourceExecutor());

    await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(dependencies.runnerExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: descriptor.sideEffect,
        retryBudget: expect.objectContaining({ stepId: "step-1" }),
      })
    );
  });

  it("does not retry a pre-authorized mutation without a fresh authorization", async () => {
    const descriptor = createDescriptor(false);
    const dependencies = createDependencies(createRegistry(descriptor));
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);
    const executor = pipeline.createExecutor(
      descriptor.toolName,
      createSourceExecutor()
    );

    await executor.executeAuthorizedTyped?.(
      { value: "x" },
      runnableConfig
    );

    expect(dependencies.runnerExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        retryBudget: expect.objectContaining({ maxAttempts: 1 }),
      })
    );
  });

  it("preserves the dispatch outcome when audit exporters fail", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    dependencies.observability.audit = vi.fn(() => {
      throw new Error("audit unavailable");
    });
    dependencies.observability.metric = vi.fn(() => {
      throw new Error("metric unavailable");
    });
    const executor = createRuntimeToolDispatchPipeline(
      dependencies
    ).createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = await executor.executeTyped(
      { value: "x" },
      runnableConfig
    );

    expect(outcome).toMatchObject({
      type: "succeeded",
      result: { outcome: { type: "succeeded", result: "ok" } },
    });
    expect(dependencies.observability.audit).toHaveBeenCalledWith(
      "tool.dispatch.completed",
      expect.objectContaining({
        toolResult: expect.objectContaining({
          schemaVersion: "1.0",
          kind: "tool_result",
          outcome: { type: "succeeded", result: "[redacted]" },
        }),
      }),
      executionContext
    );
    expect(
      JSON.stringify(dependencies.observability.audit.mock.calls)
    ).not.toContain('"result":"ok"');
  });

  it("returns an ambiguous envelope when Task/Step completion fails after dispatch", async () => {
    const descriptor = createDescriptor(false);
    const dependencies = createDependencies(createRegistry(descriptor));
    dependencies.taskStepAdapter.complete = vi.fn(async () => {
      throw new Error("task persistence unavailable");
    });
    const executor = createRuntimeToolDispatchPipeline(
      dependencies
    ).createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = await executor.executeTyped(
      { value: "x" },
      runnableConfig
    );

    expect(outcome).toMatchObject({
      type: "succeeded",
      result: {
        outcome: {
          type: "ambiguous_after_dispatch",
          errorCode: "TASK_STEP_PERSISTENCE_FAILED_AFTER_DISPATCH",
        },
      },
    });
  });

  it("exposes compensation only through the explicit saga orchestrator path", async () => {
    const descriptor = createDescriptor(false);
    const dependencies = createDependencies(createRegistry(descriptor));
    dependencies.compensationRegistry.hasActions = vi.fn(
      (toolName: string) => toolName === descriptor.toolName
    );
    const pipeline = createRuntimeToolDispatchPipeline(dependencies);

    expect(pipeline.hasCompensation(descriptor.toolName)).toBe(true);
    await expect(
      pipeline.compensate("task-1", { reason: "terminal_failed" })
    ).resolves.toMatchObject({ taskId: "task-1" });
    expect(dependencies.sagaOrchestrator.compensate).toHaveBeenCalledWith(
      "task-1",
      { reason: "terminal_failed" }
    );
  });
});
