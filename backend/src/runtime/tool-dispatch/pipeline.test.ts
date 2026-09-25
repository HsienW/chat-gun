import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";

import type { CompensationRegistry } from "../compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../compensation/saga-orchestrator.js";
import type { GovernedToolExecutor } from "../side-effect/governed-outcome.js";
import type {
  ToolExecutionRunner,
  ToolExecutionRunResult,
} from "../side-effect/tool-execution-runner.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import { RuntimeToolDescriptorRegistry } from "./runtime-tool-descriptor.js";
import {
  createRuntimeToolDispatchPipeline,
  type ToolDispatchTaskStepAdapter,
} from "./pipeline.js";
import { ToolSchedulingError } from "./scheduler.js";

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
  isReadOnly: boolean,
  overrides: Partial<RuntimeToolDescriptor<unknown, string>> = {}
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
    ...overrides,
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

type RunnerExecuteMock = Mock<
  (input: unknown) => Promise<ToolExecutionRunResult<unknown>>
>;

function createDependencies(
  registry: RuntimeToolDescriptorRegistry,
  runnerExecute: RunnerExecuteMock = vi.fn(async () => ({
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
    stepLock: {
      acquire: vi.fn(async () => true),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    },
    stepLockTtlMs: 30_000,
    runnerExecute,
  };
}

const runnableConfig = {
  configurable: { execution_context: executionContext },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("waits for a bounded rate-limit defer before dispatching", async () => {
    const descriptor = createDescriptor(true, {
      rateLimitPolicy: { maxRequestsPerWindow: 1, windowMs: 1_000 },
    });
    const dependencies = createDependencies(createRegistry(descriptor));
    const waitForDelay = vi.fn(async () => undefined);
    const rateLimiter = {
      check: vi.fn(() => ({ type: "defer" as const, retryAfterMs: 250 })),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      rateLimiter,
      waitForDelay,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(outcome.type).toBe("succeeded");
    expect(waitForDelay).toHaveBeenCalledWith(250, undefined);
    expect(dependencies.runnerExecute).toHaveBeenCalledOnce();
  });

  it("rejects a rate-limit deny before physical dispatch", async () => {
    const descriptor = createDescriptor(true, {
      rateLimitPolicy: { maxRequestsPerWindow: 1, windowMs: 1_000 },
    });
    const dependencies = createDependencies(createRegistry(descriptor));
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "closed" as const),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      rateLimiter: {
        check: vi.fn(() => ({
          type: "deny" as const,
          errorCode: "TOOL_RATE_LIMITED" as const,
        })),
      },
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toEqual({
      type: "rejected_before_dispatch",
      errorCode: "TOOL_RATE_LIMITED",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(circuitBreaker.beforeDispatch).not.toHaveBeenCalled();
    expect(circuitBreaker.record).not.toHaveBeenCalled();
  });

  it("returns TOOL_CIRCUIT_OPEN without physical dispatch", async () => {
    const descriptor = createDescriptor(true, {
      circuitBreakerPolicy: {
        failureThreshold: 1,
        successThreshold: 1,
        resetTimeoutMs: 1_000,
        halfOpenMaxProbes: 1,
      },
    });
    const dependencies = createDependencies(createRegistry(descriptor));
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "open" as const),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toEqual({
      type: "failed_not_committed",
      errorCode: "TOOL_CIRCUIT_OPEN",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(circuitBreaker.record).not.toHaveBeenCalled();
  });

  it("reports circuit evaluation failures without disguising them as an open circuit", async () => {
    const descriptor = createDescriptor(true, {
      circuitBreakerPolicy: {
        failureThreshold: 1,
        successThreshold: 1,
        resetTimeoutMs: 1_000,
        halfOpenMaxProbes: 1,
      },
    });
    const dependencies = createDependencies(createRegistry(descriptor));
    dependencies.observability.audit = vi.fn(() => {
      throw new Error("audit unavailable");
    });
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => {
        throw new Error("circuit store unavailable");
      }),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toEqual({
      type: "failed_not_committed",
      errorCode: "TOOL_CIRCUIT_EVALUATION_FAILED",
    });
    expect(dependencies.observability.audit).toHaveBeenCalledWith(
      "tool.circuit.evaluation_failed",
      {
        toolName: descriptor.toolName,
        errorCode: "TOOL_CIRCUIT_EVALUATION_FAILED",
      },
      executionContext
    );
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(circuitBreaker.record).not.toHaveBeenCalled();
  });

  it("passes undefined policies through allow and closed decisions", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const rateLimiter = { check: vi.fn(() => ({ type: "allow" as const })) };
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "closed" as const),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      rateLimiter,
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(rateLimiter.check).toHaveBeenCalledWith(
      descriptor.toolName,
      undefined,
      undefined
    );
    expect(circuitBreaker.beforeDispatch).toHaveBeenCalledWith(
      descriptor.toolName,
      undefined
    );
    expect(circuitBreaker.record).toHaveBeenCalledWith(
      descriptor.toolName,
      undefined,
      "success"
    );
  });

  it("records a terminal failed_not_committed outcome as definitive failure", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(
      createRegistry(descriptor),
      vi.fn(async () => ({ type: "failed" as const, errorCode: "TIMEOUT" }))
    );
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "closed" as const),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(circuitBreaker.record).toHaveBeenCalledWith(
      descriptor.toolName,
      undefined,
      "definitive_failure"
    );
  });

  it("does not record a per-Run capacity rejection as a circuit failure", async () => {
    const descriptor = createDescriptor(true, {
      circuitBreakerPolicy: {
        failureThreshold: 1,
        successThreshold: 1,
        resetTimeoutMs: 1_000,
        halfOpenMaxProbes: 1,
      },
    });
    const dependencies = createDependencies(createRegistry(descriptor));
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "closed" as const),
      record: vi.fn(),
    };
    const scheduler = {
      schedule: vi.fn(async () => {
        throw new ToolSchedulingError("TOOL_RUN_CAPACITY_EXCEEDED");
      }),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      circuitBreaker,
      scheduler,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toMatchObject({
      type: "succeeded",
      result: {
        outcome: {
          type: "rejected_before_dispatch",
          errorCode: "TOOL_RUN_CAPACITY_EXCEEDED",
        },
      },
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(circuitBreaker.record).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "ambiguous",
      runnerResult: {
        type: "deferred" as const,
        errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED" as const,
      },
    },
    {
      name: "cancelled",
      runnerResult: { type: "cancelled" as const, dispatchState: "after" as const },
    },
  ])("does not record $name outcomes in the circuit breaker", async ({ runnerResult }) => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(
      createRegistry(descriptor),
      vi.fn(async () => runnerResult)
    );
    const circuitBreaker = {
      beforeDispatch: vi.fn(() => "closed" as const),
      record: vi.fn(),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      circuitBreaker,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(circuitBreaker.record).not.toHaveBeenCalled();
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

  it("does not dispatch when the Step lock cannot be acquired", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const stepLock = {
      acquire: vi.fn(async () => false),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      stepLock,
      stepLockTtlMs: 30_000,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toEqual({
      type: "rejected_before_dispatch",
      errorCode: "TOOL_STEP_LOCK_UNAVAILABLE",
    });
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(dependencies.taskStepAdapter.start).not.toHaveBeenCalled();
    expect(stepLock.release).not.toHaveBeenCalled();
  });

  it("audits Step lock acquisition failures without exposing the thrown error", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const stepLock = {
      acquire: vi.fn(async () => {
        throw new Error("redis connection contains sensitive details");
      }),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      stepLock,
      stepLockTtlMs: 30_000,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    await expect(
      executor.executeTyped({ value: "x" }, runnableConfig)
    ).resolves.toEqual({
      type: "rejected_before_dispatch",
      errorCode: "TOOL_STEP_LOCK_UNAVAILABLE",
    });
    expect(dependencies.observability.audit).toHaveBeenCalledWith(
      "tool.step_lock.acquire_failed",
      {
        toolName: descriptor.toolName,
        errorCode: "TOOL_STEP_LOCK_UNAVAILABLE",
      },
      executionContext
    );
    expect(
      JSON.stringify(dependencies.observability.audit.mock.calls)
    ).not.toContain("sensitive details");
    expect(dependencies.runnerExecute).not.toHaveBeenCalled();
    expect(dependencies.taskStepAdapter.start).not.toHaveBeenCalled();
    expect(stepLock.release).not.toHaveBeenCalled();
  });

  it("extends and releases the Step lock during a long Tool execution", async () => {
    vi.useFakeTimers();
    const descriptor = createDescriptor(true);
    const runnerGate = deferred<void>();
    const runnerExecute: RunnerExecuteMock = vi.fn(async () => {
      await runnerGate.promise;
      return { type: "succeeded", source: "live", result: "ok" };
    });
    const dependencies = createDependencies(
      createRegistry(descriptor),
      runnerExecute
    );
    const stepLock = {
      acquire: vi.fn(async () => true),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      stepLock,
      stepLockTtlMs: 30_000,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = executor.executeTyped({ value: "x" }, runnableConfig);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stepLock.extend).toHaveBeenCalledOnce();
    runnerGate.resolve();
    await expect(outcome).resolves.toMatchObject({ type: "succeeded" });
    expect(stepLock.release).toHaveBeenCalledOnce();
  });

  it("aborts Tool work and returns a stable error when lock extension fails", async () => {
    vi.useFakeTimers();
    const descriptor = createDescriptor(true);
    const runnerExecute: RunnerExecuteMock = vi.fn(async (input: unknown) => {
      const signal = (input as { signal?: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { type: "cancelled", dispatchState: "after" };
    });
    const dependencies = createDependencies(
      createRegistry(descriptor),
      runnerExecute
    );
    const stepLock = {
      acquire: vi.fn(async () => true),
      extend: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      stepLock,
      stepLockTtlMs: 30_000,
    }).createExecutor(descriptor.toolName, createSourceExecutor());

    const outcome = executor.executeTyped({ value: "x" }, runnableConfig);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      type: "succeeded",
      result: {
        outcome: {
          type: "ambiguous_after_dispatch",
          errorCode: "TOOL_STEP_LOCK_EXTEND_FAILED",
        },
      },
    });
    expect(stepLock.release).toHaveBeenCalledOnce();
  });

  it("clears the heartbeat timer and releases the lock on abort", async () => {
    vi.useFakeTimers();
    const descriptor = createDescriptor(true);
    const controller = new AbortController();
    const runnerExecute: RunnerExecuteMock = vi.fn(async (input: unknown) => {
      const signal = (input as { signal?: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { type: "cancelled", dispatchState: "after" };
    });
    const dependencies = createDependencies(
      createRegistry(descriptor),
      runnerExecute
    );
    const stepLock = {
      acquire: vi.fn(async () => true),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const executor = createRuntimeToolDispatchPipeline({
      ...dependencies,
      stepLock,
      stepLockTtlMs: 30_000,
    }).createExecutor(descriptor.toolName, createSourceExecutor());
    const config = {
      ...runnableConfig,
      signal: controller.signal,
    };

    const outcome = executor.executeTyped({ value: "x" }, config);
    await flushPromises();
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ type: "succeeded" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stepLock.release).toHaveBeenCalledOnce();
    expect(stepLock.extend).not.toHaveBeenCalled();
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

  it("records independent queue and total latency metrics with canonical correlation", async () => {
    const descriptor = createDescriptor(true);
    const dependencies = createDependencies(createRegistry(descriptor));
    const executor = createRuntimeToolDispatchPipeline(
      dependencies
    ).createExecutor(descriptor.toolName, createSourceExecutor());

    await executor.executeTyped({ value: "x" }, runnableConfig);

    expect(dependencies.observability.metric).toHaveBeenCalledWith(
      "tool.schedule.queue_wait",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: descriptor.toolName,
      }),
      executionContext
    );
    expect(dependencies.observability.metric).toHaveBeenCalledWith(
      "tool.dispatch.total",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: descriptor.toolName,
      }),
      executionContext
    );
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
