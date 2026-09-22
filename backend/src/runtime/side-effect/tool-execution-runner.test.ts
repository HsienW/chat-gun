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
  observability: Partial<ToolExecutionRunnerObservability> = {}
) {
  const auditLogger: AuditLogger = { record: vi.fn(async () => undefined) };
  return new ToolExecutionRunner(ledger, resultStore, {
    auditLogger,
    spanManager: createNoopSpanManager(),
    recordMetric: vi.fn(async () => undefined),
    ...observability,
  });
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
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
    });
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
          toolExecutionId: "execution-1",
        }),
      })
    );
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
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(
        runInput(executor, createDescriptor(), createBudget(3))
      )
    ).resolves.toEqual({
      type: "failed",
      errorCode: "MISSING_ROLE_SCOPE_GRANT",
      toolExecutionId: "execution-1",
      decisionId: "decision-deny",
    });
    expect(ledger.recordAttempt).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
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
      toolExecutionId: "execution-1",
      decisionId: "decision-confirm",
    });
    expect(ledger.recordAttempt).not.toHaveBeenCalled();
    expect(executor.executeAuthorizedTyped).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when authorization omits decisionId", async () => {
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
      toolExecutionId: "execution-1",
    });
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
      [{ type: "failed_not_committed", errorCode: "PROVIDER_REJECTED" }]
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
    const runner = createRunner(ledger, createResultStore());

    await expect(
      runner.execute(runInput(executor, createDescriptor({ reconcile })))
    ).resolves.toMatchObject({
      type: "succeeded",
      source: "reconciled",
      result: { operationId: "reconciled" },
    });
    expect(executor.executeTyped).toHaveBeenCalledOnce();
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

  it("does not redispatch when the atomic ledger commit fails after downstream success", async () => {
    const ledger = createLedger();
    ledger.commitExecutionAndBusinessEffect.mockRejectedValueOnce(
      new Error("commit response lost")
    );
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
