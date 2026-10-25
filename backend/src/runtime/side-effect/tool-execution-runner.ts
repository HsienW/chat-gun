import { randomUUID } from "node:crypto";

import {
  auditLogger as defaultAuditLogger,
  recordMetric as defaultRecordMetric,
  type AuditLogger,
} from "../../platform/observability.js";
import {
  getSpanManager,
  type SpanManager,
} from "../../platform/tracing/span-manager.js";
import { executionContextSchema, type ExecutionContext } from "../execution-context/execution-context.js";
import { withExecutionContext } from "../execution-context/read-execution-context.js";
import {
  checkBudget,
  recordAttempt as recordBudgetAttempt,
  type RetryBudget,
} from "../retry/retry-budget.js";
import { computeBackoff } from "../retry/backoff.js";
import { classifyError } from "../retry/error-classification.js";
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "../retry/retry-policy.js";
import type {
  BusinessEffectLedger,
  BusinessEffectRecord,
  PrepareSideEffectResult,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from "./business-effect-ledger.js";
import {
  getToolExecutionTerminationCause,
  type DeduplicatedOriginal,
  type DeduplicationReason,
  type GovernedToolExecutor,
  type GovernedToolOutcome,
  type ToolExecutionTerminationCause,
} from "./governed-outcome.js";
import {
  createReplayKey,
  createToolExecutionAttemptIdentity,
  hashBusinessEffectKey,
  type ReplayIdentityInput,
  type TrustedScope,
} from "./identity.js";
import { decideReconciliationAction } from "./reconciler.js";
import type { ReconciliationTaskStore } from "./reconciliation-task-store.js";
import type { ResultReferenceStore } from "./result-reference-store.js";
import type { ReconciliationResult, SideEffectToolDescriptor } from "./side-effect-descriptor.js";
import type { ExecutionProfileEvidence } from "../tool-dispatch/execution-profile.js";

export type ToolExecutionRunResult<TResult> =
  | {
      type: "succeeded";
      source: "live" | "cache" | "reconciled";
      result: TResult;
      toolExecutionId?: string;
      /** Set when a committed result of another submission was reused. */
      reusedFrom?: DeduplicatedOriginal;
    }
  | { type: "conflict"; errorCode: "SIDE_EFFECT_REPLAY_CONFLICT" }
  | {
      type: "deferred";
      errorCode:
        | "SIDE_EFFECT_LEDGER_UNAVAILABLE"
        | "SIDE_EFFECT_CLAIM_NOT_ACQUIRED"
        | "SIDE_EFFECT_RESULT_NOT_REUSABLE"
        | "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE"
        | "SIDE_EFFECT_RECONCILIATION_REQUIRED"
        | "SIDE_EFFECT_PERSISTENCE_UNCERTAIN"
        | "SIDE_EFFECT_OUTPUT_VALIDATION_FAILED";
      toolExecutionId?: string;
      /** Set when the claim was not acquired because the same effect is held. */
      duplicateOf?: {
        reason: Exclude<DeduplicationReason, "committed_result_reused">;
        original: DeduplicatedOriginal;
      };
    }
  | {
      type: "failed";
      errorCode: string;
      toolExecutionId?: string;
      decisionId?: string;
    }
  | {
      type: "cancelled";
      dispatchState: "before" | "after" | "unknown";
      toolExecutionId?: string;
    };

export interface ToolExecutionRunInput<TInput, TResult> {
  executionContext?: ExecutionContext;
  identity: ReplayIdentityInput;
  requestHash: string;
  scope: TrustedScope;
  input: TInput;
  executor: GovernedToolExecutor<TInput, TResult>;
  descriptor?: SideEffectToolDescriptor<TInput, TResult>;
  retryBudget?: RetryBudget;
  retryPolicy?: RetryPolicy;
  retryAfterMaxMs: number;
  validateResult?: (result: TResult) => boolean;
  signal?: AbortSignal;
  requestId?: string;
  threadId?: string;
  taskId?: string;
  securityEvidence?: ExecutionProfileEvidence;
}

export interface ToolExecutionRunnerObservability {
  auditLogger: AuditLogger;
  spanManager: SpanManager;
  recordMetric(
    name: string,
    payload: Record<string, unknown>,
    context?: ExecutionContext
  ): Promise<void> | void;
}

export interface ToolExecutionRunnerTiming {
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

const defaultObservability: ToolExecutionRunnerObservability = {
  auditLogger: defaultAuditLogger,
  spanManager: getSpanManager(),
  recordMetric: defaultRecordMetric,
};

const defaultTiming: ToolExecutionRunnerTiming = {
  wait: waitForBackoff,
};

async function waitForBackoff(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("USER_CANCELLED");
  }
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("USER_CANCELLED"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Only the runtime produces deduplicated outcomes; a tool returning one breaks
// the executor contract and is treated as a failure, never as success.
const UNEXPECTED_DEDUPLICATED_OUTCOME = "TOOL_UNEXPECTED_DEDUPLICATED_OUTCOME";

function errorCodeOf<TResult>(
  outcome: Exclude<GovernedToolOutcome<TResult>, { type: "succeeded" | "cancelled" }>
): string {
  if (outcome.type === "deduplicated") return UNEXPECTED_DEDUPLICATED_OUTCOME;
  return outcome.type === "confirmation_required"
    ? "REQUIRES_CONFIRMATION"
    : outcome.errorCode;
}

function dispatchStateOf<TResult>(
  outcome: GovernedToolOutcome<TResult>
): "before" | "after" | "unknown" {
  if (
    outcome.type === "rejected_before_dispatch" ||
    outcome.type === "denied_by_authorization" ||
    outcome.type === "confirmation_required"
  ) {
    return "before";
  }
  if (outcome.type === "cancelled") return outcome.dispatchState;
  return "after";
}

const PERSISTENCE_UNCERTAIN = "SIDE_EFFECT_PERSISTENCE_UNCERTAIN";

function isPersistenceUncertain<TResult>(result: ToolExecutionRunResult<TResult>): boolean {
  return result.type === "deferred" && result.errorCode === PERSISTENCE_UNCERTAIN;
}

function outcomeErrorCode<TResult>(
  outcome: GovernedToolOutcome<TResult>
): string | undefined {
  if (outcome.type === "confirmation_required") return "REQUIRES_CONFIRMATION";
  if (outcome.type === "deduplicated") return UNEXPECTED_DEDUPLICATED_OUTCOME;
  return outcome.type === "succeeded" || outcome.type === "cancelled"
    ? undefined
    : outcome.errorCode;
}

/**
 * A submission held off by the same business effect. The duplicate reason is
 * attached only while the original is in flight or has an unknown outcome.
 */
function claimNotAcquired<TResult>(
  toolExecutionId: string,
  original?: BusinessEffectRecord
): ToolExecutionRunResult<TResult> {
  const reason =
    original?.commitState === "prepared" && original.releasedAt === undefined
      ? "in_flight_duplicate"
      : original?.commitState === "unknown"
        ? "original_outcome_unknown"
        : undefined;
  return {
    type: "deferred",
    errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
    toolExecutionId,
    ...(reason && original
      ? {
          duplicateOf: {
            reason,
            original: { businessEffectId: original.businessEffectId },
          },
        }
      : {}),
  };
}

function assertDescriptorMatchesIdentity<TInput, TResult>(
  descriptor: SideEffectToolDescriptor<TInput, TResult>,
  identity: ReplayIdentityInput
): void {
  if (
    descriptor.toolName !== identity.toolName ||
    descriptor.toolVersion !== identity.toolVersion
  ) {
    throw new Error("Side-effect descriptor does not match tool identity");
  }
}

function isResultValid<TResult>(
  validator: ((result: TResult) => boolean) | undefined,
  result: TResult
): boolean {
  if (validator === undefined) {
    return true;
  }
  try {
    return validator(result);
  } catch {
    return false;
  }
}

async function ignoreObservabilityFailure(
  operation: () => Promise<void> | void
): Promise<void> {
  try {
    await operation();
  } catch {
    // Export failures must not rewrite or erase the durable execution outcome.
  }
}

export class ToolExecutionRunner {
  private readonly observability: ToolExecutionRunnerObservability;

  constructor(
    private readonly ledger: BusinessEffectLedger,
    private readonly resultStore: ResultReferenceStore,
    observability: Partial<ToolExecutionRunnerObservability> = {},
    private readonly timing: ToolExecutionRunnerTiming = defaultTiming,
    /** Opt-in: an outcome that stays unknown after reconciliation opens a durable task. */
    private readonly reconciliationTasks?: ReconciliationTaskStore
  ) {
    this.observability = { ...defaultObservability, ...observability };
  }

  async execute<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>
  ): Promise<ToolExecutionRunResult<TResult>> {
    if (input.executionContext) {
      const context = executionContextSchema.parse(input.executionContext);
      if (
        context.runId !== input.identity.runId ||
        (context.stepId !== undefined && context.stepId !== input.identity.stepId) ||
        context.scope.scopeId !== input.scope.scopeId ||
        context.scope.tenantId !== input.scope.tenantId ||
        context.principal.principalId !== input.scope.principalId
      ) {
        throw new Error("Tool execution identity conflicts with ExecutionContext");
      }
      input = {
        ...input,
        executionContext: context,
        requestId: context.requestId,
        threadId: context.threadId,
        taskId: context.taskId,
      };
    }
    if (!input.descriptor) {
      return this.executeReadOnly(input);
    }
    const descriptor = input.descriptor;
    assertDescriptorMatchesIdentity(descriptor, input.identity);
    const sideEffectInput = { ...input, descriptor };
    const replayKey = createReplayKey(input.identity);
    return this.observability.spanManager.withSpan(
      "side_effect.tool_execution",
      {
        attributes: {
          "tool.name": input.identity.toolName,
          "tool.version": input.identity.toolVersion,
          "tool.replay_key": replayKey,
          "run.id": input.identity.runId,
          "step.id": input.identity.stepId,
          ...(input.requestId ? { "request.id": input.requestId } : {}),
          ...(input.threadId ? { "thread.id": input.threadId } : {}),
        },
      },
      () => this.executeSideEffect(sideEffectInput, replayKey)
    );
  }

  private async executeReadOnly<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>
  ): Promise<ToolExecutionRunResult<TResult>> {
    const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
    let retryBudget = input.retryBudget;

    while (true) {
      if (input.signal?.aborted) {
        return { type: "failed", errorCode: "USER_CANCELLED" };
      }
      const executionStartedAt = performance.now();
      let outcome: GovernedToolOutcome<TResult>;
      try {
        outcome = await input.executor.executeTyped(input.input, {
          signal: input.signal,
        });
      } finally {
        await this.recordLatency(
          "tool.execution",
          executionStartedAt,
          input
        );
      }
      if (retryBudget) {
        retryBudget = recordBudgetAttempt(retryBudget);
      }
      if (outcome.type === "succeeded") {
        return { type: "succeeded", source: "live", result: outcome.result };
      }
      if (outcome.type === "cancelled") {
        return { type: "cancelled", dispatchState: outcome.dispatchState };
      }

      const errorCode = errorCodeOf(outcome);
      const classifiedError = classifyError({ code: errorCode, message: errorCode });
      const budgetCheck = retryBudget
        ? checkBudget(retryBudget, input.signal)
        : undefined;
      const canRetry =
        classifiedError.retryable &&
        retryPolicy.retryableCategories.includes(classifiedError.category) &&
        budgetCheck?.canRetry === true;
      if (!canRetry) {
        return {
          type: "failed",
          errorCode:
            budgetCheck?.reason === "cancelled" ? "USER_CANCELLED" : errorCode,
        };
      }

      const didWait = await this.waitBeforeRetry(
        input,
        retryPolicy,
        retryBudget?.attempts ?? 1,
        outcome.type === "failed_not_committed"
          ? normalizeRetryAfterMs(outcome.retryAfterMs)
          : undefined
      );
      if (!didWait) {
        return { type: "failed", errorCode: "USER_CANCELLED" };
      }
    }
  }

  private async executeSideEffect<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    replayKey: ReturnType<typeof createReplayKey>
  ): Promise<ToolExecutionRunResult<TResult>> {
    let existingExecution: ToolExecutionRecord | null;
    try {
      existingExecution = await this.ledger.findExecutionByReplayKey(replayKey);
    } catch {
      return { type: "deferred", errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE" };
    }
    if (existingExecution) {
      return this.resolveExistingExecution(existingExecution, input);
    }

    // Authorization and cancellation are settled before the claim so that a
    // rejected or cancelled call never leaves a business effect behind.
    const preauthorization = await this.authorizeBeforeClaim(input);
    if (preauthorization.type === "rejected") {
      return preauthorization.result;
    }
    if (input.signal?.aborted) {
      return { type: "cancelled", dispatchState: "before" };
    }

    const businessEffectKey = hashBusinessEffectKey(
      input.descriptor.deriveBusinessEffectKey(input.input, input.scope)
    );
    const prepareResult = await this.ledger.prepare({
      businessEffectId: randomUUID(),
      toolExecutionId: randomUUID(),
      businessEffectKey,
      scope: input.scope,
      replayKey,
      requestHash: input.requestHash,
      ...(input.securityEvidence ? { securityEvidence: input.securityEvidence } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      runId: input.identity.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      stepId: input.identity.stepId,
      callIndex: input.identity.callIndex,
      toolName: input.descriptor.toolName,
      toolVersion: input.descriptor.toolVersion,
    });
    if (prepareResult.type === "unavailable") {
      return { type: "deferred", errorCode: prepareResult.errorCode };
    }
    if (prepareResult.type === "conflict") {
      return { type: "conflict", errorCode: "SIDE_EFFECT_REPLAY_CONFLICT" };
    }
    if (prepareResult.type === "existing_committed") {
      return this.resolvePreparedCommitted(prepareResult, input);
    }
    if (prepareResult.type === "not_claimed") {
      return claimNotAcquired(
        prepareResult.execution.toolExecutionId,
        prepareResult.businessEffect
      );
    }

    const correlation = {
      requestId: input.requestId,
      threadId: input.threadId,
      runId: input.identity.runId,
      replayKey,
      businessEffectKey,
      toolExecutionId: prepareResult.execution.toolExecutionId,
    };
    await ignoreObservabilityFailure(() =>
      this.observability.auditLogger.record(
        "tool.side_effect.prepared",
        {
          resourceType: "tool_execution",
          resourceId: prepareResult.execution.toolExecutionId,
          ...correlation,
        },
        input.executionContext
      )
    );
    try {
      await this.ledger.transitionExecution({
        toolExecutionId: prepareResult.execution.toolExecutionId,
        expectedStatus: "prepared",
        nextStatus: "executing",
      });
    } catch {
      await this.releaseOrFalse(
        prepareResult.execution.toolExecutionId,
        prepareResult.businessEffect.businessEffectId,
        "prepared",
        "rejected_before_dispatch"
      );
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
        toolExecutionId: prepareResult.execution.toolExecutionId,
      };
    }
    if (preauthorization.type === "authorized") {
      try {
        await this.ledger.linkAuthorizationDecision({
          toolExecutionId: prepareResult.execution.toolExecutionId,
          decisionId: preauthorization.decisionId,
        });
      } catch {
        await this.releaseOrFalse(
          prepareResult.execution.toolExecutionId,
          prepareResult.businessEffect.businessEffectId,
          "executing",
          "rejected_before_dispatch"
        );
        return {
          type: "deferred",
          errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
          toolExecutionId: prepareResult.execution.toolExecutionId,
        };
      }
    }

    return this.observability.spanManager.withSpan(
      "side_effect.tool_execution.claimed",
      {
        attributes: {
          "tool.execution_id": prepareResult.execution.toolExecutionId,
          "tool.replay_key": replayKey,
          "business_effect.key": businessEffectKey,
          "run.id": input.identity.runId,
          "step.id": input.identity.stepId,
        },
      },
      () => this.dispatchAttempts(input, prepareResult, businessEffectKey)
    );
  }

  private async resolveExistingExecution<TInput, TResult>(
    execution: ToolExecutionRecord,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    }
  ): Promise<ToolExecutionRunResult<TResult>> {
    if (execution.requestHash !== input.requestHash) {
      return { type: "conflict", errorCode: "SIDE_EFFECT_REPLAY_CONFLICT" };
    }
    if (execution.claimDisposition === "not_claimed") {
      return this.resolveNotClaimedReplay(execution, input);
    }
    if (execution.status !== "committed") {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    if (
      execution.terminationCause === "deduplicated" &&
      execution.businessEffectId !== undefined
    ) {
      // Replay of a submission that reused another submission's result.
      const snapshot = await this.ledger
        .findBusinessEffectSnapshot(execution.businessEffectId)
        .catch(() => null);
      return this.resolveCommittedResult(execution, input, "cache", {
        businessEffectId: execution.businessEffectId,
        ...(snapshot?.committedExecution
          ? { toolExecutionId: snapshot.committedExecution.toolExecutionId }
          : {}),
      });
    }
    return this.resolveCommittedResult(execution, input, "cache");
  }

  /**
   * A replayed submission that never claimed its effect is answered from the
   * original effect's current state; it never triggers reconciliation.
   */
  private async resolveNotClaimedReplay<TInput, TResult>(
    execution: ToolExecutionRecord,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    }
  ): Promise<ToolExecutionRunResult<TResult>> {
    if (execution.businessEffectId === undefined) {
      return claimNotAcquired(execution.toolExecutionId);
    }
    let snapshot;
    try {
      snapshot = await this.ledger.findBusinessEffectSnapshot(
        execution.businessEffectId
      );
    } catch {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    if (snapshot?.committedExecution) {
      return this.resolveCommittedResult(
        snapshot.committedExecution,
        input,
        "cache",
        {
          businessEffectId: snapshot.businessEffect.businessEffectId,
          toolExecutionId: snapshot.committedExecution.toolExecutionId,
        }
      );
    }
    if (
      snapshot?.businessEffect.commitState === "prepared" &&
      snapshot.businessEffect.releasedAt !== undefined
    ) {
      return {
        type: "failed",
        errorCode: "SIDE_EFFECT_NOT_COMMITTED",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    return claimNotAcquired(execution.toolExecutionId, snapshot?.businessEffect);
  }

  private async authorizeBeforeClaim<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>
  ): Promise<
    | { type: "not_required" }
    | { type: "authorized"; decisionId: string }
    | { type: "rejected"; result: ToolExecutionRunResult<TResult> }
  > {
    if (input.executor.authorizeTyped === undefined) {
      return { type: "not_required" };
    }
    const unavailable = {
      type: "rejected" as const,
      result: { type: "failed" as const, errorCode: "AUTHORIZATION_UNAVAILABLE" },
    };
    if (input.executor.executeAuthorizedTyped === undefined) {
      return unavailable;
    }
    let authorizationOutcome;
    const authorizationStartedAt = performance.now();
    try {
      authorizationOutcome = await input.executor.authorizeTyped(
        input.input,
        this.createExecutionConfig(input)
      );
    } catch {
      return unavailable;
    } finally {
      await this.recordLatency(
        "tool.authorization.wait",
        authorizationStartedAt,
        input
      );
    }
    if (authorizationOutcome.decisionId === undefined) {
      return unavailable;
    }
    if (authorizationOutcome.type === "denied_by_authorization") {
      return {
        type: "rejected",
        result: {
          type: "failed",
          errorCode: authorizationOutcome.errorCode,
          decisionId: authorizationOutcome.decisionId,
        },
      };
    }
    if (authorizationOutcome.type === "confirmation_required") {
      return {
        type: "rejected",
        result: {
          type: "failed",
          errorCode: "REQUIRES_CONFIRMATION",
          decisionId: authorizationOutcome.decisionId,
        },
      };
    }
    return { type: "authorized", decisionId: authorizationOutcome.decisionId };
  }

  private createExecutionConfig<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>,
    toolExecutionId?: string
  ) {
    const toolCallId = input.identity.logicalToolCallId ?? input.identity.toolCallId;
    const legacyExecutionConfig = {
      signal: input.signal,
      configurable: {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        runId: input.identity.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        stepId: input.identity.stepId,
        ...(toolExecutionId ? { toolExecutionId } : {}),
        toolCallId,
      },
    };
    return input.executionContext
      ? withExecutionContext(legacyExecutionConfig, {
          ...input.executionContext,
          stepId: input.identity.stepId,
          ...(toolExecutionId ? { toolExecutionId } : {}),
          toolCallId,
        })
      : legacyExecutionConfig;
  }

  private resolvePreparedCommitted<TInput, TResult>(
    prepareResult: Extract<PrepareSideEffectResult, { type: "existing_committed" }>,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    }
  ): Promise<ToolExecutionRunResult<TResult>> {
    return this.resolveCommittedResult(prepareResult.execution, input, "cache", {
      businessEffectId: prepareResult.businessEffect.businessEffectId,
      ...(prepareResult.originalExecutionId
        ? { toolExecutionId: prepareResult.originalExecutionId }
        : {}),
    });
  }

  private async resolveCommittedResult<TInput, TResult>(
    execution: ToolExecutionRecord,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    source: "cache" | "reconciled",
    reusedFrom?: DeduplicatedOriginal
  ): Promise<ToolExecutionRunResult<TResult>> {
    if (!execution.resultRef) {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    const result = await this.resultStore.resolve({
      resultRefId: execution.resultRef,
      policy: input.descriptor.resultReferencePolicy,
      scope: input.scope,
      toolVersion: input.descriptor.toolVersion,
    });
    if (result === null) {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_RESULT_NOT_REUSABLE",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    return isResultValid(input.validateResult, result)
      ? {
          type: "succeeded",
          source,
          result,
          toolExecutionId: execution.toolExecutionId,
          ...(reusedFrom ? { reusedFrom } : {}),
        }
      : {
          type: "deferred",
          errorCode: "SIDE_EFFECT_OUTPUT_VALIDATION_FAILED",
          toolExecutionId: execution.toolExecutionId,
        };
  }

  private async dispatchAttempts<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    prepareResult: Extract<PrepareSideEffectResult, { type: "claimed" }>,
    businessEffectKey: ReturnType<typeof hashBusinessEffectKey>
  ): Promise<ToolExecutionRunResult<TResult>> {
    const toolExecutionId = prepareResult.execution.toolExecutionId;
    const businessEffectId = prepareResult.businessEffect.businessEffectId;
    let executionAttempt = 0;
    let retryBudget = input.retryBudget;

    // Every exit that is definitely not committed releases the claim here.
    const release = async (
      result: ToolExecutionRunResult<TResult>,
      terminationCause: ToolExecutionTerminationCause,
      expectedStatus: ToolExecutionStatus = "executing"
    ): Promise<ToolExecutionRunResult<TResult>> => {
      await this.releaseOrFalse(
        toolExecutionId,
        businessEffectId,
        expectedStatus,
        terminationCause
      );
      return result;
    };

    while (true) {
      const executionConfig = this.createExecutionConfig(input, toolExecutionId);
      let executeAttempt = input.executor.executeTyped.bind(input.executor);
      if (
        input.executor.authorizeTyped !== undefined &&
        input.executor.executeAuthorizedTyped !== undefined
      ) {
        // The first attempt was authorized before the claim; retries
        // re-authorize because the decision may have changed meanwhile.
        if (executionAttempt > 0) {
          let authorizationOutcome;
          const authorizationStartedAt = performance.now();
          try {
            authorizationOutcome = await input.executor.authorizeTyped(
              input.input,
              executionConfig
            );
          } catch {
            return release(
              { type: "failed", errorCode: "AUTHORIZATION_UNAVAILABLE", toolExecutionId },
              "failed_not_committed"
            );
          } finally {
            await this.recordLatency(
              "tool.authorization.wait",
              authorizationStartedAt,
              input
            );
          }

          if (authorizationOutcome.decisionId === undefined) {
            return release(
              { type: "failed", errorCode: "AUTHORIZATION_UNAVAILABLE", toolExecutionId },
              "failed_not_committed"
            );
          }
          try {
            await this.ledger.linkAuthorizationDecision({
              toolExecutionId,
              decisionId: authorizationOutcome.decisionId,
            });
          } catch {
            return release(
              {
                type: "deferred",
                errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
                toolExecutionId,
              },
              "rejected_before_dispatch"
            );
          }
          if (authorizationOutcome.type === "denied_by_authorization") {
            return release(
              {
                type: "failed",
                errorCode: authorizationOutcome.errorCode,
                toolExecutionId,
                decisionId: authorizationOutcome.decisionId,
              },
              getToolExecutionTerminationCause(authorizationOutcome)
            );
          }
          if (authorizationOutcome.type === "confirmation_required") {
            return release(
              {
                type: "failed",
                errorCode: "REQUIRES_CONFIRMATION",
                toolExecutionId,
                decisionId: authorizationOutcome.decisionId,
              },
              getToolExecutionTerminationCause(authorizationOutcome)
            );
          }
        }
        executeAttempt = input.executor.executeAuthorizedTyped.bind(
          input.executor
        );
      }

      executionAttempt += 1;
      if (retryBudget) retryBudget = recordBudgetAttempt(retryBudget);
      const attemptIdentity = createToolExecutionAttemptIdentity({
        toolExecutionId,
        executionAttempt,
      });
      try {
        await this.ledger.recordAttempt(attemptIdentity);
      } catch {
        return release(
          {
            type: "deferred",
            errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
            toolExecutionId,
          },
          "rejected_before_dispatch"
        );
      }

      const executionStartedAt = performance.now();
      let outcome: GovernedToolOutcome<TResult>;
      try {
        outcome = await executeAttempt(input.input, executionConfig);
      } finally {
        await this.recordLatency(
          "tool.execution",
          executionStartedAt,
          input
        );
      }
      try {
        await this.ledger.completeAttempt({
          toolExecutionAttemptId: attemptIdentity.toolExecutionAttemptId,
          outcome: outcome.type,
          dispatchState: dispatchStateOf(outcome),
          ...(outcomeErrorCode(outcome)
            ? { errorCode: outcomeErrorCode(outcome) }
            : {}),
        });
      } catch {
        return this.recoverUncertainPersistence(
          input,
          toolExecutionId,
          businessEffectId,
          businessEffectKey,
          "executing",
          "prepared"
        );
      }

      const metric = {
        toolName: input.descriptor.toolName,
        outcomeType: outcome.type,
        count: 1,
      };
      await ignoreObservabilityFailure(() =>
        input.executionContext
          ? this.observability.recordMetric(
              "tool.side_effect.outcome",
              metric,
              input.executionContext
            )
          : this.observability.recordMetric("tool.side_effect.outcome", metric)
      );
      if (outcome.type === "succeeded") {
        const committed = await this.persistCommittedResult(
          input,
          toolExecutionId,
          businessEffectId,
          "executing",
          "prepared",
          outcome.result,
          "live"
        );
        return isPersistenceUncertain(committed)
          ? this.recoverUncertainPersistence(
              input,
              toolExecutionId,
              businessEffectId,
              businessEffectKey,
              "executing",
              "prepared"
            )
          : committed;
      }
      if (outcome.type === "rejected_before_dispatch") {
        return release(
          { type: "failed", errorCode: outcome.errorCode, toolExecutionId },
          getToolExecutionTerminationCause(outcome)
        );
      }
      if (outcome.type === "denied_by_authorization") {
        return release(
          {
            type: "failed",
            errorCode: outcome.errorCode,
            toolExecutionId,
            decisionId: outcome.decisionId,
          },
          getToolExecutionTerminationCause(outcome)
        );
      }
      if (outcome.type === "confirmation_required") {
        return release(
          {
            type: "failed",
            errorCode: "REQUIRES_CONFIRMATION",
            toolExecutionId,
            decisionId: outcome.decisionId,
          },
          getToolExecutionTerminationCause(outcome)
        );
      }
      if (outcome.type === "failed_not_committed") {
        const classifiedError = classifyError({
          code: outcome.errorCode,
          message: outcome.errorCode,
        });
        const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
        const categoryAllowsRetry =
          classifiedError.retryable &&
          retryPolicy.retryableCategories.includes(classifiedError.category);
        const canRetry = retryBudget
          ? categoryAllowsRetry &&
            checkBudget(retryBudget, input.signal).canRetry
          : false;
        if (canRetry) {
          const didWait = await this.waitBeforeRetry(
            input,
            retryPolicy,
            retryBudget?.attempts ?? executionAttempt,
            normalizeRetryAfterMs(outcome.retryAfterMs)
          );
          if (didWait) continue;
          return release(
            { type: "failed", errorCode: "USER_CANCELLED", toolExecutionId },
            "cancelled_before_dispatch"
          );
        }
        return release(
          { type: "failed", errorCode: outcome.errorCode, toolExecutionId },
          getToolExecutionTerminationCause(outcome)
        );
      }
      if (outcome.type === "cancelled" && outcome.dispatchState === "before") {
        return release(
          {
            type: "cancelled",
            dispatchState: outcome.dispatchState,
            toolExecutionId,
          },
          getToolExecutionTerminationCause(outcome)
        );
      }

      const unknownTransition = await this.markUnknown(
        toolExecutionId,
        businessEffectId
      );
      if (!unknownTransition) {
        return this.recoverUncertainPersistence(
          input,
          toolExecutionId,
          businessEffectId,
          businessEffectKey,
          "executing",
          "prepared"
        );
      }
      const reconciled = await this.reconcile(
        input,
        toolExecutionId,
        businessEffectId,
        businessEffectKey,
        retryBudget,
        outcomeErrorCode(outcome) ?? "SIDE_EFFECT_RECONCILIATION_REQUIRED"
      );
      if (reconciled.type === "retry") {
        retryBudget = reconciled.retryBudget;
        const didWait = await this.waitBeforeRetry(
          input,
          input.retryPolicy ?? DEFAULT_RETRY_POLICY,
          retryBudget?.attempts ?? executionAttempt
        );
        if (didWait) continue;
        return release(
          { type: "failed", errorCode: "USER_CANCELLED", toolExecutionId },
          "cancelled_before_dispatch"
        );
      }
      return reconciled.result;
    }
  }

  private async reconcile<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    toolExecutionId: string,
    businessEffectId: string,
    businessEffectKey: ReturnType<typeof hashBusinessEffectKey>,
    retryBudget: RetryBudget | undefined,
    dispatchErrorCode: string
  ): Promise<
    | { type: "retry"; retryBudget: RetryBudget | undefined }
    | { type: "done"; result: ToolExecutionRunResult<TResult> }
  > {
    if (!input.descriptor.reconcile) {
      await this.transitionOrDefer(
        toolExecutionId,
        "unknown",
        "manual_intervention_required",
        "ambiguous_after_dispatch"
      );
      await this.openReconciliationTask(input, toolExecutionId, businessEffectId, dispatchErrorCode);
      return {
        type: "done",
        result: {
          type: "deferred",
          errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
          toolExecutionId,
        },
      };
    }
    const reconciliationStartedAt = performance.now();
    let reconciliation;
    try {
      reconciliation = await input.descriptor.reconcile.reconcile({
        toolExecutionId,
        businessEffectKey,
      });
    } finally {
      await this.recordLatency(
        "tool.reconcile",
        reconciliationStartedAt,
        input
      );
    }
    const canRetry = retryBudget
      ? checkBudget(retryBudget, input.signal).canRetry
      : false;
    const action = decideReconciliationAction(reconciliation, canRetry);
    if (action === "retry") {
      const ready = await this.transitionEffectAndExecutionOrFalse({
        businessEffectId,
        expectedEffectState: "unknown",
        nextEffectState: "prepared",
        toolExecutionId,
        expectedExecutionStatus: "unknown",
        nextExecutionStatus: "executing",
      });
      if (ready) {
        return { type: "retry", retryBudget };
      }
      await this.openReconciliationTask(input, toolExecutionId, businessEffectId, PERSISTENCE_UNCERTAIN);
      return {
        type: "done",
        result: {
          type: "deferred",
          errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
          toolExecutionId,
        },
      };
    }
    if (action === "commit" && reconciliation.state === "committed") {
      if (reconciliation.result === undefined) {
        await this.openReconciliationTask(
          input,
          toolExecutionId,
          businessEffectId,
          "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE"
        );
        return {
          type: "done",
          result: {
            type: "deferred",
            errorCode: "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE",
            toolExecutionId,
          },
        };
      }
      return {
        type: "done",
        result: await this.persistReconciledResult(
          input,
          toolExecutionId,
          businessEffectId,
          "unknown",
          "unknown",
          reconciliation.result
        ),
      };
    }
    if (reconciliation.state === "not_committed") {
      // Confirmed not committed and no automatic retry: release the claim so
      // that only a new, re-authorized submission can run the effect.
      return {
        type: "done",
        result: await this.releaseNotCommitted(input, toolExecutionId, businessEffectId, "unknown", "unknown"),
      };
    }
    await this.transitionOrDefer(
      toolExecutionId,
      "unknown",
      "manual_intervention_required",
      "ambiguous_after_dispatch"
    );
    await this.openReconciliationTask(
      input,
      toolExecutionId,
      businessEffectId,
      (reconciliation.state === "unknown" ? reconciliation.reason : undefined) ?? dispatchErrorCode
    );
    return {
      type: "done",
      result: {
        type: "deferred",
        errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
        toolExecutionId,
      },
    };
  }

  /**
   * A ledger write after dispatch failed (design §6.6, version 10). With the
   * opt-in the reconciler decides once: committed is written again, not
   * committed is released, anything else stays unknown with a task. Without
   * it the result stays SIDE_EFFECT_PERSISTENCE_UNCERTAIN as before.
   */
  private async recoverUncertainPersistence<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    toolExecutionId: string,
    businessEffectId: string,
    businessEffectKey: ReturnType<typeof hashBusinessEffectKey>,
    expectedExecutionStatus: ToolExecutionStatus,
    expectedEffectState: "prepared" | "unknown"
  ): Promise<ToolExecutionRunResult<TResult>> {
    const uncertain: ToolExecutionRunResult<TResult> = {
      type: "deferred",
      errorCode: PERSISTENCE_UNCERTAIN,
      toolExecutionId,
    };
    if (this.reconciliationTasks === undefined) return uncertain;
    let reconciliation: ReconciliationResult<TResult> | undefined;
    if (input.descriptor.reconcile) {
      const reconciliationStartedAt = performance.now();
      try {
        reconciliation = await input.descriptor.reconcile.reconcile({
          toolExecutionId,
          businessEffectKey,
        });
      } catch {
        reconciliation = undefined;
      } finally {
        await this.recordLatency("tool.reconcile", reconciliationStartedAt, input);
      }
    }
    if (reconciliation?.state === "committed" && reconciliation.result !== undefined) {
      return this.persistReconciledResult(
        input,
        toolExecutionId,
        businessEffectId,
        expectedExecutionStatus,
        expectedEffectState,
        reconciliation.result
      );
    }
    if (reconciliation?.state === "not_committed") {
      return this.releaseNotCommitted(
        input,
        toolExecutionId,
        businessEffectId,
        expectedExecutionStatus,
        expectedEffectState
      );
    }
    await this.openReconciliationTask(
      input,
      toolExecutionId,
      businessEffectId,
      (reconciliation?.state === "unknown" ? reconciliation.reason : undefined) ?? PERSISTENCE_UNCERTAIN
    );
    return uncertain;
  }

  /** Writes a reconciled result once; a write that fails again stays unknown with a task. */
  private async persistReconciledResult<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    toolExecutionId: string,
    businessEffectId: string,
    expectedExecutionStatus: ToolExecutionStatus,
    expectedEffectState: "prepared" | "unknown",
    result: TResult
  ): Promise<ToolExecutionRunResult<TResult>> {
    const persisted = await this.persistCommittedResult(
      input,
      toolExecutionId,
      businessEffectId,
      expectedExecutionStatus,
      expectedEffectState,
      result,
      "reconciled"
    );
    if (isPersistenceUncertain(persisted)) {
      await this.openReconciliationTask(input, toolExecutionId, businessEffectId, PERSISTENCE_UNCERTAIN);
    }
    return persisted;
  }

  /** Releases a claim confirmed not committed; a release that cannot be written stays unknown with a task. */
  private async releaseNotCommitted<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>,
    toolExecutionId: string,
    businessEffectId: string,
    expectedExecutionStatus: ToolExecutionStatus,
    expectedEffectState: "prepared" | "unknown"
  ): Promise<ToolExecutionRunResult<TResult>> {
    const released = await this.releaseOrFalse(
      toolExecutionId,
      businessEffectId,
      expectedExecutionStatus,
      "failed_not_committed",
      expectedEffectState
    );
    if (released) {
      return { type: "failed", errorCode: "SIDE_EFFECT_NOT_COMMITTED", toolExecutionId };
    }
    await this.openReconciliationTask(input, toolExecutionId, businessEffectId, PERSISTENCE_UNCERTAIN);
    return { type: "deferred", errorCode: PERSISTENCE_UNCERTAIN, toolExecutionId };
  }

  /**
   * The outcome stays unknown whatever happens here: a task that cannot be
   * stored is audited as RECONCILIATION_TASK_PERSISTENCE_FAILED, never turned
   * into success or failure (design §6.6).
   */
  private async openReconciliationTask<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>,
    toolExecutionId: string,
    businessEffectId: string,
    reasonCode: string
  ): Promise<void> {
    if (this.reconciliationTasks === undefined) return;
    const payload = {
      resourceType: "business_effect",
      resourceId: businessEffectId,
      runId: input.identity.runId,
      toolExecutionId,
      businessEffectId,
      reasonCode,
    };
    try {
      const task = await this.reconciliationTasks.open({
        tenantId: input.scope.tenantId,
        scopeId: input.scope.scopeId,
        businessEffectId,
        toolExecutionId,
        reasonCode,
      });
      await ignoreObservabilityFailure(() =>
        this.observability.auditLogger.record(
          "tool.side_effect.reconciliation_task_opened",
          { ...payload, reconciliationTaskId: task.reconciliationTaskId, created: task.created },
          input.executionContext
        )
      );
    } catch {
      await ignoreObservabilityFailure(() =>
        this.observability.auditLogger.record(
          "tool.side_effect.reconciliation_task_persistence_failed",
          { ...payload, errorCode: "RECONCILIATION_TASK_PERSISTENCE_FAILED" },
          input.executionContext
        )
      );
    }
  }

  private async persistCommittedResult<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    toolExecutionId: string,
    businessEffectId: string,
    expectedExecutionStatus: ToolExecutionStatus,
    expectedEffectState: "prepared" | "unknown",
    result: TResult,
    source: "live" | "reconciled"
  ): Promise<ToolExecutionRunResult<TResult>> {
    const outputIsValid = isResultValid(input.validateResult, result);
    try {
      const reference = await this.resultStore.save({
        toolExecutionId,
        result,
        policy: input.descriptor.resultReferencePolicy,
        scope: input.scope,
        toolVersion: input.descriptor.toolVersion,
      });
      await this.ledger.commitExecutionAndBusinessEffect({
        toolExecutionId,
        expectedExecutionStatus,
        resultRef: reference.resultRefId,
        terminationCause: "completed",
        businessEffectId,
        expectedEffectState,
        ...(reference.externalSystemNamespace
          ? { externalSystemNamespace: reference.externalSystemNamespace }
          : {}),
        ...(reference.externalOperationId
          ? { externalOperationId: reference.externalOperationId }
          : {}),
      });
      const replayKey = createReplayKey(input.identity);
      const businessEffectKey = hashBusinessEffectKey(
        input.descriptor.deriveBusinessEffectKey(input.input, input.scope)
      );
      await ignoreObservabilityFailure(() =>
        this.observability.auditLogger.record("tool.side_effect.committed", {
          resourceType: "tool_execution",
          resourceId: toolExecutionId,
          requestId: input.requestId,
          threadId: input.threadId,
          runId: input.identity.runId,
          replayKey,
          businessEffectKey,
          toolExecutionId,
          // A result confirmed by reconciliation is marked as such (design §6.6).
          source,
          ...(reference.externalSystemNamespace
            ? { externalSystemNamespace: reference.externalSystemNamespace }
            : {}),
          ...(reference.externalOperationId
            ? { externalOperationId: reference.externalOperationId }
            : {}),
        }, input.executionContext)
      );
      if (!outputIsValid) {
        await ignoreObservabilityFailure(() =>
          this.observability.auditLogger.record(
            "tool.side_effect.output_validation_failed",
            {
              resourceType: "tool_execution",
              resourceId: toolExecutionId,
              requestId: input.requestId,
              threadId: input.threadId,
              runId: input.identity.runId,
              replayKey,
              businessEffectKey,
              toolExecutionId,
            },
            input.executionContext
          )
        );
        return {
          type: "deferred",
          errorCode: "SIDE_EFFECT_OUTPUT_VALIDATION_FAILED",
          toolExecutionId,
        };
      }
      return { type: "succeeded", source, result, toolExecutionId };
    } catch {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
        toolExecutionId,
      };
    }
  }

  private markUnknown(
    toolExecutionId: string,
    businessEffectId: string
  ): Promise<boolean> {
    return this.transitionEffectAndExecutionOrFalse({
      businessEffectId,
      expectedEffectState: "prepared",
      nextEffectState: "unknown",
      toolExecutionId,
      expectedExecutionStatus: "executing",
      nextExecutionStatus: "unknown",
    });
  }

  private async transitionEffectAndExecutionOrFalse(
    input: Parameters<BusinessEffectLedger["transitionBusinessEffectAndExecution"]>[0]
  ): Promise<boolean> {
    try {
      await this.ledger.transitionBusinessEffectAndExecution(input);
      return true;
    } catch {
      return false;
    }
  }

  private async releaseOrFalse(
    toolExecutionId: string,
    businessEffectId: string,
    expectedExecutionStatus: ToolExecutionStatus,
    terminationCause: ToolExecutionTerminationCause,
    expectedEffectState: "prepared" | "unknown" = "prepared"
  ): Promise<boolean> {
    try {
      await this.ledger.releaseClaim({
        businessEffectId,
        expectedEffectState,
        toolExecutionId,
        expectedExecutionStatus,
        terminationCause,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async transitionOrDefer(
    toolExecutionId: string,
    expectedStatus: ToolExecutionStatus,
    nextStatus: ToolExecutionStatus,
    terminationCause?: ToolExecutionTerminationCause
  ): Promise<boolean> {
    try {
      await this.ledger.transitionExecution({
        toolExecutionId,
        expectedStatus,
        nextStatus,
        ...(terminationCause ? { terminationCause } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async waitBeforeRetry<TInput, TResult>(
    input: ToolExecutionRunInput<TInput, TResult>,
    retryPolicy: RetryPolicy,
    attempt: number,
    retryAfterMs?: number
  ): Promise<boolean> {
    const delayMs = computeBackoff(retryPolicy.backoffStrategy, attempt, {
      retryAfterMs,
      maxMs: input.retryAfterMaxMs,
      jitter: retryPolicy.jitter,
    });
    const backoffStartedAt = performance.now();
    try {
      await this.timing.wait(delayMs, input.signal);
      return input.signal?.aborted !== true;
    } catch (error) {
      if (input.signal?.aborted) {
        return false;
      }
      throw error;
    } finally {
      await this.recordLatency(
        "tool.retry.backoff",
        backoffStartedAt,
        input
      );
    }
  }

  private async recordLatency<TInput, TResult>(
    metricName:
      | "tool.authorization.wait"
      | "tool.retry.backoff"
      | "tool.execution"
      | "tool.reconcile",
    startedAt: number,
    input: ToolExecutionRunInput<TInput, TResult>
  ): Promise<void> {
    const payload = {
      durationMs: Math.max(0, performance.now() - startedAt),
      toolName: input.identity.toolName,
    };
    await ignoreObservabilityFailure(() =>
      input.executionContext
        ? this.observability.recordMetric(
            metricName,
            payload,
            input.executionContext
          )
        : this.observability.recordMetric(metricName, payload)
    );
  }
}

function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? value : undefined;
}
