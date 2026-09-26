import type { RunnableConfig } from "@langchain/core/runnables";
import type { Pool, PoolClient } from "pg";

import type { CancellationDecision } from "../runtime/interaction/cancel-decision.js";
import {
  PgIdempotencyGuard,
  type IdempotencyGuard,
} from "../runtime/idempotency/idempotency-guard.js";
import type { IdempotencyKey } from "../runtime/idempotency/idempotency-key.js";
import {
  readNormalizedAgentInput,
  type ReadNormalizedAgentInputResult,
} from "../runtime/input/read-normalized-agent-input.js";
import type { NormalizedAgentInput } from "../runtime/input/normalized-agent-input.js";
import {
  GenerationQueryGuard,
  type QueryGuard,
} from "../runtime/input/query-guard.js";
import {
  classifyInteractionInput,
  resolveClassificationDisposition,
  type InputClassificationResult,
  type SemanticInputClassifier,
} from "../runtime/interaction/classify.js";
import {
  createInteractionInputReference,
  createInteractionTaskEvent,
  InteractionEventRecorder,
  type InteractionTaskEvent,
} from "../runtime/interaction/events.js";
import type {
  ActiveRunOwnership,
  ActiveRunOwnershipRepository,
  OwnershipDatabase,
} from "../runtime/interaction/ownership.js";
import { PgActiveRunOwnershipRepository } from "../runtime/interaction/ownership.js";
import {
  loadInteractionPolicy,
  type InteractionPolicy,
  type InteractionStrategy,
} from "../runtime/interaction/policy.js";
import { PgEventRepository } from "../runtime/persistence/event-repository.js";
import { readCanonicalExecutionContext, readExecutionCorrelation } from "../runtime/execution-context/read-execution-context.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { getPool } from "../runtime/persistence/connection.js";
import type { Queryable } from "../runtime/persistence/rows.js";
import { getEnv } from "./env.js";
import { auditLogger, recordMetric } from "./observability.js";
import { getSpanManager } from "./tracing/span-manager.js";

const STREAM_METHODS = new Set<PropertyKey>([
  "stream",
  "streamEvents",
  "streamLog",
]);
const NATIVE_QUEUE_OWNERSHIP_REQUIRED = "NATIVE_QUEUE_OWNERSHIP_REQUIRED";
const NATIVE_QUEUE_OWNERSHIP_REQUIRED_DISPOSITION =
  "native_queue_ownership_required";

type MetricPayload = Record<string, string | number | boolean>;

export interface InteractionRunContext {
  executionContext?: ExecutionContext;
  threadId: string;
  scopeId: string;
  taskId: string;
  runId: string;
  requestId?: string;
  idempotencyKey?: string;
  clientActiveRunHint?: {
    runId: string;
    generation: number;
  };
  normalizedInput?: Exclude<NormalizedAgentInput, { kind: "command" }>;
  idempotencyRecordKey?: IdempotencyKey;
  idempotencyTtlMs?: number;
  inputPayload: Uint8Array;
}

type ClassifyInteraction = (
  input: Parameters<typeof classifyInteractionInput>[0]
) => Promise<InputClassificationResult>;

type DecideRunCancellation = (input: {
  activeOwnership: ActiveRunOwnership;
  replacement: Pick<InteractionRunContext, "taskId" | "runId">;
  policy: InteractionPolicy;
}) => Promise<CancellationDecision>;

export interface InteractionOrchestratorConfig {
  rawPolicy?: string;
  ownershipRepository?: ActiveRunOwnershipRepository;
  classifier?: SemanticInputClassifier;
  classify?: ClassifyInteraction;
  decideCancellation?: DecideRunCancellation;
  eventRecorder?: Pick<InteractionEventRecorder, "record">;
  queryGuard?: QueryGuard;
  idempotencyGuard?: Pick<
    IdempotencyGuard,
    "acquire" | "markCompleted" | "markFailed"
  >;
  loadPriorInput?: (
    ownership: ActiveRunOwnership
  ) => Promise<{ idempotencyKey: string; payload: Uint8Array } | undefined>;
  ensureTask?: (context: InteractionRunContext) => Promise<void>;
  recordMetric?: (name: string, payload: MetricPayload, context?: ExecutionContext) => void | Promise<void>;
}

export type InteractionRunStart = {
  configured: boolean;
  context?: InteractionRunContext;
  ownership?: ActiveRunOwnership;
  events: InteractionTaskEvent[];
  outcome?: "run" | "reused";
  reusedResult?: unknown;
};

export interface InteractionOrchestrator {
  readonly isConfigured: boolean;
  beforeRun(input: unknown, config: unknown): Promise<InteractionRunStart>;
  afterRun(
    start: InteractionRunStart | undefined,
    terminalStatus: "completed" | "cancelled",
    result?: unknown,
    failed?: boolean,
  ): Promise<void>;
}

export class InteractionRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionRuntimeConfigurationError";
  }
}

export class InteractionGovernanceRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super("Interaction request rejected by configured policy");
    this.name = "InteractionGovernanceRejectedError";
  }
}

class PoolOwnershipDatabase implements OwnershipDatabase {
  constructor(private readonly pool: Pool) {}

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: TResult[]; rowCount: number | null }> {
    const result = await this.pool.query<TResult>(text, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async withTransaction<TResult>(
    operation: (transaction: Queryable) => Promise<TResult>
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(createClientQueryable(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function createClientQueryable(client: PoolClient): Queryable {
  return {
    async query<
      TResult extends Record<string, unknown> = Record<string, unknown>,
    >(text: string, values?: readonly unknown[]) {
      const result = await client.query<TResult>(text, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

async function ensureInteractionTask(
  pool: Pool,
  context: InteractionRunContext
): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO agent_tasks
       (task_id, task_type, status, metadata, created_at, updated_at)
     VALUES ($1, $2, 'running', $3, $4, $4)
     ON CONFLICT (task_id) DO NOTHING`,
    [context.taskId, "interaction_runtime", { source: "graph_wrapper" }, now]
  );
}

export function createProductionInteractionOrchestrator(
  overrides: InteractionOrchestratorConfig = {}
): InteractionOrchestrator {
  const rawPolicy = overrides.rawPolicy ?? getEnv("INTERACTION_POLICY");
  if (!loadInteractionPolicy(rawPolicy).configured) {
    return createInteractionOrchestrator({ ...overrides, rawPolicy });
  }

  const pool = getPool();
  if (!pool) {
    throw new InteractionRuntimeConfigurationError(
      "Configured interaction governance requires DATABASE_URL"
    );
  }
  const ownershipDatabase = new PoolOwnershipDatabase(pool);
  const eventRecorder = new InteractionEventRecorder(
    new PgEventRepository(pool),
    auditLogger,
    getSpanManager()
  );

  return createInteractionOrchestrator({
    ownershipRepository: new PgActiveRunOwnershipRepository(ownershipDatabase),
    idempotencyGuard: new PgIdempotencyGuard(pool),
    eventRecorder,
    ensureTask: (context) => ensureInteractionTask(pool, context),
    recordMetric,
    ...overrides,
    rawPolicy,
  });
}

export const productionInteractionOrchestrator =
  createProductionInteractionOrchestrator();

class UnavailableSemanticInputClassifier implements SemanticInputClassifier {
  readonly version = "interaction-classifier-unavailable-v1";

  async suggest(): Promise<never> {
    throw new Error("Semantic interaction classifier is not configured");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[]
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function readPositiveGeneration(value: unknown): number | undefined {
  const generation =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : undefined;
  return generation !== undefined &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? generation
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : undefined;
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function isTrustedDedupKey(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/.test(value);
}

function serializeInput(input: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(input));
  } catch {
    throw new InteractionRuntimeConfigurationError(
      "Interaction graph input must be JSON serializable"
    );
  }
}

function readRunContext(input: unknown, config: unknown): InteractionRunContext {
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const records = [runnableConfig, configurable];
  const correlation = readExecutionCorrelation(config);
  const executionContext = readCanonicalExecutionContext(config);
  const { threadId, runId, requestId } = correlation;
  if (!threadId || !runId) {
    throw new InteractionRuntimeConfigurationError(
      "Configured interaction governance requires threadId and runId"
    );
  }

  // Legacy interaction callers may omit taskId until the bounded migration ends.
  const taskId = correlation.taskId ?? runId;
  const scopeId = readString(records, ["scope_id", "scopeId"]) ?? threadId;
  const idempotencyKey = readString(records, [
    "x-idempotency-key",
    "idempotency_key",
    "idempotencyKey",
  ]);
  const hintedRunId = readString(records, ["x-active-run-id", "activeRunId"]);
  const hintedGeneration = readPositiveGeneration(
    configurable["x-active-run-generation"] ?? configurable.activeRunGeneration
  );
  const idempotencyTtlMs = readPositiveInteger(
    configurable["x-bff-idempotency-ttl-ms"]
  );

  return {
    ...(executionContext ? { executionContext } : {}),
    threadId,
    scopeId,
    taskId,
    runId,
    ...(requestId ? { requestId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(idempotencyTtlMs ? { idempotencyTtlMs } : {}),
    ...(hintedRunId && hintedGeneration
      ? { clientActiveRunHint: { runId: hintedRunId, generation: hintedGeneration } }
      : {}),
    inputPayload: serializeInput(input),
  };
}

function eventTypeForStrategy(
  strategy: InteractionStrategy
): InteractionTaskEvent["eventType"] {
  if (strategy === "supersede") return "superseded";
  if (strategy === "interrupt") return "cancelling";
  if (strategy === "rollback") return "rollback_requested";
  return "interaction_decision";
}

function createDecisionEvent(input: {
  context: InteractionRunContext;
  activeOwnership: ActiveRunOwnership;
  replacementOwnership?: ActiveRunOwnership;
  eventType: InteractionTaskEvent["eventType"];
  strategy: string;
  disposition: string;
  reasonCode: string;
  classification?: InputClassificationResult["classification"];
  interruptId?: string;
  sideEffectState?: CancellationDecision["phase"];
  cancellationPath?: string;
}): InteractionTaskEvent {
  const authoritativeOwnership =
    input.replacementOwnership ?? input.activeOwnership;
  return createInteractionTaskEvent({
    ...(input.context.executionContext
      ? { executionContext: input.context.executionContext }
      : {}),
    eventType: input.eventType,
    threadId: input.context.threadId,
    priorTaskId: input.activeOwnership.taskId,
    priorRunId: input.activeOwnership.runId,
    replacementTaskId: input.replacementOwnership?.taskId ?? null,
    replacementRunId: input.replacementOwnership?.runId ?? null,
    generation: authoritativeOwnership.generation,
    ...(input.interruptId ? { interruptId: input.interruptId } : {}),
    input: createInteractionInputReference(
      input.context.inputPayload,
      input.classification
    ),
    sideEffectState: input.sideEffectState ?? "read_only",
    compensationResult:
      input.cancellationPath === "compensated_then_supersede"
        ? input.cancellationPath
        : null,
    reconciliationResult:
      input.cancellationPath?.includes("reconcil") === true
        ? input.cancellationPath
        : null,
    decision: {
      strategy: input.strategy,
      disposition: input.disposition,
      ...(input.classification
        ? { classification: input.classification }
        : {}),
      reasonCode: input.reasonCode,
    },
  });
}

function requireConfiguredDependencies(config: InteractionOrchestratorConfig) {
  if (!config.ownershipRepository || !config.eventRecorder) {
    throw new InteractionRuntimeConfigurationError(
      "Configured interaction governance requires ownership and event persistence"
    );
  }
  return {
    ownershipRepository: config.ownershipRepository,
    eventRecorder: config.eventRecorder,
  };
}

async function recordDecision(
  config: InteractionOrchestratorConfig,
  event: InteractionTaskEvent,
  context: InteractionRunContext
): Promise<void> {
  if (context.executionContext) {
    await config.eventRecorder?.record(event, context.executionContext);
  } else {
    await config.eventRecorder?.record(event);
  }
  const metric = {
    eventType: event.eventType,
    strategy: event.payload.decision?.strategy ?? "unknown",
    disposition: event.payload.decision?.disposition ?? "unknown",
  };
  if (context.executionContext) {
    await config.recordMetric?.("interaction.decision", metric, context.executionContext);
  } else {
    await config.recordMetric?.("interaction.decision", metric);
  }
}

function isSupersedingStrategy(
  strategy: InteractionStrategy
): strategy is "interrupt" | "supersede" | "rollback" {
  return (
    strategy === "interrupt" ||
    strategy === "supersede" ||
    strategy === "rollback"
  );
}

export function createInteractionOrchestrator(
  config: InteractionOrchestratorConfig
): InteractionOrchestrator {
  const loadedPolicy = loadInteractionPolicy(config.rawPolicy);
  if (!loadedPolicy.configured) {
    return {
      isConfigured: false,
      async beforeRun() {
        return { configured: false, events: [] };
      },
      async afterRun() {},
    };
  }

  const { ownershipRepository } = requireConfiguredDependencies(config);
  const classifier =
    config.classifier ?? new UnavailableSemanticInputClassifier();
  const classify =
    config.classify ??
    ((classificationInput) => classifyInteractionInput(classificationInput));
  const queryGuard =
    config.queryGuard ?? new GenerationQueryGuard(ownershipRepository);

  async function cleanupBeforeDispatch(
    context: InteractionRunContext,
    ownership: ActiveRunOwnership,
  ): Promise<void> {
    await ownershipRepository.markTerminal({
      threadId: context.threadId,
      scopeId: context.scopeId,
      runId: context.runId,
      status: "cancelled",
    });
    await queryGuard.release(context, ownership.generation);
    if (context.idempotencyRecordKey) {
      await config.idempotencyGuard?.markFailed(context.idempotencyRecordKey);
    }
  }

  async function rejectBeforeDispatch(input: {
    context: InteractionRunContext;
    ownership: ActiveRunOwnership;
    reasonCode: string;
    classification?: InputClassificationResult["classification"];
    strategy?: string;
    disposition?: string;
  }): Promise<InteractionTaskEvent> {
    await cleanupBeforeDispatch(input.context, input.ownership);
    const event = createDecisionEvent({
      context: input.context,
      activeOwnership: input.ownership,
      eventType: "cancelled",
      strategy: input.strategy ?? "reject",
      disposition: input.disposition ?? "reject",
      ...(input.classification
        ? { classification: input.classification }
        : {}),
      reasonCode: input.reasonCode,
    });
    await recordDecision(config, event, input.context);
    return event;
  }

  return {
    isConfigured: true,
    async beforeRun(input: unknown, runnableConfig: unknown) {
      let context = readRunContext(input, runnableConfig);
      const normalizedResult: ReadNormalizedAgentInputResult =
        readNormalizedAgentInput(input, runnableConfig);
      if (normalizedResult.status === "invalid") {
        throw new InteractionGovernanceRejectedError(
          normalizedResult.errorCode
        );
      }
      context = {
        ...context,
        ...(normalizedResult.status === "valid"
          ? { normalizedInput: normalizedResult.input }
          : {}),
        inputPayload: serializeInput(normalizedResult.input),
      };

      const proposedGeneration =
        context.clientActiveRunHint?.generation !== undefined &&
        context.clientActiveRunHint.generation < Number.MAX_SAFE_INTEGER
          ? context.clientActiveRunHint.generation + 1
          : 1;
      const reservation = await queryGuard.reserve(context, proposedGeneration);
      const reservedOwnership = reservation.ownership;
      if (!reservedOwnership) {
        throw new InteractionGovernanceRejectedError(
          "QUERY_DISPATCH_IN_PROGRESS"
        );
      }
      let activeOwnership = reservedOwnership;
      try {
        await config.ensureTask?.(context);

      if (
        isTrustedDedupKey(context.idempotencyKey) &&
        config.idempotencyGuard
      ) {
        const idempotencyRecordKey: IdempotencyKey = {
          namespace: "interaction_input",
          resourceKey: context.idempotencyKey,
          version: "1",
        };
        const acquired = await config.idempotencyGuard.acquire(
          idempotencyRecordKey,
          context.idempotencyTtlMs ?? 60_000
        );
        if (!acquired.acquired && acquired.reason === "already_completed") {
          const event = await rejectBeforeDispatch({
            context,
            ownership: activeOwnership,
            reasonCode: "IDEMPOTENCY_KEY_COMPLETED",
            classification: "duplicate_input",
            disposition: "reuse_existing",
          });
          return {
            configured: true,
            context,
            ownership: activeOwnership,
            events: [event],
            outcome: "reused",
            reusedResult: acquired.existing.result,
          };
        }
        if (!acquired.acquired) {
          const reasonCode =
            acquired.reason === "already_locked"
              ? "IDEMPOTENCY_KEY_LOCKED"
              : "IDEMPOTENCY_KEY_FAILED";
          await rejectBeforeDispatch({
            context,
            ownership: activeOwnership,
            reasonCode,
            disposition: "reject",
          });
          throw new InteractionGovernanceRejectedError(reasonCode);
        }
        if (acquired.acquired) {
          context = { ...context, idempotencyRecordKey };
        }
      }

      if (normalizedResult.status === "unsupported") {
        await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          reasonCode: normalizedResult.errorCode,
          disposition: "unsupported",
        });
        throw new InteractionGovernanceRejectedError(
          normalizedResult.errorCode
        );
      }

      if (
        normalizedResult.input.kind === "cancel" &&
        normalizedResult.input.targetRunId === undefined
      ) {
        const event = await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          reasonCode: "NOTHING_TO_CANCEL",
          classification: "cancel_request",
          disposition: "no_op",
        });
        return {
          configured: true,
          context,
          ownership: activeOwnership,
          events: [event],
          outcome: "reused",
          reusedResult: { status: "no_op", reason: "nothing_to_cancel" },
        };
      }

      if (reservation.reserved) {
        if (normalizedResult.input.kind === "clarification_resume") {
          await rejectBeforeDispatch({
            context,
            ownership: activeOwnership,
            reasonCode: "CLARIFICATION_TASK_NOT_FOUND",
            classification: "clarification_answer",
          });
          throw new InteractionGovernanceRejectedError(
            "CLARIFICATION_TASK_NOT_FOUND"
          );
        }
        if (normalizedResult.input.kind === "cancel") {
          const event = await rejectBeforeDispatch({
            context,
            ownership: activeOwnership,
            reasonCode: "NOTHING_TO_CANCEL",
            classification: "cancel_request",
            disposition: "no_op",
          });
          return {
            configured: true,
            context,
            ownership: activeOwnership,
            events: [event],
            outcome: "reused",
            reusedResult: { status: "no_op", reason: "nothing_to_cancel" },
          };
        }
        const event = createDecisionEvent({
          context,
          activeOwnership,
          eventType: "interaction_decision",
          strategy: loadedPolicy.policy.strategy,
          disposition: "initial_claim",
          reasonCode: "NO_ACTIVE_RUN",
        });
        await recordDecision(config, event, context);
        await queryGuard.dispatch(context, activeOwnership.generation);
        return {
          configured: true,
          context,
          ownership: activeOwnership,
          events: [event],
          outcome: "run",
        };
      }

      if (activeOwnership.runId === context.runId) {
        return {
          configured: true,
          context,
          ownership: activeOwnership,
          events: [],
          outcome: "run",
        };
      }

      const priorInput = !isTrustedDedupKey(context.idempotencyKey)
        ? await config.loadPriorInput?.(activeOwnership)
        : undefined;
      const isClarificationResume =
        normalizedResult.input.kind === "clarification_resume";
      const clarificationInterruptId =
        normalizedResult.input.kind === "clarification_resume"
        ? normalizedResult.input.interruptId
        : undefined;
      const classification = await classify({
        payload: context.inputPayload,
        ...(context.idempotencyKey
          ? { idempotencyKey: context.idempotencyKey }
          : {}),
        ...(priorInput ? { priorInput } : {}),
        ...(normalizedResult.input.kind === "cancel"
          ? {
              cancelSignal: {
                requested: true as const,
                source: "business_cancel" as const,
              },
            }
          : {}),
        ...(isClarificationResume
          ? {
              waitingTask: {
                taskId: activeOwnership.taskId,
                runId: activeOwnership.runId,
                confirmationType: "clarification",
              },
              replyToTaskId: activeOwnership.taskId,
            }
          : {}),
        classifier,
      });
      const disposition = resolveClassificationDisposition({
        classification,
        policy: loadedPolicy.policy,
        hasWaitingHitl: isClarificationResume,
      });

      if (disposition.action === "await_confirmation") {
        await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          reasonCode: "INPUT_CLASSIFICATION_CONFIRMATION_REQUIRED",
          classification: classification.classification,
          disposition: disposition.action,
        });
        throw new InteractionGovernanceRejectedError(
          "INPUT_CLASSIFICATION_CONFIRMATION_REQUIRED"
        );
      }

      if (disposition.action === "reuse_existing") {
        const event = await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          reasonCode: classification.reasonCode,
          classification: classification.classification,
          disposition: disposition.action,
        });
        return {
          configured: true,
          context,
          ownership: activeOwnership,
          events: [event],
          outcome: "reused",
          reusedResult: { status: "duplicate_input" },
        };
      }

      if (disposition.action === "resume_same_task") {
        const priorOwnership = activeOwnership;
        const replacement = await ownershipRepository.supersede({
          threadId: context.threadId,
          scopeId: context.scopeId,
          expectedGeneration: activeOwnership.generation,
          replacementTaskId: disposition.taskId,
          replacementRunId: context.runId,
        });
        queryGuard.adopt(replacement, "dispatching");
        activeOwnership = replacement;
        const event = createDecisionEvent({
          context,
          activeOwnership: priorOwnership,
          replacementOwnership: replacement,
          eventType: "clarification_resumed",
          strategy: "resume_same_task",
          disposition: disposition.action,
          classification: classification.classification,
          ...(clarificationInterruptId
            ? { interruptId: clarificationInterruptId }
            : {}),
          reasonCode: classification.reasonCode,
        });
        await recordDecision(config, event, context);
        await queryGuard.dispatch(context, replacement.generation);
        return {
          configured: true,
          context,
          ownership: replacement,
          events: [event],
          outcome: "run",
        };
      }

      const effectiveStrategy =
        disposition.action === "apply_policy"
          ? disposition.strategy
          : disposition.action === "reject"
            ? "reject"
            : loadedPolicy.policy.strategy;

      if (effectiveStrategy === "reject") {
        await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          strategy: effectiveStrategy,
          disposition: "reject",
          classification: classification.classification,
          reasonCode: classification.reasonCode,
        });
        throw new InteractionGovernanceRejectedError("POLICY_REJECTED");
      }

      if (effectiveStrategy === "enqueue") {
        await rejectBeforeDispatch({
          context,
          ownership: activeOwnership,
          strategy: effectiveStrategy,
          disposition: NATIVE_QUEUE_OWNERSHIP_REQUIRED_DISPOSITION,
          classification: classification.classification,
          reasonCode: NATIVE_QUEUE_OWNERSHIP_REQUIRED,
        });
        throw new InteractionGovernanceRejectedError(
          NATIVE_QUEUE_OWNERSHIP_REQUIRED
        );
      }

      if (!isSupersedingStrategy(effectiveStrategy)) {
        throw new InteractionRuntimeConfigurationError(
          `Unsupported interaction strategy: ${effectiveStrategy}`
        );
      }

      if (!config.decideCancellation) {
        throw new InteractionRuntimeConfigurationError(
          "Superseding interaction strategies require cancellation governance"
        );
      }
      const cancellation = await config.decideCancellation({
        activeOwnership,
        replacement: { taskId: context.taskId, runId: context.runId },
        policy: loadedPolicy.policy,
      });
      if (
        cancellation.path !== "interrupt_or_supersede" &&
        cancellation.path !== "compensated_then_supersede"
      ) {
        await ownershipRepository.markTerminal({
          threadId: context.threadId,
          scopeId: context.scopeId,
          runId: context.runId,
          status: "cancelled",
        });
        const event = createDecisionEvent({
          context,
          activeOwnership,
          eventType:
            cancellation.path === "corrective_authorized"
              ? "cancelled_after_commit"
              : "manual_intervention_required",
          strategy: effectiveStrategy,
          disposition: cancellation.path,
          classification: classification.classification,
          reasonCode: classification.reasonCode,
          sideEffectState: cancellation.phase,
          cancellationPath: cancellation.path,
        });
        await recordDecision(config, event, context);
        await queryGuard.release(context, activeOwnership.generation);
        if (context.idempotencyRecordKey) {
          await config.idempotencyGuard?.markFailed(
            context.idempotencyRecordKey
          );
        }
        throw new InteractionGovernanceRejectedError(
          "ACTIVE_RUN_REQUIRES_CORRECTIVE_OR_MANUAL_HANDLING"
        );
      }
      const priorOwnership = activeOwnership;
      const replacement = await ownershipRepository.supersede({
        threadId: context.threadId,
        scopeId: context.scopeId,
        expectedGeneration: activeOwnership.generation,
        replacementTaskId: context.taskId,
        replacementRunId: context.runId,
      });
      queryGuard.adopt(replacement, "dispatching");
      activeOwnership = replacement;
      const event = createDecisionEvent({
        context,
        activeOwnership: priorOwnership,
        replacementOwnership: replacement,
        eventType: eventTypeForStrategy(effectiveStrategy),
        strategy: effectiveStrategy,
        disposition: disposition.action,
        classification: classification.classification,
        reasonCode: classification.reasonCode,
        sideEffectState: cancellation.phase,
        cancellationPath: cancellation.path,
      });
      await recordDecision(config, event, context);
      await queryGuard.dispatch(context, replacement.generation);
      return {
        configured: true,
        context,
        ownership: replacement,
        events: [event],
        outcome: "run",
      };
      } catch (error) {
        if (!(error instanceof InteractionGovernanceRejectedError)) {
          await cleanupBeforeDispatch(context, activeOwnership);
        }
        throw error;
      }
    },
    async afterRun(start, terminalStatus, result, failed = false) {
      if (!start?.context || start.ownership?.runId !== start.context.runId) {
        return;
      }
      await ownershipRepository.markTerminal({
        threadId: start.context.threadId,
        scopeId: start.context.scopeId,
        runId: start.context.runId,
        status: terminalStatus,
      });
      await queryGuard.release(start.context, start.ownership.generation);
      if (start.context.idempotencyRecordKey) {
        if (failed) {
          await config.idempotencyGuard?.markFailed(
            start.context.idempotencyRecordKey
          );
        } else {
          await config.idempotencyGuard?.markCompleted(
            start.context.idempotencyRecordKey,
            result
          );
        }
      }
    },
  };
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof value[Symbol.asyncIterator] === "function"
  );
}

function isCancelled(error: unknown, config: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (!isRecord(config)) return false;
  const signal = config.signal;
  return signal instanceof AbortSignal && signal.aborted;
}

async function invokeGraphMethod(
  method: (...args: unknown[]) => unknown,
  target: object,
  input: unknown,
  config: unknown
): Promise<unknown> {
  return await Promise.resolve(Reflect.apply(method, target, [input, config]));
}

function createGovernedStream(
  method: (...args: unknown[]) => unknown,
  target: object,
  input: unknown,
  config: unknown,
  orchestrator: InteractionOrchestrator
): AsyncIterable<unknown> {
  return (async function* generateGovernedStream() {
    const start = await orchestrator.beforeRun(input, config);
    if (start.outcome === "reused") {
      for (const event of start.events) {
        yield { interaction_runtime: { taskEvent: event } };
      }
      if (start.reusedResult !== undefined) {
        yield { interaction_runtime: { reusedResult: start.reusedResult } };
      }
      return;
    }
    let source: unknown;
    try {
      source = await invokeGraphMethod(method, target, input, config);
      if (!isAsyncIterable(source)) {
        throw new TypeError(
          "Interaction-governed graph stream method did not return an AsyncIterable"
        );
      }
    } catch (error) {
      await orchestrator.afterRun(
        start,
        isCancelled(error, config) ? "cancelled" : "completed",
        undefined,
        true
      );
      throw error;
    }

    let completed = false;
    let failed = false;
    let terminalStatus: "completed" | "cancelled" = "cancelled";
    try {
      for (const event of start.events) {
        yield { interaction_runtime: { taskEvent: event } };
      }
      for await (const chunk of source) yield chunk;
      completed = true;
      terminalStatus = "completed";
    } catch (error) {
      failed = true;
      terminalStatus = isCancelled(error, config) ? "cancelled" : "completed";
      throw error;
    } finally {
      if (!completed && terminalStatus !== "completed") {
        terminalStatus = "cancelled";
      }
      await orchestrator.afterRun(start, terminalStatus, undefined, failed);
    }
  })();
}

export function applyInteractionGovernance<TGraph extends object>(
  graph: TGraph,
  orchestrator: InteractionOrchestrator
): TGraph {
  if (!orchestrator.isConfigured) return graph;

  return new Proxy(graph, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (!isCallable(member)) return member;

      if (property === "invoke") {
        return async (input: unknown, config?: RunnableConfig) => {
          const start = await orchestrator.beforeRun(input, config);
          if (start.outcome === "reused") {
            return start.reusedResult;
          }
          let output: unknown;
          try {
            output = await invokeGraphMethod(member, target, input, config);
          } catch (error) {
            await orchestrator.afterRun(
              start,
              isCancelled(error, config) ? "cancelled" : "completed",
              undefined,
              true
            );
            throw error;
          }
          await orchestrator.afterRun(start, "completed", output);
          return output;
        };
      }

      if (STREAM_METHODS.has(property)) {
        return (input: unknown, config?: RunnableConfig) =>
          createGovernedStream(member, target, input, config, orchestrator);
      }

      return member.bind(target);
    },
  });
}
