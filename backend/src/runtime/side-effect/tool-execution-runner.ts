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
import type {
  BusinessEffectLedger,
  PrepareSideEffectResult,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from "./business-effect-ledger.js";
import type {
  GovernedToolExecutor,
  GovernedToolOutcome,
} from "./governed-outcome.js";
import {
  createReplayKey,
  createToolExecutionAttemptIdentity,
  hashBusinessEffectKey,
  type ReplayIdentityInput,
  type TrustedScope,
} from "./identity.js";
import { decideReconciliationAction } from "./reconciler.js";
import type { ResultReferenceStore } from "./result-reference-store.js";
import type { SideEffectToolDescriptor } from "./side-effect-descriptor.js";

export type ToolExecutionRunResult<TResult> =
  | {
      type: "succeeded";
      source: "live" | "cache" | "reconciled";
      result: TResult;
      toolExecutionId?: string;
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
        | "SIDE_EFFECT_PERSISTENCE_UNCERTAIN";
      toolExecutionId?: string;
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
  signal?: AbortSignal;
  requestId?: string;
  threadId?: string;
  taskId?: string;
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

const defaultObservability: ToolExecutionRunnerObservability = {
  auditLogger: defaultAuditLogger,
  spanManager: getSpanManager(),
  recordMetric: defaultRecordMetric,
};

function errorCodeOf<TResult>(
  outcome: Exclude<GovernedToolOutcome<TResult>, { type: "succeeded" | "cancelled" }>
): string {
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

function outcomeErrorCode<TResult>(
  outcome: GovernedToolOutcome<TResult>
): string | undefined {
  if (outcome.type === "confirmation_required") return "REQUIRES_CONFIRMATION";
  return outcome.type === "succeeded" || outcome.type === "cancelled"
    ? undefined
    : outcome.errorCode;
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

export class ToolExecutionRunner {
  private readonly observability: ToolExecutionRunnerObservability;

  constructor(
    private readonly ledger: BusinessEffectLedger,
    private readonly resultStore: ResultReferenceStore,
    observability: Partial<ToolExecutionRunnerObservability> = {}
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
      return this.executeReadOnly(input.executor, input.input, input.signal);
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
    executor: GovernedToolExecutor<TInput, TResult>,
    toolInput: TInput,
    signal?: AbortSignal
  ): Promise<ToolExecutionRunResult<TResult>> {
    const outcome = await executor.executeTyped(toolInput, { signal });
    if (outcome.type === "succeeded") {
      return { type: "succeeded", source: "live", result: outcome.result };
    }
    if (outcome.type === "cancelled") {
      return { type: "cancelled", dispatchState: outcome.dispatchState };
    }
    return { type: "failed", errorCode: errorCodeOf(outcome) };
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
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
        toolExecutionId: prepareResult.execution.toolExecutionId,
      };
    }

    const correlation = {
      requestId: input.requestId,
      threadId: input.threadId,
      runId: input.identity.runId,
      replayKey,
      businessEffectKey,
      toolExecutionId: prepareResult.execution.toolExecutionId,
    };
    await this.observability.auditLogger.record("tool.side_effect.prepared", {
      resourceType: "tool_execution",
      resourceId: prepareResult.execution.toolExecutionId,
      ...correlation,
    }, input.executionContext);
    try {
      await this.ledger.transitionExecution({
        toolExecutionId: prepareResult.execution.toolExecutionId,
        expectedStatus: "prepared",
        nextStatus: "executing",
      });
    } catch {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
        toolExecutionId: prepareResult.execution.toolExecutionId,
      };
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
    if (execution.status !== "committed") {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
        toolExecutionId: execution.toolExecutionId,
      };
    }
    return this.resolveCommittedResult(execution, input, "cache");
  }

  private resolvePreparedCommitted<TInput, TResult>(
    prepareResult: Extract<PrepareSideEffectResult, { type: "existing_committed" }>,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    }
  ): Promise<ToolExecutionRunResult<TResult>> {
    return this.resolveCommittedResult(prepareResult.execution, input, "cache");
  }

  private async resolveCommittedResult<TInput, TResult>(
    execution: ToolExecutionRecord,
    input: ToolExecutionRunInput<TInput, TResult> & {
      descriptor: SideEffectToolDescriptor<TInput, TResult>;
    },
    source: "cache" | "reconciled"
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
    return result === null
      ? {
          type: "deferred",
          errorCode: "SIDE_EFFECT_RESULT_NOT_REUSABLE",
          toolExecutionId: execution.toolExecutionId,
        }
      : {
          type: "succeeded",
          source,
          result,
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

    while (true) {
      const legacyExecutionConfig = {
        signal: input.signal,
        configurable: {
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          runId: input.identity.runId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          stepId: input.identity.stepId,
          toolExecutionId,
          toolCallId:
            input.identity.logicalToolCallId ?? input.identity.toolCallId,
        },
      };
      const executionConfig = input.executionContext
        ? withExecutionContext(legacyExecutionConfig, {
            ...input.executionContext,
            stepId: input.identity.stepId,
            toolExecutionId,
            toolCallId: input.identity.logicalToolCallId ?? input.identity.toolCallId,
          })
        : legacyExecutionConfig;
      let executeAttempt = input.executor.executeTyped.bind(input.executor);
      if (input.executor.authorizeTyped !== undefined) {
        if (input.executor.executeAuthorizedTyped === undefined) {
          await this.transitionOrDefer(toolExecutionId, "executing", "failed");
          return {
            type: "failed",
            errorCode: "AUTHORIZATION_UNAVAILABLE",
            toolExecutionId,
          };
        }

        let authorizationOutcome;
        try {
          authorizationOutcome = await input.executor.authorizeTyped(
            input.input,
            executionConfig
          );
        } catch {
          await this.transitionOrDefer(toolExecutionId, "executing", "failed");
          return {
            type: "failed",
            errorCode: "AUTHORIZATION_UNAVAILABLE",
            toolExecutionId,
          };
        }

        if (authorizationOutcome.decisionId === undefined) {
          await this.transitionOrDefer(toolExecutionId, "executing", "failed");
          return {
            type: "failed",
            errorCode: "AUTHORIZATION_UNAVAILABLE",
            toolExecutionId,
          };
        }
        try {
          await this.ledger.linkAuthorizationDecision({
            toolExecutionId,
            decisionId: authorizationOutcome.decisionId,
          });
        } catch {
          return {
            type: "deferred",
            errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
            toolExecutionId,
          };
        }
        if (authorizationOutcome.type === "denied_by_authorization") {
          await this.transitionOrDefer(toolExecutionId, "executing", "failed");
          return {
            type: "failed",
            errorCode: authorizationOutcome.errorCode,
            toolExecutionId,
            decisionId: authorizationOutcome.decisionId,
          };
        }
        if (authorizationOutcome.type === "confirmation_required") {
          await this.transitionOrDefer(toolExecutionId, "executing", "failed");
          return {
            type: "failed",
            errorCode: "REQUIRES_CONFIRMATION",
            toolExecutionId,
            decisionId: authorizationOutcome.decisionId,
          };
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
        return {
          type: "deferred",
          errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
          toolExecutionId,
        };
      }

      const outcome = await executeAttempt(input.input, executionConfig);
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
        return {
          type: "deferred",
          errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
          toolExecutionId,
        };
      }

      const metric = {
        toolName: input.descriptor.toolName,
        outcomeType: outcome.type,
        count: 1,
      };
      if (input.executionContext) {
        await this.observability.recordMetric("tool.side_effect.outcome", metric, input.executionContext);
      } else {
        await this.observability.recordMetric("tool.side_effect.outcome", metric);
      }
      if (outcome.type === "succeeded") {
        return this.persistCommittedResult(
          input,
          toolExecutionId,
          businessEffectId,
          "executing",
          "prepared",
          outcome.result,
          "live"
        );
      }
      if (outcome.type === "rejected_before_dispatch") {
        await this.transitionOrDefer(toolExecutionId, "executing", "failed");
        return { type: "failed", errorCode: outcome.errorCode, toolExecutionId };
      }
      if (outcome.type === "denied_by_authorization") {
        await this.transitionOrDefer(toolExecutionId, "executing", "failed");
        return {
          type: "failed",
          errorCode: outcome.errorCode,
          toolExecutionId,
          decisionId: outcome.decisionId,
        };
      }
      if (outcome.type === "confirmation_required") {
        await this.transitionOrDefer(toolExecutionId, "executing", "failed");
        return {
          type: "failed",
          errorCode: "REQUIRES_CONFIRMATION",
          toolExecutionId,
          decisionId: outcome.decisionId,
        };
      }
      if (outcome.type === "failed_not_committed") {
        const canRetry = retryBudget
          ? checkBudget(retryBudget, input.signal).canRetry
          : false;
        if (canRetry) continue;
        await this.transitionOrDefer(toolExecutionId, "executing", "failed");
        return { type: "failed", errorCode: outcome.errorCode, toolExecutionId };
      }
      if (outcome.type === "cancelled" && outcome.dispatchState === "before") {
        await this.transitionOrDefer(toolExecutionId, "executing", "failed");
        return {
          type: "cancelled",
          dispatchState: outcome.dispatchState,
          toolExecutionId,
        };
      }

      const unknownTransition = await this.markUnknown(
        toolExecutionId,
        businessEffectId
      );
      if (!unknownTransition) {
        return {
          type: "deferred",
          errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
          toolExecutionId,
        };
      }
      const reconciled = await this.reconcile(
        input,
        toolExecutionId,
        businessEffectId,
        businessEffectKey,
        retryBudget
      );
      if (reconciled.type === "retry") {
        retryBudget = reconciled.retryBudget;
        continue;
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
    retryBudget: RetryBudget | undefined
  ): Promise<
    | { type: "retry"; retryBudget: RetryBudget | undefined }
    | { type: "done"; result: ToolExecutionRunResult<TResult> }
  > {
    if (!input.descriptor.reconcile) {
      await this.transitionOrDefer(
        toolExecutionId,
        "unknown",
        "manual_intervention_required"
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
    const reconciliation = await input.descriptor.reconcile.reconcile({
      toolExecutionId,
      businessEffectKey,
    });
    const canRetry = retryBudget
      ? checkBudget(retryBudget, input.signal).canRetry
      : false;
    const action = decideReconciliationAction(reconciliation, canRetry);
    if (action === "retry") {
      const executionReady = await this.transitionOrDefer(
        toolExecutionId,
        "unknown",
        "executing"
      );
      const effectReady = await this.transitionBusinessEffectOrFalse(
        businessEffectId,
        "unknown",
        "prepared"
      );
      if (executionReady && effectReady) {
        return { type: "retry", retryBudget };
      }
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
        result: await this.persistCommittedResult(
          input,
          toolExecutionId,
          businessEffectId,
          "unknown",
          "unknown",
          reconciliation.result,
          "reconciled"
        ),
      };
    }
    await this.transitionOrDefer(
      toolExecutionId,
      "unknown",
      "manual_intervention_required"
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
      await this.observability.auditLogger.record("tool.side_effect.committed", {
        resourceType: "tool_execution",
        resourceId: toolExecutionId,
        requestId: input.requestId,
        threadId: input.threadId,
        runId: input.identity.runId,
        replayKey,
        businessEffectKey,
        toolExecutionId,
        ...(reference.externalSystemNamespace
          ? { externalSystemNamespace: reference.externalSystemNamespace }
          : {}),
        ...(reference.externalOperationId
          ? { externalOperationId: reference.externalOperationId }
          : {}),
      }, input.executionContext);
      return { type: "succeeded", source, result, toolExecutionId };
    } catch {
      return {
        type: "deferred",
        errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
        toolExecutionId,
      };
    }
  }

  private async markUnknown(
    toolExecutionId: string,
    businessEffectId: string
  ): Promise<boolean> {
    const executionUpdated = await this.transitionOrDefer(
      toolExecutionId,
      "executing",
      "unknown"
    );
    const effectUpdated = await this.transitionBusinessEffectOrFalse(
      businessEffectId,
      "prepared",
      "unknown"
    );
    return executionUpdated && effectUpdated;
  }

  private async transitionOrDefer(
    toolExecutionId: string,
    expectedStatus: ToolExecutionStatus,
    nextStatus: ToolExecutionStatus
  ): Promise<boolean> {
    try {
      await this.ledger.transitionExecution({
        toolExecutionId,
        expectedStatus,
        nextStatus,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async transitionBusinessEffectOrFalse(
    businessEffectId: string,
    expectedState: "prepared" | "unknown",
    nextState: "prepared" | "unknown"
  ): Promise<boolean> {
    try {
      await this.ledger.transitionBusinessEffect({
        businessEffectId,
        expectedState,
        nextState,
      });
      return true;
    } catch {
      return false;
    }
  }
}
