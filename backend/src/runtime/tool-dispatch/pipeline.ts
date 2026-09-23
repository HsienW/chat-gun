import { createHash } from "node:crypto";

import {
  CompensationRegistryImpl,
  type CompensationRegistry,
} from "../compensation/compensation-registry.js";
import {
  SagaOrchestratorImpl,
  type SagaOrchestrator,
} from "../compensation/saga-orchestrator.js";
import type {
  CompensateOptions,
  CompensationResult,
} from "../compensation/compensation-action.js";
import {
  readCanonicalExecutionContext,
} from "../execution-context/read-execution-context.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import { createBudget, type RetryBudget } from "../retry/retry-budget.js";
import type { RetryPolicy } from "../retry/retry-policy.js";
import type {
  GovernedAuthorizationOutcome,
  GovernedToolExecutor,
  GovernedToolOutcome,
} from "../side-effect/governed-outcome.js";
import {
  ToolExecutionRunner,
  type ToolExecutionRunResult,
} from "../side-effect/tool-execution-runner.js";
import {
  PgBusinessEffectLedger,
  PgSideEffectDatabase,
} from "../side-effect/business-effect-ledger.js";
import { PgResultReferenceStore } from "../side-effect/result-reference-store.js";
import { PgTaskRepository } from "../persistence/task-repository.js";
import { PgStepRepository } from "../persistence/step-repository.js";
import { PgEventRepository } from "../persistence/event-repository.js";
import { getPool } from "../persistence/connection.js";
import {
  auditLogger,
  recordMetric,
} from "../../platform/observability.js";
import type { RuntimeToolDescriptorRegistry } from "./runtime-tool-descriptor.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import {
  createStructuredToolResultEnvelope,
  type StructuredToolResultEnvelope,
} from "./structured-tool-result.js";
import { PgToolDispatchTaskStepAdapter } from "./task-step-adapter.js";
import {
  BoundedToolDispatchScheduler,
  type ToolDispatchScheduler,
} from "./scheduler.js";

export interface ToolDispatchTaskStepAdapter {
  start(
    context: ExecutionContext,
    descriptor: RuntimeToolDescriptor,
    input: unknown
  ): Promise<void>;
  complete(
    context: ExecutionContext,
    envelope: StructuredToolResultEnvelope
  ): Promise<void>;
  fail(
    context: ExecutionContext,
    envelope: StructuredToolResultEnvelope
  ): Promise<void>;
}

export interface ToolDispatchObservability {
  audit(
    eventName: string,
    payload: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<void> | void;
  metric(
    metricName: string,
    payload: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<void> | void;
}

export interface RuntimeToolDispatchPipelineDependencies {
  registry: RuntimeToolDescriptorRegistry;
  pool?: ReturnType<typeof getPool>;
  toolExecutionRunner?: Pick<ToolExecutionRunner, "execute">;
  retryBudgetFactory?: (stepId: string, policy: RetryPolicy) => RetryBudget;
  taskStepAdapter?: ToolDispatchTaskStepAdapter;
  compensationRegistry?: CompensationRegistry;
  sagaOrchestrator?: SagaOrchestrator;
  observability?: ToolDispatchObservability;
  scheduler?: ToolDispatchScheduler;
}

export interface RuntimeToolDispatchPipeline {
  createExecutor(
    toolName: string,
    sourceExecutor: GovernedToolExecutor<unknown, unknown>
  ): GovernedToolExecutor<unknown, StructuredToolResultEnvelope>;
  hasCompensation(toolName: string): boolean;
  compensate(
    taskId: string,
    options?: CompensateOptions
  ): Promise<CompensationResult>;
}

const AMBIGUOUS_DEFERRED_CODES = new Set([
  "SIDE_EFFECT_COMMITTED_RESULT_UNAVAILABLE",
  "SIDE_EFFECT_RECONCILIATION_REQUIRED",
  "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
  "SIDE_EFFECT_OUTPUT_VALIDATION_FAILED",
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function createRequestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function getAbortSignal(config: unknown): AbortSignal | undefined {
  if (config === null || typeof config !== "object" || !("signal" in config)) {
    return undefined;
  }
  return config.signal instanceof AbortSignal ? config.signal : undefined;
}

function hasMandatoryDependencies(
  dependencies: RuntimeToolDispatchPipelineDependencies
): dependencies is RuntimeToolDispatchPipelineDependencies & {
  toolExecutionRunner: Pick<ToolExecutionRunner, "execute">;
  retryBudgetFactory: (stepId: string, policy: RetryPolicy) => RetryBudget;
  taskStepAdapter: ToolDispatchTaskStepAdapter;
  compensationRegistry: CompensationRegistry;
  sagaOrchestrator: SagaOrchestrator;
  observability: ToolDispatchObservability;
  scheduler: ToolDispatchScheduler;
} {
  return (
    dependencies.toolExecutionRunner !== undefined &&
    dependencies.retryBudgetFactory !== undefined &&
    dependencies.taskStepAdapter !== undefined &&
    dependencies.compensationRegistry !== undefined &&
    dependencies.sagaOrchestrator !== undefined &&
    dependencies.observability !== undefined &&
    dependencies.scheduler !== undefined
  );
}

function hasAuthorization(
  executor: GovernedToolExecutor<unknown, unknown>
): executor is GovernedToolExecutor<unknown, unknown> & {
  authorizeTyped: NonNullable<
    GovernedToolExecutor<unknown, unknown>["authorizeTyped"]
  >;
  executeAuthorizedTyped: NonNullable<
    GovernedToolExecutor<unknown, unknown>["executeAuthorizedTyped"]
  >;
} {
  return (
    executor.authorizeTyped !== undefined &&
    executor.executeAuthorizedTyped !== undefined
  );
}

function mapRunnerResult(
  result: ToolExecutionRunResult<unknown>,
  descriptor: RuntimeToolDescriptor
): GovernedToolOutcome<unknown> {
  if (result.type === "succeeded") {
    const parsedOutput = descriptor.outputSchema.safeParse(result.result);
    return parsedOutput.success
      ? { type: "succeeded", result: parsedOutput.data }
      : {
          type: descriptor.isReadOnly
            ? "failed_not_committed"
            : "ambiguous_after_dispatch",
          errorCode: descriptor.isReadOnly
            ? "TOOL_OUTPUT_VALIDATION_FAILED"
            : "TOOL_OUTPUT_VALIDATION_FAILED_AFTER_COMMIT",
        };
  }
  if (result.type === "cancelled") {
    return { type: "cancelled", dispatchState: result.dispatchState };
  }
  if (result.type === "conflict") {
    return { type: "failed_not_committed", errorCode: result.errorCode };
  }
  if (result.type === "failed") {
    return {
      type: "failed_not_committed",
      errorCode: result.errorCode,
    };
  }
  return AMBIGUOUS_DEFERRED_CODES.has(result.errorCode)
    ? { type: "ambiguous_after_dispatch", errorCode: result.errorCode }
    : { type: "rejected_before_dispatch", errorCode: result.errorCode };
}

async function recordOutcome(
  observability: ToolDispatchObservability,
  envelope: StructuredToolResultEnvelope,
  context: ExecutionContext
): Promise<void> {
  const payload = {
    toolName: envelope.tool.name,
    toolVersion: envelope.tool.version,
    outcomeType: envelope.outcome.type,
    toolResult: createAuditToolResult(envelope),
  };
  await Promise.allSettled([
    ignoreObservabilityFailure(() =>
      observability.audit("tool.dispatch.completed", payload, context)
    ),
    ignoreObservabilityFailure(() =>
      observability.metric(
        "tool.dispatch.count",
        { ...payload, count: 1 },
        context
      )
    ),
  ]);
}

function createAuditToolResult(
  envelope: StructuredToolResultEnvelope
): Record<string, unknown> {
  const outcome = envelope.outcome;
  return {
    ...envelope,
    outcome:
      outcome.type === "succeeded"
        ? { type: "succeeded", result: "[redacted]" }
        : outcome.type === "confirmation_required"
          ? { ...outcome, descriptor: "[redacted]" }
          : outcome,
  };
}

async function ignoreObservabilityFailure(
  operation: () => Promise<void> | void
): Promise<void> {
  try {
    await operation();
  } catch {
    // Exporters are best-effort after the durable execution outcome exists.
  }
}

function authorizationUnavailable(): GovernedAuthorizationOutcome {
  return {
    type: "denied_by_authorization",
    errorCode: "AUTHORIZATION_UNAVAILABLE",
    decisionId: globalThis.crypto.randomUUID(),
  };
}

function withProductionDefaults(
  input: RuntimeToolDispatchPipelineDependencies
): RuntimeToolDispatchPipelineDependencies {
  const pool = input.pool === undefined ? getPool() : input.pool;
  const ledger = pool
    ? new PgBusinessEffectLedger(new PgSideEffectDatabase(pool))
    : undefined;
  const taskRepository = pool ? new PgTaskRepository(pool) : undefined;
  const stepRepository = pool ? new PgStepRepository(pool) : undefined;
  const eventRepository = pool ? new PgEventRepository(pool) : undefined;
  const compensationRegistry =
    input.compensationRegistry ?? new CompensationRegistryImpl();

  return {
    ...input,
    pool,
    toolExecutionRunner:
      input.toolExecutionRunner ??
      (pool && ledger
        ? new ToolExecutionRunner(ledger, new PgResultReferenceStore(pool))
        : undefined),
    retryBudgetFactory: input.retryBudgetFactory ?? createBudget,
    taskStepAdapter:
      input.taskStepAdapter ??
      (taskRepository && stepRepository && eventRepository
        ? new PgToolDispatchTaskStepAdapter({
            taskRepository,
            stepRepository,
            eventRepository,
          })
        : undefined),
    compensationRegistry,
    sagaOrchestrator:
      input.sagaOrchestrator ??
      (taskRepository && stepRepository && eventRepository && ledger
        ? new SagaOrchestratorImpl(
            compensationRegistry,
            taskRepository,
            stepRepository,
            eventRepository,
            auditLogger,
            ledger
          )
        : undefined),
    observability:
      input.observability ?? {
        audit: (eventName, payload, context) =>
          auditLogger.record(eventName, payload, context),
        metric: (metricName, payload, context) =>
          recordMetric(metricName, payload, context),
      },
    scheduler: input.scheduler ?? new BoundedToolDispatchScheduler(),
  };
}

export function createRuntimeToolDispatchPipeline(
  input: RuntimeToolDispatchPipelineDependencies
): RuntimeToolDispatchPipeline {
  const dependencies = withProductionDefaults(input);
  async function dispatch(
    toolName: string,
    input: unknown,
    config: unknown,
    sourceExecutor: GovernedToolExecutor<unknown, unknown>,
    authorizationAlreadyEvaluated: boolean
  ): Promise<GovernedToolOutcome<StructuredToolResultEnvelope>> {
    const descriptor = dependencies.registry.resolve(toolName);
    if (descriptor === null) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "UNREGISTERED_TOOL_DENIED",
      };
    }

    const parsedInput = descriptor.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_INPUT_VALIDATION_FAILED",
      };
    }
    if (!hasMandatoryDependencies(dependencies)) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE",
      };
    }
    if (!hasAuthorization(sourceExecutor)) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "AUTHORIZATION_UNAVAILABLE",
      };
    }

    let isConcurrencySafe: boolean;
    try {
      isConcurrencySafe =
        descriptor.isReadOnly &&
        descriptor.isConcurrencySafe(parsedInput.data);
    } catch {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_CONCURRENCY_CLASSIFICATION_FAILED",
      };
    }

    const executionContext = readCanonicalExecutionContext(config);
    if (
      executionContext === undefined ||
      executionContext.stepId === undefined ||
      executionContext.toolCallId === undefined
    ) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_EXECUTION_CONTEXT_UNAVAILABLE",
      };
    }
    const stepId = executionContext.stepId;
    const toolCallId = executionContext.toolCallId;

    try {
      await dependencies.taskStepAdapter.start(
        executionContext,
        descriptor,
        parsedInput.data
      );
    } catch {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TASK_STEP_UNAVAILABLE",
      };
    }

    const runnerExecutor: GovernedToolExecutor<unknown, unknown> =
      authorizationAlreadyEvaluated
        ? {
            executeTyped: sourceExecutor.executeAuthorizedTyped.bind(
              sourceExecutor
            ),
          }
        : sourceExecutor;
    const retryPolicy =
      authorizationAlreadyEvaluated && !descriptor.isReadOnly
        ? { ...descriptor.retryPolicy, maxAttempts: 1 }
        : descriptor.retryPolicy;
    const runnerResult = await dependencies.scheduler.schedule(
      isConcurrencySafe,
      () =>
        dependencies.toolExecutionRunner.execute({
          executionContext,
          identity: {
            runId: executionContext.runId,
            stepId,
            logicalToolCallId: toolCallId,
            callIndex: 0,
            toolName: descriptor.toolName,
            toolVersion: descriptor.toolVersion,
            attempt: executionContext.attempt,
          },
          requestHash: createRequestHash(parsedInput.data),
          scope: {
            scopeId: executionContext.scope.scopeId,
            tenantId: executionContext.scope.tenantId,
            principalId: executionContext.principal.principalId,
          },
          input: parsedInput.data,
          executor: runnerExecutor,
          descriptor: descriptor.isReadOnly ? undefined : descriptor.sideEffect,
          validateResult: (result) =>
            descriptor.outputSchema.safeParse(result).success,
          retryBudget: dependencies.retryBudgetFactory(
            stepId,
            retryPolicy
          ),
          retryPolicy,
          signal: getAbortSignal(config),
        })
    );
    const governedOutcome = mapRunnerResult(runnerResult, descriptor);
    let envelope = createStructuredToolResultEnvelope({
      executionContext,
      descriptor,
      outcome: governedOutcome,
    });

    try {
      if (governedOutcome.type === "succeeded") {
        await dependencies.taskStepAdapter.complete(executionContext, envelope);
      } else {
        await dependencies.taskStepAdapter.fail(executionContext, envelope);
      }
    } catch {
      envelope = createStructuredToolResultEnvelope({
        executionContext,
        descriptor,
        outcome: {
          type: "ambiguous_after_dispatch",
          errorCode: "TASK_STEP_PERSISTENCE_FAILED_AFTER_DISPATCH",
        },
      });
      await Promise.allSettled([
        dependencies.taskStepAdapter.fail(executionContext, envelope),
        recordOutcome(dependencies.observability, envelope, executionContext),
      ]);
      return { type: "succeeded", result: envelope };
    }
    await recordOutcome(dependencies.observability, envelope, executionContext);

    return { type: "succeeded", result: envelope };
  }

  return {
    createExecutor(toolName, sourceExecutor) {
      return {
        authorizeTyped: async (input, config) =>
          sourceExecutor.authorizeTyped?.(input, config) ??
          authorizationUnavailable(),
        executeTyped: (input, config) =>
          dispatch(toolName, input, config, sourceExecutor, false),
        executeAuthorizedTyped: (input, config) =>
          dispatch(toolName, input, config, sourceExecutor, true),
      };
    },
    hasCompensation(toolName) {
      return dependencies.compensationRegistry?.hasActions(toolName) ?? false;
    },
    async compensate(taskId, options) {
      if (dependencies.sagaOrchestrator === undefined) {
        throw new Error("TOOL_COMPENSATION_DEPENDENCY_UNAVAILABLE");
      }
      return dependencies.sagaOrchestrator.compensate(taskId, options);
    },
  };
}
