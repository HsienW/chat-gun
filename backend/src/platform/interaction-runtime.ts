import type { RunnableConfig } from "@langchain/core/runnables";
import type { Pool, PoolClient } from "pg";

import type { CancellationDecision } from "../runtime/interaction/cancel-decision.js";
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
  inputPayload: Uint8Array;
}

type ClassifyInteraction = (input: {
  payload: Uint8Array;
  idempotencyKey?: string;
  classifier: SemanticInputClassifier;
}) => Promise<InputClassificationResult>;

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
  ensureTask?: (context: InteractionRunContext) => Promise<void>;
  recordMetric?: (name: string, payload: MetricPayload, context?: ExecutionContext) => void | Promise<void>;
}

export type InteractionRunStart = {
  configured: boolean;
  context?: InteractionRunContext;
  ownership?: ActiveRunOwnership;
  events: InteractionTaskEvent[];
};

export interface InteractionOrchestrator {
  readonly isConfigured: boolean;
  beforeRun(input: unknown, config: unknown): Promise<InteractionRunStart>;
  afterRun(
    start: InteractionRunStart | undefined,
    terminalStatus: "completed" | "cancelled"
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

  return {
    ...(executionContext ? { executionContext } : {}),
    threadId,
    scopeId,
    taskId,
    runId,
    ...(requestId ? { requestId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
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

  return {
    isConfigured: true,
    async beforeRun(input: unknown, runnableConfig: unknown) {
      const context = readRunContext(input, runnableConfig);
      await config.ensureTask?.(context);
      const activeOwnership = await ownershipRepository.findActive(
        context.threadId,
        context.scopeId
      );

      if (!activeOwnership) {
        const claimed = await ownershipRepository.claim({
          threadId: context.threadId,
          scopeId: context.scopeId,
          taskId: context.taskId,
          runId: context.runId,
        });
        const event = createDecisionEvent({
          context,
          activeOwnership: claimed,
          eventType: "interaction_decision",
          strategy: loadedPolicy.policy.strategy,
          disposition: "initial_claim",
          reasonCode: "NO_ACTIVE_RUN",
        });
        await recordDecision(config, event, context);
        return {
          configured: true,
          context,
          ownership: claimed,
          events: [event],
        };
      }

      if (activeOwnership.runId === context.runId) {
        return {
          configured: true,
          context,
          ownership: activeOwnership,
          events: [],
        };
      }

      const classification = await classify({
        payload: context.inputPayload,
        ...(context.idempotencyKey
          ? { idempotencyKey: context.idempotencyKey }
          : {}),
        classifier,
      });
      const disposition = resolveClassificationDisposition({
        classification,
        policy: loadedPolicy.policy,
        hasWaitingHitl: false,
      });

      if (disposition.action === "await_confirmation") {
        const event = createDecisionEvent({
          context,
          activeOwnership,
          eventType: "input_classification_tentative",
          strategy: loadedPolicy.policy.strategy,
          disposition: disposition.action,
          classification: classification.classification,
          reasonCode: classification.reasonCode,
        });
        await recordDecision(config, event, context);
        throw new InteractionGovernanceRejectedError(
          "INPUT_CLASSIFICATION_CONFIRMATION_REQUIRED"
        );
      }

      const effectiveStrategy =
        disposition.action === "apply_policy"
          ? disposition.strategy
          : disposition.action === "reject"
            ? "reject"
            : loadedPolicy.policy.strategy;

      if (effectiveStrategy === "reject") {
        const event = createDecisionEvent({
          context,
          activeOwnership,
          eventType: "interaction_decision",
          strategy: effectiveStrategy,
          disposition: "reject",
          classification: classification.classification,
          reasonCode: classification.reasonCode,
        });
        await recordDecision(config, event, context);
        throw new InteractionGovernanceRejectedError("POLICY_REJECTED");
      }

      if (effectiveStrategy === "enqueue") {
        const event = createDecisionEvent({
          context,
          activeOwnership,
          eventType: "interaction_decision",
          strategy: effectiveStrategy,
          disposition: NATIVE_QUEUE_OWNERSHIP_REQUIRED_DISPOSITION,
          classification: classification.classification,
          reasonCode: NATIVE_QUEUE_OWNERSHIP_REQUIRED,
        });
        await recordDecision(config, event, context);
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
        throw new InteractionGovernanceRejectedError(
          "ACTIVE_RUN_REQUIRES_CORRECTIVE_OR_MANUAL_HANDLING"
        );
      }
      const replacement = await ownershipRepository.supersede({
        threadId: context.threadId,
        scopeId: context.scopeId,
        expectedGeneration: activeOwnership.generation,
        replacementTaskId: context.taskId,
        replacementRunId: context.runId,
      });
      const event = createDecisionEvent({
        context,
        activeOwnership,
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
      return {
        configured: true,
        context,
        ownership: replacement,
        events: [event],
      };
    },
    async afterRun(start, terminalStatus) {
      if (!start?.context || start.ownership?.runId !== start.context.runId) {
        return;
      }
      await ownershipRepository.markTerminal({
        threadId: start.context.threadId,
        scopeId: start.context.scopeId,
        runId: start.context.runId,
        status: terminalStatus,
      });
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
        isCancelled(error, config) ? "cancelled" : "completed"
      );
      throw error;
    }

    let completed = false;
    let terminalStatus: "completed" | "cancelled" = "cancelled";
    try {
      for (const event of start.events) {
        yield { interaction_runtime: { taskEvent: event } };
      }
      for await (const chunk of source) yield chunk;
      completed = true;
      terminalStatus = "completed";
    } catch (error) {
      terminalStatus = isCancelled(error, config) ? "cancelled" : "completed";
      throw error;
    } finally {
      if (!completed && terminalStatus !== "completed") {
        terminalStatus = "cancelled";
      }
      await orchestrator.afterRun(start, terminalStatus);
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
          let output: unknown;
          try {
            output = await invokeGraphMethod(member, target, input, config);
          } catch (error) {
            await orchestrator.afterRun(
              start,
              isCancelled(error, config) ? "cancelled" : "completed"
            );
            throw error;
          }
          await orchestrator.afterRun(start, "completed");
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
