import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { executionContextSchema } from "../execution-context/execution-context.js";

import type { AuditLogger } from "../../platform/observability.js";
import {
  createNoopSpanManager,
  type SpanManager,
} from "../../platform/tracing/span-manager.js";
import type { RetryBudget } from "../retry/retry-budget.js";
import type {
  BusinessEffectLedger,
  PrepareSideEffectResult,
  ToolExecutionRecord,
} from "./business-effect-ledger.js";
import type {
  GovernedAuthorizationOutcome,
  GovernedToolExecutor,
} from "./governed-outcome.js";
import { createConfirmationRequiredDescriptor } from "../authorization/confirmation.js";
import { createReplayKey, hashBusinessEffectKey } from "./identity.js";
import type { ReconciliationTaskStore } from "./reconciliation-task-store.js";
import type { ResultReferenceStore } from "./result-reference-store.js";
import type { SideEffectToolDescriptor } from "./side-effect-descriptor.js";
import {
  ToolExecutionRunner,
  type ToolExecutionRunnerObservability,
} from "./tool-execution-runner.js";

type TestInput = { resourceId: string };
type TestResult = { operationId: string };

const scope = {
  scopeId: "scope-1",
  tenantId: "tenant-1",
  principalId: "principal-1",
};
const contextFixture = JSON.parse(readFileSync(
  new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as { validContext: unknown };
const resilienceFixture = JSON.parse(readFileSync(
  new URL(
    "../../../../contracts/tool-scheduling-resilience.fixture.json",
    import.meta.url
  ),
  "utf8"
)) as {
  retryOutcomes: {
    persistenceUncertain: { first: string; resume: string };
  };
};
const executionContext = executionContextSchema.parse(contextFixture.validContext);
const identity = {
  runId: "run-1",
  stepId: "step-1",
  logicalToolCallId: "tool-call-1",
  callIndex: 0,
  toolName: "side_effect_tool",
  toolVersion: "1",
};
const replayKey = createReplayKey(identity);
const execution: ToolExecutionRecord = {
  toolExecutionId: "execution-1",
  businessEffectId: "effect-1",
  replayKey,
  requestHash: "request-hash-1",
  status: "prepared",
  stepId: "step-1",
  toolName: "side_effect_tool",
  toolVersion: "1",
};
const claimed: PrepareSideEffectResult = {
  type: "claimed",
  businessEffect: {
    businessEffectId: "effect-1",
    scopeId: "scope-1",
    tenantId: "tenant-1",
    businessEffectKey: hashBusinessEffectKey("resource-1"),
    commitState: "prepared",
  },
  execution,
};

function createDescriptor(
  reconcile?: SideEffectToolDescriptor<TestInput, TestResult>["reconcile"],
  includeExternalOperation = false
): SideEffectToolDescriptor<TestInput, TestResult> {
  return {
    toolName: "side_effect_tool",
    toolVersion: "1",
    deriveBusinessEffectKey: ({ resourceId }) => resourceId,
    ...(reconcile ? { reconcile } : {}),
    resultReferencePolicy: {
      toResultRef: ({ operationId }) => ({
        resultHash: `hash-${operationId}`,
        payloadRef: `payload://${operationId}`,
        ...(includeExternalOperation
          ? {
              externalSystemNamespace: "test-system",
              externalOperationId: operationId,
            }
          : {}),
      }),
      resolveResultRef: async () => null,
      isReusable: (cacheState) => cacheState === "reusable",
    },
  };
}

function createLedger() {
  const ledger = {
    prepare: vi.fn<BusinessEffectLedger["prepare"]>(async () => claimed),
    findExecutionByReplayKey: vi.fn<
      BusinessEffectLedger["findExecutionByReplayKey"]
    >(async () => null),
    recordAttempt: vi.fn<BusinessEffectLedger["recordAttempt"]>(
      async () => undefined
    ),
    completeAttempt: vi.fn<BusinessEffectLedger["completeAttempt"]>(
      async () => undefined
    ),
    linkAuthorizationDecision: vi.fn(async () => undefined),
    transitionExecution: vi.fn<BusinessEffectLedger["transitionExecution"]>(
      async () => undefined
    ),
    transitionBusinessEffect: vi.fn<
      BusinessEffectLedger["transitionBusinessEffect"]
    >(async () => undefined),
    commitExecutionAndBusinessEffect: vi.fn<
      BusinessEffectLedger["commitExecutionAndBusinessEffect"]
    >(async () => undefined),
    transitionBusinessEffectAndExecution: vi.fn<
      BusinessEffectLedger["transitionBusinessEffectAndExecution"]
    >(async () => undefined),
    releaseClaim: vi.fn<BusinessEffectLedger["releaseClaim"]>(
      async () => undefined
    ),
    findBusinessEffectSnapshot: vi.fn<
      BusinessEffectLedger["findBusinessEffectSnapshot"]
    >(async () => null),
    findCommittedExecutionByStepId: vi.fn<
      BusinessEffectLedger["findCommittedExecutionByStepId"]
    >(async () => null),
    prepareCompensationExecution: vi.fn<
      BusinessEffectLedger["prepareCompensationExecution"]
    >(async () => undefined),
    transitionCompensationExecution: vi.fn<
      BusinessEffectLedger["transitionCompensationExecution"]
    >(async () => undefined),
  } satisfies BusinessEffectLedger;
  return ledger;
}

function createPreflightExecutor(
  authorizationOutcomes: GovernedAuthorizationOutcome[],
  outcomes: Array<
    Awaited<
      ReturnType<GovernedToolExecutor<TestInput, TestResult>["executeTyped"]>
    >
  >
) {
  const authorizeTyped = vi.fn();
  authorizationOutcomes.forEach((outcome) =>
    authorizeTyped.mockResolvedValueOnce(outcome)
  );
  const executeAuthorizedTyped = vi.fn();
  outcomes.forEach((outcome) =>
    executeAuthorizedTyped.mockResolvedValueOnce(outcome)
  );
  return {
    authorizeTyped,
    executeAuthorizedTyped,
    executeTyped: vi.fn(),
  };
}

function createResultStore(overrides: Partial<ResultReferenceStore> = {}) {
  return {
    save: vi.fn(async () => ({
      resultRefId: "result-ref-1",
      toolExecutionId: "execution-1",
      scope,
      toolVersion: "1",
      cacheState: "reusable" as const,
      resultHash: "hash-operation-1",
      payloadRef: "payload://operation-1",
    })) as ResultReferenceStore["save"],
    resolve: vi.fn(async () => null) as ResultReferenceStore["resolve"],
    ...overrides,
  } satisfies ResultReferenceStore;
}

function createExecutor(
  outcomes: Array<Awaited<ReturnType<GovernedToolExecutor<TestInput, TestResult>["executeTyped"]>>>
) {
  const executeTyped = vi.fn<
    GovernedToolExecutor<TestInput, TestResult>["executeTyped"]
  >();
  outcomes.forEach((outcome) => executeTyped.mockResolvedValueOnce(outcome));
  return { executeTyped };
}

function createRunner(
  ledger: BusinessEffectLedger,
  resultStore: ResultReferenceStore,
  observability: Partial<ToolExecutionRunnerObservability> = {},
  timing: {
    wait(delayMs: number, signal?: AbortSignal): Promise<void>;
  } = { wait: vi.fn(async () => undefined) }
) {
  const auditLogger: AuditLogger = { record: vi.fn(async () => undefined) };
  return new ToolExecutionRunner(ledger, resultStore, {
    auditLogger,
    spanManager: createNoopSpanManager(),
    recordMetric: vi.fn(async () => undefined),
    ...observability,
  }, timing);
}

function createBudget(maxAttempts = 2): RetryBudget {
  return {
    stepId: "step-1",
    maxAttempts,
    maxElapsedMs: 60_000,
    startedAt: Date.now(),
    attempts: 0,
  };
}

function runInput(
  executor: GovernedToolExecutor<TestInput, TestResult>,
  descriptor: SideEffectToolDescriptor<TestInput, TestResult> | undefined,
  retryBudget?: RetryBudget
) {
  return {
    identity,
    requestHash: "request-hash-1",
    scope,
    input: { resourceId: "resource-1" },
    retryAfterMaxMs: 30_000,
    executor,
    ...(descriptor ? { descriptor } : {}),
    ...(retryBudget ? { retryBudget } : {}),
    requestId: "request-1",
    threadId: "thread-1",
    taskId: "task-1",
  };
}

describe("ToolExecutionRunner", () => {
  it("derives ledger, tool config, and audit correlation from one context", async () => {
    const ledger = createLedger();
    const executor = createExecutor([{ type: "succeeded", result: { operationId: "live" } }]);
    const auditRecord = vi.fn<AuditLogger["record"]>(async () => undefined);
    const recordMetric = vi.fn(async () => undefined);
    const runner = createRunner(ledger, createResultStore(), {
      auditLogger: { record: auditRecord },
      recordMetric,
    });

    await runner.execute({
      ...runInput(executor, createDescriptor()),
      requestId: "legacy-request",
      executionContext,
    });

    expect(ledger.prepare).toHaveBeenCalledWith(expect.objectContaining({
      requestId: executionContext.requestId,
      threadId: executionContext.threadId,
      taskId: executionContext.taskId,
    }));
    expect(executor.executeTyped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        configurable: expect.objectContaining({
          execution_context: expect.objectContaining({
            requestId: executionContext.requestId,
            toolExecutionId: "execution-1",
          }),
        }),
      })
    );
    expect(auditRecord).toHaveBeenCalledWith(
      "tool.side_effect.prepared",
      expect.anything(),
      executionContext
    );
    expect(recordMetric).toHaveBeenCalledWith(
      "tool.side_effect.outcome",
      expect.anything(),
      executionContext
    );
  });

  it("rejects a side-effect identity that conflicts with canonical context", async () => {
    const runner = createRunner(createLedger(), createResultStore());
    await expect(runner.execute({
      ...runInput(createExecutor([]), createDescriptor()),
      executionContext: { ...executionContext, runId: "other-run" },
    })).rejects.toThrow("conflicts");
  });

  it("uses the legacy path for a tool without a side-effect descriptor", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "read-only" } },
    ]);
    const runner = createRunner(ledger, createResultStore());

    await expect(runner.execute(runInput(executor, undefined))).resolves.toEqual({
      type: "succeeded",
      source: "live",
      result: { operationId: "read-only" },
    });
    expect(ledger.prepare).not.toHaveBeenCalled();
  });

  it("retries a timed-out read-only Tool within budget", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
      { type: "succeeded", result: { operationId: "read-retried" } },
    ]);
    const wait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => undefined);
    const runner = createRunner(ledger, createResultStore(), {}, { wait });

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(2)),
        retryPolicy: {
          maxAttempts: 2,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
      })
    ).resolves.toMatchObject({
      type: "succeeded",
      result: { operationId: "read-retried" },
    });
    expect(executor.executeTyped).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000, undefined);
    expect(ledger.prepare).not.toHaveBeenCalled();
  });

  it("returns the terminal read-only failure when retry budget is exhausted", async () => {
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
    ]);
    const runner = createRunner(createLedger(), createResultStore());

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(2)),
        retryPolicy: {
          maxAttempts: 2,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
      })
    ).resolves.toEqual({ type: "failed", errorCode: "TIMEOUT" });
    expect(executor.executeTyped).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable read-only failure", async () => {
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "BUSINESS_REJECTED" },
    ]);
    const runner = createRunner(createLedger(), createResultStore());

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout", "rate_limit", "server_error"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
      })
    ).resolves.toEqual({
      type: "failed",
      errorCode: "BUSINESS_REJECTED",
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
  });

  it.each([
    "EGRESS_DENIED",
    "SANDBOX_CAPABILITY_INSUFFICIENT",
    "SANDBOX_STARTUP_FAILED",
    "RESOURCE_EXHAUSTED",
  ])("does not retry security or resource policy failure %s", async (errorCode) => {
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode },
      { type: "succeeded", result: { operationId: "unsafe-retry" } },
    ]);
    const runner = createRunner(createLedger(), createResultStore());

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout", "rate_limit", "server_error"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
      })
    ).resolves.toEqual({ type: "failed", errorCode });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
  });

  it("stops read-only retry when backoff is aborted", async () => {
    const controller = new AbortController();
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
      { type: "succeeded", result: { operationId: "unexpected" } },
    ]);
    const wait = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
      controller.abort();
      signal?.throwIfAborted();
    });
    const runner = createRunner(createLedger(), createResultStore(), {}, { wait });

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
        signal: controller.signal,
      })
    ).resolves.toEqual({ type: "failed", errorCode: "USER_CANCELLED" });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
  });

  it("leaves read-only output validation to the pipeline without retrying", async () => {
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "invalid-output" } },
    ]);
    const runner = createRunner(createLedger(), createResultStore());

    await expect(
      runner.execute({
        ...runInput(executor, undefined, createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "fixed",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
        validateResult: () => false,
      })
    ).resolves.toMatchObject({ type: "succeeded" });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
  });

  it("reuses a committed result only when requestHash matches", async () => {
    const committedExecution = {
      ...execution,
      status: "committed" as const,
      resultRef: "result-ref-1",
    };
    const ledger = createLedger();
    ledger.findExecutionByReplayKey.mockResolvedValue(committedExecution);
    const resultStore = createResultStore({
      resolve: vi.fn(async () => ({ operationId: "cached" })) as ResultReferenceStore["resolve"],
    });
    const executor = createExecutor([]);
    const runner = createRunner(ledger, resultStore);

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toMatchObject({
      type: "succeeded",
      source: "cache",
      result: { operationId: "cached" },
    });
    expect(executor.executeTyped).not.toHaveBeenCalled();
  });

  it("returns conflict for the same replayKey with a different requestHash", async () => {
    const ledger = createLedger();
    ledger.findExecutionByReplayKey.mockResolvedValue({
      ...execution,
      requestHash: "different-hash",
    });
    const executor = createExecutor([]);
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toEqual({
      type: "conflict",
      errorCode: "SIDE_EFFECT_REPLAY_CONFLICT",
    });
    expect(executor.executeTyped).not.toHaveBeenCalled();
  });

  it("fails closed without dispatch when durable prepare is unavailable", async () => {
    const ledger = createLedger();
    ledger.prepare.mockResolvedValue({
      type: "unavailable",
      errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
    });
    const executor = createExecutor([]);
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toEqual({
      type: "deferred",
      errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
    });
    expect(executor.executeTyped).not.toHaveBeenCalled();
  });

  it("dispatches only after claim and persists a successful attempt", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "operation-1" } },
    ]);
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toMatchObject({
      type: "succeeded",
      source: "live",
      result: { operationId: "operation-1" },
    });
    expect(ledger.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      executor.executeTyped.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(ledger.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ executionAttempt: 1 })
    );
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledWith({
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      resultRef: "result-ref-1",
      terminationCause: "completed",
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
    });
  });

  it("commits effect truth and parks repair when mutation output validation fails", async () => {
    const ledger = createLedger();
    const resultStore = createResultStore();
    const auditLogger: AuditLogger = {
      record: vi.fn(async () => undefined),
    };
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "invalid-result" } },
    ]);
    const runner = createRunner(ledger, resultStore, { auditLogger });

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor(), createBudget(3)),
        validateResult: () => false,
      })
    ).resolves.toEqual({
      type: "deferred",
      errorCode: "SIDE_EFFECT_OUTPUT_VALIDATION_FAILED",
      toolExecutionId: "execution-1",
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(resultStore.save).toHaveBeenCalledOnce();
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledOnce();
    expect(auditLogger.record).toHaveBeenCalledWith(
      "tool.side_effect.output_validation_failed",
      expect.objectContaining({ toolExecutionId: "execution-1" }),
      undefined
    );
  });

  it("preserves a committed result when observability exporters throw synchronously", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "operation-1" } },
    ]);
    const runner = createRunner(ledger, createResultStore(), {
      auditLogger: {
        record: vi.fn(() => {
          throw new Error("audit unavailable");
        }),
      },
      recordMetric: vi.fn(() => {
        throw new Error("metric unavailable");
      }),
    });

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toMatchObject({
      type: "succeeded",
      source: "live",
      result: { operationId: "operation-1" },
    });
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledOnce();
  });

  it("links an allow decision before creating a physical attempt", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [{ type: "authorized", decisionId: "decision-allow" }],
      [{ type: "succeeded", result: { operationId: "operation-1" } }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toMatchObject({ type: "succeeded", source: "live" });
    expect(ledger.linkAuthorizationDecision).toHaveBeenCalledWith({
      toolExecutionId: "execution-1",
      decisionId: "decision-allow",
    });
    expect(
      ledger.linkAuthorizationDecision.mock.invocationCallOrder[0]
    ).toBeLessThan(
      ledger.recordAttempt.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(executor.executeTyped).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).toHaveBeenCalledOnce();
    expect(executor.authorizeTyped).toHaveBeenCalledWith(
      { resourceId: "resource-1" },
      expect.objectContaining({
        configurable: expect.objectContaining({
          requestId: "request-1",
          threadId: "thread-1",
          runId: "run-1",
          taskId: "task-1",
          stepId: "step-1",
        }),
      })
    );
    // Authorization runs before the claim, so no execution exists yet.
    expect(
      executor.authorizeTyped.mock.invocationCallOrder[0]
    ).toBeLessThan(ledger.prepare.mock.invocationCallOrder[0] ?? 0);
    expect(
      executor.authorizeTyped.mock.calls[0]?.[1]?.configurable
    ).not.toHaveProperty("toolExecutionId");
  });

  it("does not create or retry a physical attempt after authorization deny", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [
        {
          type: "denied_by_authorization",
          errorCode: "MISSING_ROLE_SCOPE_GRANT",
          decisionId: "decision-deny",
        },
      ],
      []
    );
    const recordMetric = vi.fn<ToolExecutionRunnerObservability["recordMetric"]>(
      async () => undefined
    );
    const runner = createRunner(ledger, createResultStore(), { recordMetric });

    await expect(
      runner.execute(
        {
          ...runInput(executor, createDescriptor(), createBudget(3)),
          executionContext,
        }
      )
    ).resolves.toEqual({
      type: "failed",
      errorCode: "MISSING_ROLE_SCOPE_GRANT",
      decisionId: "decision-deny",
    });
    expect(ledger.prepare).not.toHaveBeenCalled();
    expect(ledger.recordAttempt).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
    expect(recordMetric).toHaveBeenCalledWith(
      "tool.authorization.wait",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: "side_effect_tool",
      }),
      executionContext
    );
  });

  it("does not create or retry a physical attempt while confirmation is pending", async () => {
    const ledger = createLedger();
    const descriptor = createConfirmationRequiredDescriptor({
      decisionId: "decision-confirm",
      executionContext,
      action: "tool:write",
      toolName: "side_effect_tool",
      resource: {
        resourceType: "record",
        resourceId: "resource-1",
        tenantId: executionContext.scope.tenantId,
      },
      policyVersion: "runtime-authorization-v1",
      timeoutMs: 60_000,
    });
    const executor = createPreflightExecutor(
      [{ type: "confirmation_required", decisionId: descriptor.decisionId, descriptor }],
      []
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor(), createBudget(3)))
    ).resolves.toEqual({
      type: "failed",
      errorCode: "REQUIRES_CONFIRMATION",
      decisionId: "decision-confirm",
    });
    expect(ledger.prepare).not.toHaveBeenCalled();
    expect(ledger.recordAttempt).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
  });

  it("fails closed before claiming when authorization omits decisionId", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [{ type: "authorized" }],
      [{ type: "succeeded", result: { operationId: "unexpected" } }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toEqual({
      type: "failed",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(ledger.prepare).not.toHaveBeenCalled();
    expect(ledger.releaseClaim).not.toHaveBeenCalled();
    expect(ledger.linkAuthorizationDecision).not.toHaveBeenCalled();
    expect(ledger.recordAttempt).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
  });

  it("re-authorizes before retry and stops before a second physical attempt", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [
        { type: "authorized", decisionId: "decision-allow" },
        {
          type: "denied_by_authorization",
          errorCode: "MISSING_ROLE_SCOPE_GRANT",
          decisionId: "decision-deny",
        },
      ],
      [{ type: "failed_not_committed", errorCode: "TIMEOUT" }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(
        runInput(executor, createDescriptor(), createBudget(3))
      )
    ).resolves.toMatchObject({
      type: "failed",
      errorCode: "MISSING_ROLE_SCOPE_GRANT",
      decisionId: "decision-deny",
    });
    expect(ledger.recordAttempt).toHaveBeenCalledOnce();
    expect(executor.executeAuthorizedTyped).toHaveBeenCalledOnce();
    expect(executor.authorizeTyped).toHaveBeenCalledTimes(2);
  });

  it("applies increasing backoff before mutation retries", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
      { type: "succeeded", result: { operationId: "operation-3" } },
    ]);
    const wait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => undefined);
    const recordMetric = vi.fn<ToolExecutionRunnerObservability["recordMetric"]>(
      async () => undefined
    );
    const runner = createRunner(
      ledger,
      createResultStore(),
      { recordMetric },
      { wait }
    );

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor(), createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "exponential",
          jitter: false,
        },
        retryAfterMaxMs: 5_000,
        executionContext,
      })
    ).resolves.toMatchObject({ type: "succeeded" });
    expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([1_000, 2_000]);
    expect(recordMetric).toHaveBeenCalledWith(
      "tool.retry.backoff",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: "side_effect_tool",
      }),
      executionContext
    );
    expect(recordMetric).toHaveBeenCalledWith(
      "tool.execution",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: "side_effect_tool",
      }),
      executionContext
    );
  });

  it("bounds mutation Retry-After before retrying", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      {
        type: "failed_not_committed",
        errorCode: "RATE_LIMITED",
        retryAfterMs: 60_000,
      },
      { type: "succeeded", result: { operationId: "operation-2" } },
    ]);
    const wait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => undefined);
    const runner = createRunner(ledger, createResultStore(), {}, { wait });

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor(), createBudget(2)),
        retryPolicy: {
          maxAttempts: 2,
          maxElapsedMs: 60_000,
          retryableCategories: ["rate_limit"],
          backoffStrategy: "retry-after-header",
          jitter: false,
        },
        retryAfterMaxMs: 2_500,
      })
    ).resolves.toMatchObject({ type: "succeeded" });
    expect(wait).toHaveBeenCalledWith(2_500, undefined);
  });

  it("does not retry a business rejection even when budget remains", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [{ type: "authorized", decisionId: "decision-allow" }],
      [{ type: "failed_not_committed", errorCode: "BUSINESS_REJECTED" }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(
        runInput(executor, createDescriptor(), createBudget(3))
      )
    ).resolves.toMatchObject({
      type: "failed",
      errorCode: "BUSINESS_REJECTED",
    });
    expect(ledger.recordAttempt).toHaveBeenCalledOnce();
    expect(executor.executeAuthorizedTyped).toHaveBeenCalledOnce();
    expect(executor.authorizeTyped).toHaveBeenCalledOnce();
    expect(ledger.releaseClaim).toHaveBeenCalledWith({
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      terminationCause: "failed_not_committed",
    });
  });

  it("retries a reconciled not_committed outcome with a new physical attempt", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
      { type: "succeeded", result: { operationId: "operation-2" } },
    ]);
    const reconcile = vi.fn(async () => ({ state: "not_committed" as const }));
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(
        runInput(executor, createDescriptor({ reconcile }), createBudget())
      )
    ).resolves.toMatchObject({ type: "succeeded", source: "live" });
    expect(ledger.recordAttempt.mock.calls.map(([call]) => call.executionAttempt)).toEqual([
      1,
      2,
    ]);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("uses a committed reconciliation result without a second dispatch", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
    ]);
    const reconcile = vi.fn(async () => ({
      state: "committed" as const,
      result: { operationId: "reconciled" },
    }));
    const recordMetric = vi.fn<ToolExecutionRunnerObservability["recordMetric"]>(
      async () => undefined
    );
    const runner = createRunner(ledger, createResultStore(), { recordMetric });

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor({ reconcile })),
        executionContext,
      })
    ).resolves.toMatchObject({
      type: "succeeded",
      source: "reconciled",
      result: { operationId: "reconciled" },
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(recordMetric).toHaveBeenCalledWith(
      "tool.reconcile",
      expect.objectContaining({
        durationMs: expect.any(Number),
        toolName: "side_effect_tool",
      }),
      executionContext
    );
  });

  it("persists manual defer when no reconciler can resolve ambiguity", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
    ]);
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toEqual({
      type: "deferred",
      errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
      toolExecutionId: "execution-1",
    });
    expect(ledger.transitionExecution).toHaveBeenLastCalledWith({
      toolExecutionId: "execution-1",
      expectedStatus: "unknown",
      nextStatus: "manual_intervention_required",
      terminationCause: "ambiguous_after_dispatch",
    });
  });

  it("does not redispatch when attempt persistence becomes uncertain after dispatch", async () => {
    const ledger = createLedger();
    ledger.completeAttempt.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "operation-1" } },
    ]);
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor(), createBudget(3)))
    ).resolves.toEqual({
      type: "deferred",
      errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
      toolExecutionId: "execution-1",
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(ledger.commitExecutionAndBusinessEffect).not.toHaveBeenCalled();
  });

  it("does not duplicate a side effect when resuming after an atomic commit response loss", async () => {
    const ledger = createLedger();
    ledger.findExecutionByReplayKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...execution, status: "executing" });
    ledger.commitExecutionAndBusinessEffect.mockRejectedValueOnce(
      new Error("commit response lost")
    );
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "operation-1" } },
    ]);
    const runner = createRunner(ledger, createResultStore());

    const input = runInput(executor, createDescriptor(), createBudget(3));

    await expect(runner.execute(input)).resolves.toEqual({
      type: "deferred",
      errorCode: resilienceFixture.retryOutcomes.persistenceUncertain.first,
      toolExecutionId: "execution-1",
    });
    await expect(runner.execute(input)).resolves.toEqual({
      type: "deferred",
      errorCode: resilienceFixture.retryOutcomes.persistenceUncertain.resume,
      toolExecutionId: "execution-1",
    });

    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(ledger.prepare).toHaveBeenCalledOnce();
    expect(ledger.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        businessEffectKey: hashBusinessEffectKey("resource-1"),
      })
    );
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledOnce();
  });

  it("correlates hashed identities in audit and traces without metric label leakage", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "succeeded", result: { operationId: "operation-1" } },
    ]);
    const auditRecord = vi.fn<AuditLogger["record"]>(async () => undefined);
    const recordMetric = vi.fn<ToolExecutionRunnerObservability["recordMetric"]>(
      async () => undefined
    );
    const spanManager = createNoopSpanManager();
    const withSpan = vi.spyOn(spanManager, "withSpan");
    const resultStore = createResultStore({
      save: vi.fn(async () => ({
        resultRefId: "result-ref-1",
        toolExecutionId: "execution-1",
        scope,
        toolVersion: "1",
        cacheState: "reusable" as const,
        resultHash: "hash-operation-1",
        payloadRef: "payload://operation-1",
        externalSystemNamespace: "test-system",
        externalOperationId: "operation-1",
      })) as ResultReferenceStore["save"],
    });
    const runner = createRunner(ledger, resultStore, {
      auditLogger: { record: auditRecord },
      recordMetric,
      spanManager: spanManager as SpanManager,
    });

    await runner.execute(runInput(executor, createDescriptor(undefined, true)));

    const serializedAudit = JSON.stringify(auditRecord.mock.calls);
    expect(serializedAudit).toContain(replayKey);
    expect(serializedAudit).toContain(hashBusinessEffectKey("resource-1"));
    expect(serializedAudit).toContain("execution-1");
    expect(serializedAudit).toContain("operation-1");
    expect(serializedAudit).not.toContain('"businessEffectKey":"resource-1"');
    expect(recordMetric).toHaveBeenCalledWith("tool.side_effect.outcome", {
      toolName: "side_effect_tool",
      outcomeType: "succeeded",
      count: 1,
    });
    expect(Object.keys(recordMetric.mock.calls[0]?.[1] ?? {})).not.toEqual(
      expect.arrayContaining(["requestId", "replayKey", "businessEffectKey"])
    );
    expect(withSpan).toHaveBeenCalledWith(
      "side_effect.tool_execution.claimed",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.execution_id": "execution-1",
          "tool.replay_key": replayKey,
          "business_effect.key": hashBusinessEffectKey("resource-1"),
        }),
      }),
      expect.any(Function)
    );
  });
});

describe("ToolExecutionRunner claim release and pre-claim checks", () => {
  const released = {
    businessEffectId: "effect-1",
    expectedEffectState: "prepared",
    toolExecutionId: "execution-1",
    expectedExecutionStatus: "executing",
  } as const;

  it("ends as cancelled before dispatch without a claim when already aborted", async () => {
    const ledger = createLedger();
    const controller = new AbortController();
    controller.abort();
    const executor = createPreflightExecutor(
      [{ type: "authorized", decisionId: "decision-allow" }],
      [{ type: "succeeded", result: { operationId: "unexpected" } }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor()),
        signal: controller.signal,
      })
    ).resolves.toEqual({ type: "cancelled", dispatchState: "before" });
    expect(ledger.prepare).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
  });

  it("links the consumed decision after the claim and before the attempt", async () => {
    const ledger = createLedger();
    const executor = createPreflightExecutor(
      [{ type: "authorized", decisionId: "decision-approved" }],
      [{ type: "succeeded", result: { operationId: "operation-1" } }]
    );
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor()))
    ).resolves.toMatchObject({ type: "succeeded", source: "live" });
    expect(ledger.linkAuthorizationDecision).toHaveBeenCalledWith({
      toolExecutionId: "execution-1",
      decisionId: "decision-approved",
    });
    expect(ledger.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      ledger.linkAuthorizationDecision.mock.invocationCallOrder[0] ?? 0
    );
    expect(executor.authorizeTyped).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "rejected before dispatch",
      { type: "rejected_before_dispatch" as const, errorCode: "TOOL_INPUT_INVALID" },
      "rejected_before_dispatch",
    ],
    [
      "failed not committed",
      { type: "failed_not_committed" as const, errorCode: "ORDER_NOT_FOUND" },
      "failed_not_committed",
    ],
    [
      "cancelled before dispatch",
      { type: "cancelled" as const, dispatchState: "before" as const },
      "cancelled_before_dispatch",
    ],
  ])("releases the claim when the outcome is %s", async (_label, outcome, cause) => {
    const ledger = createLedger();
    const runner = createRunner(ledger, createResultStore());

    await runner.execute(runInput(createExecutor([outcome]), createDescriptor()));

    expect(ledger.releaseClaim).toHaveBeenCalledOnce();
    expect(ledger.releaseClaim).toHaveBeenCalledWith({
      ...released,
      terminationCause: cause,
    });
    expect(ledger.transitionBusinessEffectAndExecution).not.toHaveBeenCalled();
  });

  it("releases the claim when backoff before a retry is cancelled", async () => {
    const ledger = createLedger();
    const controller = new AbortController();
    const executor = createExecutor([
      { type: "failed_not_committed", errorCode: "TIMEOUT" },
    ]);
    const runner = createRunner(ledger, createResultStore(), {}, {
      wait: vi.fn(async () => {
        controller.abort();
        throw new Error("USER_CANCELLED");
      }),
    });

    await expect(
      runner.execute({
        ...runInput(executor, createDescriptor(), createBudget(3)),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          retryableCategories: ["timeout"],
          backoffStrategy: "exponential",
          jitter: false,
        },
        signal: controller.signal,
      })
    ).resolves.toMatchObject({ type: "failed", errorCode: "USER_CANCELLED" });
    expect(ledger.releaseClaim).toHaveBeenCalledWith({
      ...released,
      terminationCause: "cancelled_before_dispatch",
    });
  });

  it.each([
    [
      "ambiguous after dispatch",
      { type: "ambiguous_after_dispatch" as const, errorCode: "RESPONSE_LOST" },
    ],
    [
      "cancelled after dispatch",
      { type: "cancelled" as const, dispatchState: "after" as const },
    ],
  ])("never releases when the outcome is %s", async (_label, outcome) => {
    const ledger = createLedger();
    const runner = createRunner(ledger, createResultStore());

    await runner.execute(runInput(createExecutor([outcome]), createDescriptor()));

    expect(ledger.releaseClaim).not.toHaveBeenCalled();
    expect(ledger.transitionBusinessEffectAndExecution).toHaveBeenCalledWith({
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
      nextEffectState: "unknown",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      nextExecutionStatus: "unknown",
    });
  });

  it("never releases a committed effect", async () => {
    const ledger = createLedger();
    const runner = createRunner(ledger, createResultStore());

    await runner.execute(
      runInput(
        createExecutor([{ type: "succeeded", result: { operationId: "operation-1" } }]),
        createDescriptor()
      )
    );

    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledOnce();
    expect(ledger.releaseClaim).not.toHaveBeenCalled();
  });

  it("releases from unknown and fails without retry when reconciliation confirms not committed", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
    ]);
    const reconcile = vi.fn(async () => ({ state: "not_committed" as const }));
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor({ reconcile })))
    ).resolves.toEqual({
      type: "failed",
      errorCode: "SIDE_EFFECT_NOT_COMMITTED",
      toolExecutionId: "execution-1",
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(ledger.releaseClaim).toHaveBeenCalledWith({
      businessEffectId: "effect-1",
      expectedEffectState: "unknown",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "unknown",
      terminationCause: "failed_not_committed",
    });
  });

  it("reports persistence uncertainty when the not-committed release cannot be written", async () => {
    const ledger = createLedger();
    ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
    ]);
    const reconcile = vi.fn(async () => ({ state: "not_committed" as const }));
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor({ reconcile })))
    ).resolves.toEqual({
      type: "deferred",
      errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
      toolExecutionId: "execution-1",
    });
  });

  it("moves unknown back to prepared atomically before a reconciled retry", async () => {
    const ledger = createLedger();
    const executor = createExecutor([
      { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
      { type: "succeeded", result: { operationId: "operation-2" } },
    ]);
    const reconcile = vi.fn(async () => ({ state: "not_committed" as const }));
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor({ reconcile }), createBudget()))
    ).resolves.toMatchObject({ type: "succeeded" });
    expect(ledger.transitionBusinessEffectAndExecution).toHaveBeenLastCalledWith({
      businessEffectId: "effect-1",
      expectedEffectState: "unknown",
      nextEffectState: "prepared",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "unknown",
      nextExecutionStatus: "executing",
    });
  });

  describe("first submission against an existing effect", () => {
    const effect = {
      businessEffectId: "effect-1",
      scopeId: "scope-1",
      tenantId: "tenant-1",
      businessEffectKey: hashBusinessEffectKey("resource-1"),
    };

    it("reports the original when a committed result is reused", async () => {
      const ledger = createLedger();
      ledger.prepare.mockResolvedValueOnce({
        type: "existing_committed",
        businessEffect: { ...effect, commitState: "committed" },
        execution: { ...execution, status: "committed", resultRef: "result-ref-1" },
        originalExecutionId: "execution-original",
      });
      const executor = createExecutor([]);
      const runner = createRunner(ledger, createResultStore({
        resolve: vi.fn(async () => ({ operationId: "operation-original" })) as ResultReferenceStore["resolve"],
      }));

      await expect(
        runner.execute(runInput(executor, createDescriptor()))
      ).resolves.toEqual({
        type: "succeeded",
        source: "cache",
        result: { operationId: "operation-original" },
        toolExecutionId: "execution-1",
        reusedFrom: { businessEffectId: "effect-1", toolExecutionId: "execution-original" },
      });
      expect(executor.executeTyped).not.toHaveBeenCalled();
    });

    it.each([
      [{ commitState: "prepared" as const }, "in_flight_duplicate"],
      [{ commitState: "unknown" as const }, "original_outcome_unknown"],
    ])("marks a held-off submission as a duplicate (%o)", async (state, reason) => {
      const ledger = createLedger();
      ledger.prepare.mockResolvedValueOnce({
        type: "not_claimed",
        businessEffect: { ...effect, ...state },
        execution: { ...execution, status: "failed", claimDisposition: "not_claimed" },
      });
      const executor = createExecutor([]);
      const runner = createRunner(ledger, createResultStore());

      await expect(
        runner.execute(runInput(executor, createDescriptor()))
      ).resolves.toEqual({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
        toolExecutionId: "execution-1",
        duplicateOf: { reason, original: { businessEffectId: "effect-1" } },
      });
      expect(executor.executeTyped).not.toHaveBeenCalled();
    });

    it.each([
      [{ commitState: "compensated" as const }],
      [{ commitState: "prepared" as const, releasedAt: "2026-10-24T00:00:00.000Z" }],
    ])("does not mark a duplicate when the original is not holding the effect (%o)", async (state) => {
      const ledger = createLedger();
      ledger.prepare.mockResolvedValueOnce({
        type: "not_claimed",
        businessEffect: { ...effect, ...state },
        execution: { ...execution, status: "failed", claimDisposition: "not_claimed" },
      });
      const runner = createRunner(ledger, createResultStore());

      const result = await runner.execute(runInput(createExecutor([]), createDescriptor()));

      expect(result).toEqual({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
        toolExecutionId: "execution-1",
      });
    });

    it("never succeeds when a tool itself returns a deduplicated outcome", async () => {
      const ledger = createLedger();
      const runner = createRunner(ledger, createResultStore());

      const result = await runner.execute(
        runInput(
          createExecutor([
            {
              type: "deduplicated",
              reason: "in_flight_duplicate",
              original: { businessEffectId: "forged" },
            },
          ]),
          createDescriptor()
        )
      );

      expect(result.type).not.toBe("succeeded");
      expect(ledger.commitExecutionAndBusinessEffect).not.toHaveBeenCalled();
      expect(ledger.releaseClaim).not.toHaveBeenCalled();
    });
  });

  describe("replay of a submission that never claimed", () => {
    const notClaimed: ToolExecutionRecord = {
      ...execution,
      status: "failed",
      claimDisposition: "not_claimed",
    };
    const effect = {
      businessEffectId: "effect-1",
      scopeId: "scope-1",
      tenantId: "tenant-1",
      businessEffectKey: hashBusinessEffectKey("resource-1"),
    };

    it("reuses the original committed result", async () => {
      const ledger = createLedger();
      ledger.findExecutionByReplayKey.mockResolvedValueOnce(notClaimed);
      ledger.findBusinessEffectSnapshot.mockResolvedValueOnce({
        businessEffect: { ...effect, commitState: "committed" },
        committedExecution: {
          ...execution,
          toolExecutionId: "execution-original",
          status: "committed",
          resultRef: "result-ref-original",
        },
      });
      const resultStore = createResultStore({
        resolve: vi.fn(async () => ({ operationId: "operation-original" })) as ResultReferenceStore["resolve"],
      });
      const executor = createExecutor([]);
      const runner = createRunner(ledger, resultStore);

      await expect(
        runner.execute(runInput(executor, createDescriptor()))
      ).resolves.toEqual({
        type: "succeeded",
        source: "cache",
        result: { operationId: "operation-original" },
        toolExecutionId: "execution-original",
        reusedFrom: {
          businessEffectId: "effect-1",
          toolExecutionId: "execution-original",
        },
      });
      expect(executor.executeTyped).not.toHaveBeenCalled();
      expect(ledger.prepare).not.toHaveBeenCalled();
    });

    it.each([
      ["prepared", "in_flight_duplicate"],
      ["unknown", "original_outcome_unknown"],
    ] as const)(
      "stays a claim-not-acquired result while the original is %s",
      async (commitState, reason) => {
        const ledger = createLedger();
        ledger.findExecutionByReplayKey.mockResolvedValueOnce(notClaimed);
        ledger.findBusinessEffectSnapshot.mockResolvedValueOnce({
          businessEffect: { ...effect, commitState },
        });
        const runner = createRunner(ledger, createResultStore());

        await expect(
          runner.execute(runInput(createExecutor([]), createDescriptor()))
        ).resolves.toEqual({
          type: "deferred",
          errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
          toolExecutionId: "execution-1",
          duplicateOf: { reason, original: { businessEffectId: "effect-1" } },
        });
      }
    );

    it("is not a duplicate once the original effect was released", async () => {
      const ledger = createLedger();
      ledger.findExecutionByReplayKey.mockResolvedValueOnce(notClaimed);
      ledger.findBusinessEffectSnapshot.mockResolvedValueOnce({
        businessEffect: {
          ...effect,
          commitState: "prepared",
          releasedAt: "2026-10-24T00:00:00.000Z",
        },
      });
      const runner = createRunner(ledger, createResultStore());

      await expect(
        runner.execute(runInput(createExecutor([]), createDescriptor()))
      ).resolves.toEqual({
        type: "failed",
        errorCode: "SIDE_EFFECT_NOT_COMMITTED",
        toolExecutionId: "execution-1",
      });
    });

    it("reports the reused origin when a reusing submission is replayed", async () => {
      const ledger = createLedger();
      ledger.findExecutionByReplayKey.mockResolvedValueOnce({
        ...execution,
        status: "committed",
        resultRef: "result-ref-original",
        terminationCause: "deduplicated",
      });
      ledger.findBusinessEffectSnapshot.mockResolvedValueOnce({
        businessEffect: { ...effect, commitState: "committed" },
        committedExecution: {
          ...execution,
          toolExecutionId: "execution-original",
          status: "committed",
          resultRef: "result-ref-original",
        },
      });
      const runner = createRunner(ledger, createResultStore({
        resolve: vi.fn(async () => ({ operationId: "operation-original" })) as ResultReferenceStore["resolve"],
      }));

      await expect(
        runner.execute(runInput(createExecutor([]), createDescriptor()))
      ).resolves.toMatchObject({
        type: "succeeded",
        source: "cache",
        reusedFrom: { businessEffectId: "effect-1", toolExecutionId: "execution-original" },
      });
    });

    it("keeps the replay conflict when the request differs", async () => {
      const ledger = createLedger();
      ledger.findExecutionByReplayKey.mockResolvedValueOnce({
        ...notClaimed,
        requestHash: "other-request",
      });
      const runner = createRunner(ledger, createResultStore());

      await expect(
        runner.execute(runInput(createExecutor([]), createDescriptor()))
      ).resolves.toEqual({ type: "conflict", errorCode: "SIDE_EFFECT_REPLAY_CONFLICT" });
      expect(ledger.findBusinessEffectSnapshot).not.toHaveBeenCalled();
    });
  });
});

describe("ToolExecutionRunner reconciliation tasks", () => {
  function runnerWithTasks(open: ReconciliationTaskStore["open"], ledger: BusinessEffectLedger = createLedger()) {
    const auditLogger: AuditLogger = { record: vi.fn(async () => undefined) };
    const tasks = { open: vi.fn(open) };
    const runner = new ToolExecutionRunner(
      ledger,
      createResultStore(),
      { auditLogger, spanManager: createNoopSpanManager(), recordMetric: vi.fn(async () => undefined) },
      { wait: vi.fn(async () => undefined) },
      tasks
    );
    return { runner, tasks, auditLogger };
  }

  const unknownReconcile = vi.fn(async () => ({ state: "unknown" as const, reason: "LOOKUP_INDETERMINATE" }));
  const opened = async () => ({ reconciliationTaskId: "task-1", created: true });

  it("opens one task with the reconciler's reason when the outcome stays unknown", async () => {
    const { runner, tasks, auditLogger } = runnerWithTasks(opened);

    await expect(
      runner.execute(runInput(
        createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
        createDescriptor({ reconcile: unknownReconcile })
      ))
    ).resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED", toolExecutionId: "execution-1" });
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith({
      tenantId: "tenant-1",
      scopeId: "scope-1",
      businessEffectId: "effect-1",
      toolExecutionId: "execution-1",
      reasonCode: "LOOKUP_INDETERMINATE",
    });
    expect(auditLogger.record).toHaveBeenCalledWith(
      "tool.side_effect.reconciliation_task_opened",
      expect.objectContaining({ reconciliationTaskId: "task-1", created: true, reasonCode: "LOOKUP_INDETERMINATE" }),
      undefined
    );
  });

  it("uses the dispatch error as the reason when the tool declares no reconciler", async () => {
    const { runner, tasks } = runnerWithTasks(opened);

    await runner.execute(runInput(
      createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
      createDescriptor()
    ));

    expect(tasks.open).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "RESPONSE_LOST" }));
  });

  it("stays unknown and audits a typed failure when the task cannot be stored", async () => {
    const { runner, auditLogger } = runnerWithTasks(async () => {
      throw new Error("store down");
    });

    await expect(
      runner.execute(runInput(
        createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
        createDescriptor({ reconcile: unknownReconcile })
      ))
    ).resolves.toMatchObject({ type: "deferred", errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED" });
    expect(auditLogger.record).toHaveBeenCalledWith(
      "tool.side_effect.reconciliation_task_persistence_failed",
      expect.objectContaining({ errorCode: "RECONCILIATION_TASK_PERSISTENCE_FAILED", businessEffectId: "effect-1" }),
      undefined
    );
  });

  it.each([
    ["committed", { state: "committed" as const, result: { operationId: "reconciled" } }],
    ["not_committed", { state: "not_committed" as const }],
  ])("opens no task when reconciliation finds %s", async (_case, result) => {
    const { runner, tasks, auditLogger } = runnerWithTasks(opened);

    await runner.execute(runInput(
      createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
      createDescriptor({ reconcile: vi.fn(async () => result) })
    ));

    expect(tasks.open).not.toHaveBeenCalled();
    if (result.state === "committed") {
      expect(auditLogger.record).toHaveBeenCalledWith(
        "tool.side_effect.committed",
        expect.objectContaining({ source: "reconciled" }),
        undefined
      );
    }
  });

  it("opens no task for a committed result reused on replay", async () => {
    const { runner, tasks } = runnerWithTasks(opened);

    await runner.execute(runInput(
      createExecutor([{ type: "succeeded", result: { operationId: "operation-1" } }]),
      createDescriptor()
    ));

    expect(tasks.open).not.toHaveBeenCalled();
  });
});

describe("ToolExecutionRunner uncertain persistence after dispatch", () => {
  const opened = async () => ({ reconciliationTaskId: "task-1", created: true });
  const committedResult = { state: "committed" as const, result: { operationId: "operation-1" } };

  function runnerWith(ledger: ReturnType<typeof createLedger>, withTasks = true) {
    const auditLogger: AuditLogger = { record: vi.fn(async () => undefined) };
    const tasks = { open: vi.fn(opened) };
    const runner = new ToolExecutionRunner(
      ledger,
      createResultStore(),
      { auditLogger, spanManager: createNoopSpanManager(), recordMetric: vi.fn(async () => undefined) },
      { wait: vi.fn(async () => undefined) },
      withTasks ? tasks : undefined
    );
    return { runner, tasks };
  }

  const succeeded = () => createExecutor([{ type: "succeeded", result: { operationId: "operation-1" } }]);
  const throwingReconcile = vi.fn(async (): Promise<{ state: "unknown" }> => {
    throw new Error("lookup failed");
  });

  it("writes a committed result found by the reconciler when the attempt record failed", async () => {
    const ledger = createLedger();
    ledger.completeAttempt.mockRejectedValueOnce(new Error("ledger unavailable"));
    const reconcile = vi.fn(async () => committedResult);
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(succeeded(), createDescriptor({ reconcile }))))
      .resolves.toMatchObject({ type: "succeeded", source: "reconciled", result: { operationId: "operation-1" } });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledWith(
      expect.objectContaining({ expectedExecutionStatus: "executing", expectedEffectState: "prepared" })
    );
    expect(tasks.open).not.toHaveBeenCalled();
  });

  it("writes the committed result once more after a failed commit write", async () => {
    const ledger = createLedger();
    ledger.commitExecutionAndBusinessEffect.mockRejectedValueOnce(new Error("commit response lost"));
    const executor = succeeded();
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(executor, createDescriptor({ reconcile: vi.fn(async () => committedResult) }))))
      .resolves.toMatchObject({ type: "succeeded", source: "reconciled" });
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledTimes(2);
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(tasks.open).not.toHaveBeenCalled();
  });

  it("stays unknown with a task when the committed result cannot be written again", async () => {
    const ledger = createLedger();
    ledger.commitExecutionAndBusinessEffect.mockRejectedValue(new Error("ledger down"));
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(succeeded(), createDescriptor({ reconcile: vi.fn(async () => committedResult) }))))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(ledger.commitExecutionAndBusinessEffect).toHaveBeenCalledTimes(2);
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" }));
  });

  it("releases the claim when the reconciler confirms not committed after the unknown mark failed", async () => {
    const ledger = createLedger();
    ledger.transitionBusinessEffectAndExecution.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]);
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(
      executor,
      createDescriptor({ reconcile: vi.fn(async () => ({ state: "not_committed" as const })) }),
      createBudget(3)
    ))).resolves.toEqual({ type: "failed", errorCode: "SIDE_EFFECT_NOT_COMMITTED", toolExecutionId: "execution-1" });
    expect(ledger.releaseClaim).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEffectState: "prepared", expectedExecutionStatus: "executing", terminationCause: "failed_not_committed" })
    );
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(tasks.open).not.toHaveBeenCalled();
  });

  it.each([
    ["the release cannot be written", { state: "not_committed" as const }, true, "SIDE_EFFECT_PERSISTENCE_UNCERTAIN"],
    ["the reconciler cannot decide", { state: "unknown" as const, reason: "LOOKUP_INDETERMINATE" }, false, "LOOKUP_INDETERMINATE"],
  ])("stays unknown with a task when %s", async (_case, result, releaseFails, reasonCode) => {
    const ledger = createLedger();
    ledger.completeAttempt.mockRejectedValueOnce(new Error("ledger unavailable"));
    if (releaseFails) ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(succeeded(), createDescriptor({ reconcile: vi.fn(async () => result) }))))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reasonCode }));
  });

  it.each([
    ["throws", createDescriptor({ reconcile: throwingReconcile })],
    ["is not declared", createDescriptor()],
  ])("stays unknown with a task when the reconciler %s", async (_case, descriptor) => {
    const ledger = createLedger();
    ledger.completeAttempt.mockRejectedValueOnce(new Error("ledger unavailable"));
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(succeeded(), descriptor)))
      .resolves.toMatchObject({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" });
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" }));
  });

  it("opens a task for failed writes after an earlier reconciliation", async () => {
    const first = runnerWith(createLedger());
    await expect(first.runner.execute(runInput(
      createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
      createDescriptor({ reconcile: vi.fn(async () => ({ state: "committed" as const })) })
    ))).resolves.toMatchObject({ errorCode: "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE" });
    expect(first.tasks.open).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE" }));

    const releaseFails = createLedger();
    releaseFails.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const second = runnerWith(releaseFails);
    await expect(second.runner.execute(runInput(
      createExecutor([{ type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" }]),
      createDescriptor({ reconcile: vi.fn(async () => ({ state: "not_committed" as const })) })
    ))).resolves.toMatchObject({ errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" });
    expect(second.tasks.open).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN" }));
  });

  it.each([
    ["failed not committed", { type: "failed_not_committed" as const, errorCode: "ORDER_NOT_FOUND" }],
    ["rejected before dispatch", { type: "rejected_before_dispatch" as const, errorCode: "TOOL_INPUT_INVALID" }],
    ["cancelled before dispatch", { type: "cancelled" as const, dispatchState: "before" as const }],
  ])("stays uncertain with a task when the release after %s cannot be written", async (_case, outcome) => {
    const ledger = createLedger();
    ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([outcome]);
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(executor, createDescriptor())))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(ledger.releaseClaim).toHaveBeenCalledOnce();
    expect(executor.executeTyped).toHaveBeenCalledOnce();
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      businessEffectId: "effect-1",
      toolExecutionId: "execution-1",
      reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
    }));
  });

  it("stays uncertain without a task when a failed release has no task opt-in", async () => {
    const ledger = createLedger();
    ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const { runner, tasks } = runnerWith(ledger, false);

    await expect(runner.execute(runInput(
      createExecutor([{ type: "failed_not_committed", errorCode: "ORDER_NOT_FOUND" }]),
      createDescriptor()
    ))).resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(tasks.open).not.toHaveBeenCalled();
  });

  it("keeps the ledger-unavailable deferral when the claim is released before dispatch", async () => {
    const ledger = createLedger();
    ledger.transitionExecution.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([]);
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(executor, createDescriptor())))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE", toolExecutionId: "execution-1" });
    expect(ledger.releaseClaim).toHaveBeenCalledOnce();
    expect(executor.executeTyped).not.toHaveBeenCalled();
    expect(tasks.open).not.toHaveBeenCalled();
  });

  it("stays uncertain with a task when the pre-dispatch release after a failed start cannot be written", async () => {
    const ledger = createLedger();
    ledger.transitionExecution.mockRejectedValueOnce(new Error("ledger unavailable"));
    ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createExecutor([]);
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(executor, createDescriptor())))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(executor.executeTyped).not.toHaveBeenCalled();
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      businessEffectId: "effect-1",
      reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
    }));
  });

  it("stays uncertain with a task when the release after a failed decision link cannot be written", async () => {
    const ledger = createLedger();
    ledger.linkAuthorizationDecision.mockRejectedValueOnce(new Error("ledger unavailable"));
    ledger.releaseClaim.mockRejectedValueOnce(new Error("ledger unavailable"));
    const executor = createPreflightExecutor(
      [{ type: "authorized", decisionId: "decision-approved" }],
      [{ type: "succeeded", result: { operationId: "operation-1" } }]
    );
    const { runner, tasks } = runnerWith(ledger);

    await expect(runner.execute(runInput(executor, createDescriptor())))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
    expect(tasks.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      reasonCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
    }));
  });

  it("keeps the previous result and never reconciles without the opt-in", async () => {
    const ledger = createLedger();
    ledger.completeAttempt.mockRejectedValueOnce(new Error("ledger unavailable"));
    const reconcile = vi.fn(async () => committedResult);
    const { runner } = runnerWith(ledger, false);

    await expect(runner.execute(runInput(succeeded(), createDescriptor({ reconcile }))))
      .resolves.toEqual({ type: "deferred", errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN", toolExecutionId: "execution-1" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(ledger.commitExecutionAndBusinessEffect).not.toHaveBeenCalled();
  });
});
