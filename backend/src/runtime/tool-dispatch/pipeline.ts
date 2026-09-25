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
import { classifyError } from "../retry/error-classification.js";
import {
  createStepLock,
  NoopStepLock,
  type StepLock,
} from "../lock/step-lock.js";
import { DefaultStepTransitionGuard } from "../lock/step-transition-guard.js";
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
import { getAgentRuntimeConfig } from "../../platform/runtime-config.js";
import type { RuntimeToolDescriptorRegistry } from "./runtime-tool-descriptor.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import {
  createStructuredToolResultEnvelope,
  type StructuredToolResultEnvelope,
} from "./structured-tool-result.js";
import { PgToolDispatchTaskStepAdapter } from "./task-step-adapter.js";
import { ToolDispatchStepLockLease } from "./step-lock-lease.js";
import {
  InMemoryToolCircuitBreaker,
  type CircuitRecordOutcome,
  type ToolCircuitBreaker,
} from "./circuit-breaker.js";
import {
  FixedWindowToolRateLimiter,
  type ToolRateLimiter,
} from "./rate-limiter.js";
import {
  BoundedToolDispatchScheduler,
  ToolSchedulingError,
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
  rateLimiter?: ToolRateLimiter;
  circuitBreaker?: ToolCircuitBreaker;
  waitForDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  stepLock?: StepLock;
  stepLockTtlMs?: number;
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
  rateLimiter: ToolRateLimiter;
  circuitBreaker: ToolCircuitBreaker;
  waitForDelay: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  stepLock: StepLock;
  stepLockTtlMs: number;
} {
  return (
    dependencies.toolExecutionRunner !== undefined &&
    dependencies.retryBudgetFactory !== undefined &&
    dependencies.taskStepAdapter !== undefined &&
    dependencies.compensationRegistry !== undefined &&
    dependencies.sagaOrchestrator !== undefined &&
    dependencies.observability !== undefined &&
    dependencies.scheduler !== undefined &&
    dependencies.rateLimiter !== undefined &&
    dependencies.circuitBreaker !== undefined &&
    dependencies.waitForDelay !== undefined &&
    dependencies.stepLock !== undefined &&
    dependencies.stepLockTtlMs !== undefined
  );
}

async function waitForAbortableDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new ToolSchedulingError("USER_CANCELLED");
  }
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new ToolSchedulingError("USER_CANCELLED"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toCircuitRecordOutcome(
  outcome: GovernedToolOutcome<unknown>
): CircuitRecordOutcome | undefined {
  if (outcome.type === "succeeded") {
    return "success";
  }
  if (outcome.type !== "failed_not_committed") {
    return undefined;
  }
  const category = classifyError({
    code: outcome.errorCode,
    message: outcome.errorCode,
  }).category;
  return category === "permission_denied" || category === "user_cancelled"
    ? undefined
    : "definitive_failure";
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

async function recordLatency(
  observability: ToolDispatchObservability,
  metricName: "tool.schedule.queue_wait" | "tool.dispatch.total",
  startedAt: number,
  toolName: string,
  context: ExecutionContext
): Promise<void> {
  await ignoreObservabilityFailure(() =>
    observability.metric(
      metricName,
      {
        durationMs: Math.max(0, performance.now() - startedAt),
        toolName,
      },
      context
    )
  );
}

function authorizationUnavailable(): GovernedAuthorizationOutcome {
  return {
    type: "denied_by_authorization",
    errorCode: "AUTHORIZATION_UNAVAILABLE",
    decisionId: globalThis.crypto.randomUUID(),
  };
}

function withProductionDefaults(
  input: RuntimeToolDispatchPipelineDependencies,
  runtimeConfig: ReturnType<typeof getAgentRuntimeConfig>
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
      (pool && taskRepository && stepRepository && eventRepository
        ? new PgToolDispatchTaskStepAdapter({
            taskRepository,
            stepRepository,
            eventRepository,
            stepTransitionGuard: new DefaultStepTransitionGuard({
              db: pool,
              lock: new NoopStepLock(),
              lockTtlMs: runtimeConfig.toolDispatchStepLockTtlMs,
            }),
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
    scheduler:
      input.scheduler ??
      new BoundedToolDispatchScheduler({
        maxConcurrentReads: runtimeConfig.toolDispatchMaxConcurrentReads,
        maxConcurrentReadsPerRun:
          runtimeConfig.toolDispatchMaxConcurrentReadsPerRun,
      }),
    rateLimiter:
      input.rateLimiter ??
      new FixedWindowToolRateLimiter(runtimeConfig.toolRetryAfterMaxMs),
    circuitBreaker: input.circuitBreaker ?? new InMemoryToolCircuitBreaker(),
    waitForDelay: input.waitForDelay ?? waitForAbortableDelay,
    stepLock: input.stepLock ?? createStepLock(),
    stepLockTtlMs:
      input.stepLockTtlMs ?? runtimeConfig.toolDispatchStepLockTtlMs,
  };
}

export function createRuntimeToolDispatchPipeline(
  input: RuntimeToolDispatchPipelineDependencies
): RuntimeToolDispatchPipeline {
  const runtimeConfig = getAgentRuntimeConfig();
  const dependencies = withProductionDefaults(input, runtimeConfig);
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
    const signal = getAbortSignal(config);
    const dispatchStartedAt = performance.now();

    try {
      let rateLimitDecision;
      try {
        rateLimitDecision = dependencies.rateLimiter.check(
          descriptor.toolName,
          descriptor.rateLimitPolicy,
          signal
        );
      } catch {
        return signal?.aborted
          ? { type: "cancelled", dispatchState: "before" }
          : {
              type: "rejected_before_dispatch",
              errorCode: "TOOL_RATE_LIMIT_EVALUATION_FAILED",
            };
      }
      if (rateLimitDecision.type === "deny") {
        return {
          type: "rejected_before_dispatch",
          errorCode: rateLimitDecision.errorCode,
        };
      }
      if (rateLimitDecision.type === "defer") {
        try {
          await dependencies.waitForDelay(
            rateLimitDecision.retryAfterMs,
            signal
          );
        } catch {
          return signal?.aborted
            ? { type: "cancelled", dispatchState: "before" }
            : {
                type: "rejected_before_dispatch",
                errorCode: "TOOL_RATE_LIMIT_WAIT_FAILED",
              };
        }
      }

      let circuitState;
      try {
        circuitState = dependencies.circuitBreaker.beforeDispatch(
          descriptor.toolName,
          descriptor.circuitBreakerPolicy
        );
      } catch {
        await ignoreObservabilityFailure(() =>
          dependencies.observability.audit(
            "tool.circuit.evaluation_failed",
            {
              toolName: descriptor.toolName,
              errorCode: "TOOL_CIRCUIT_EVALUATION_FAILED",
            },
            executionContext
          )
        );
        return {
          type: "failed_not_committed",
          errorCode: "TOOL_CIRCUIT_EVALUATION_FAILED",
        };
      }
      if (circuitState === "open") {
        return {
          type: "failed_not_committed",
          errorCode: "TOOL_CIRCUIT_OPEN",
        };
      }

      const lockOwner = `${executionContext.runId}:${toolCallId}`;
      let stepLockLease: ToolDispatchStepLockLease | null;
      try {
        stepLockLease = await ToolDispatchStepLockLease.acquire({
          lock: dependencies.stepLock,
          stepId,
          owner: lockOwner,
          ttlMs: dependencies.stepLockTtlMs,
          signal,
        });
      } catch {
        await ignoreObservabilityFailure(() =>
          dependencies.observability.audit(
            "tool.step_lock.acquire_failed",
            {
              toolName: descriptor.toolName,
              errorCode: "TOOL_STEP_LOCK_UNAVAILABLE",
            },
            executionContext
          )
        );
        stepLockLease = null;
      }
      if (stepLockLease === null) {
        return {
          type: "rejected_before_dispatch",
          errorCode: "TOOL_STEP_LOCK_UNAVAILABLE",
        };
      }

      try {
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
        const queueStartedAt = dispatchStartedAt;
        let queueWaitRecorded = false;
        const recordQueueWait = async () => {
          if (queueWaitRecorded) return;
          queueWaitRecorded = true;
          await recordLatency(
            dependencies.observability,
            "tool.schedule.queue_wait",
            queueStartedAt,
            descriptor.toolName,
            executionContext
          );
        };
        let governedOutcome: GovernedToolOutcome<unknown>;
        try {
          const runnerResult = await dependencies.scheduler.schedule(
            isConcurrencySafe ? "concurrent_safe" : "serial",
            async () => {
              await recordQueueWait();
              return dependencies.toolExecutionRunner.execute({
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
                descriptor: descriptor.isReadOnly
                  ? undefined
                  : descriptor.sideEffect,
                validateResult: (result) =>
                  descriptor.outputSchema.safeParse(result).success,
                retryBudget: dependencies.retryBudgetFactory(
                  stepId,
                  retryPolicy
                ),
                retryPolicy,
                retryAfterMaxMs: runtimeConfig.toolRetryAfterMaxMs,
                signal: stepLockLease.signal,
              });
            },
            { runId: executionContext.runId, signal: stepLockLease.signal }
          );
          governedOutcome = mapRunnerResult(runnerResult, descriptor);
        } catch (error) {
          await recordQueueWait();
          if (error instanceof ToolSchedulingError) {
            governedOutcome =
              error.code === "USER_CANCELLED"
                ? { type: "cancelled", dispatchState: "before" }
                : {
                    type: "rejected_before_dispatch",
                    errorCode: error.code,
                  };
          } else {
            throw error;
          }
        }
        if (stepLockLease.hasExtendFailed()) {
          governedOutcome = {
            type: "ambiguous_after_dispatch",
            errorCode: "TOOL_STEP_LOCK_EXTEND_FAILED",
          };
        }
        const circuitRecordOutcome = toCircuitRecordOutcome(governedOutcome);
        if (circuitRecordOutcome !== undefined) {
          dependencies.circuitBreaker.record(
            descriptor.toolName,
            descriptor.circuitBreakerPolicy,
            circuitRecordOutcome
          );
        }
        let envelope = createStructuredToolResultEnvelope({
          executionContext,
          descriptor,
          outcome: governedOutcome,
        });

        try {
          if (governedOutcome.type === "succeeded") {
            await dependencies.taskStepAdapter.complete(
              executionContext,
              envelope
            );
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
            recordOutcome(
              dependencies.observability,
              envelope,
              executionContext
            ),
          ]);
          return { type: "succeeded", result: envelope };
        }
        await recordOutcome(
          dependencies.observability,
          envelope,
          executionContext
        );

        return { type: "succeeded", result: envelope };
      } finally {
        await stepLockLease.release().catch(() => undefined);
      }
    } finally {
      await recordLatency(
        dependencies.observability,
        "tool.dispatch.total",
        dispatchStartedAt,
        descriptor.toolName,
        executionContext
      );
    }
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
