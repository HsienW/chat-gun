import { randomUUID } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import { z } from "zod";

import { createDispatchReadinessCheck } from "../../agents/shopping-assistant/dispatch-readiness.js";
import { createShoppingAssistantGraph } from "../../agents/shopping-assistant/graph.js";
import { PgOrderOperationRequestStore } from "../../agents/shopping-assistant/operation-requests.js";
import { PgOrderOperationStatusReader } from "../../agents/shopping-assistant/operation-status.js";
import { PgOriginalOperationResolver } from "../../agents/shopping-assistant/original-operation.js";
import type { ShoppingAssistantState } from "../../agents/shopping-assistant/state.js";
import type { SourceDocument } from "../../knowledge/corpus.js";
import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import { applyToolGovernance } from "../../platform/tool-governance.js";
import { createNoopSpanManager } from "../../platform/tracing/span-manager.js";
import type { ConfirmationRequiredDescriptor } from "../../runtime/authorization/confirmation.js";
import { PgConsumedAuthorizationVerifier } from "../../runtime/authorization/consumed-authorization-verifier.js";
import { PgGrantStore } from "../../runtime/authorization/grant-store.js";
import type { CompensationRegistry } from "../../runtime/compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../../runtime/compensation/saga-orchestrator.js";
import { parseRuntimeEventEnvelope } from "../../runtime/event-envelope.js";
import { NoopStepLock } from "../../runtime/lock/step-lock.js";
import { runMigrations } from "../../runtime/persistence/migration-runner.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import { PgBusinessEffectLedger, PgSideEffectDatabase } from "../../runtime/side-effect/business-effect-ledger.js";
import { PgReconciliationTaskStore } from "../../runtime/side-effect/reconciliation-task-store.js";
import { PgResultReferenceStore } from "../../runtime/side-effect/result-reference-store.js";
import { ToolExecutionRunner } from "../../runtime/side-effect/tool-execution-runner.js";
import { createRuntimeToolDispatchPipeline } from "../../runtime/tool-dispatch/pipeline.js";
import { RuntimeToolDescriptorRegistry } from "../../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { createRuntimeToolAuthorizationComposition } from "../../tools/authorization/tool-authorization.js";
import { KB_SEARCH_TOOL_NAME, kbSearchInputSchema } from "../../tools/kb-search.js";
import { MockOrderProvider, type MockOrderProviderOptions } from "../../tools/orders/mock-order-provider.js";
import { ORDER_MUTATION_TOOL_NAMES, ORDER_TOOL_NAMES, createOrderToolRiskPolicies, createOrderToolSet } from "../../tools/orders/order-tools.js";
import { parseSyntheticOrderFixture, type SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import type { ChainEvalCase, ChainTurnExpectation } from "./chain-case.js";
import { CHAIN_SCRIPT_VERSION, scriptedOrderCall, scriptedPolicyAnswer, scriptedRetrieval, scriptedRoute, type ScriptedToolCall } from "./chain-script.js";
import {
  scoreChainCase,
  summarizeChainRun,
  type ChainCaseResult,
  type ChainEvaluationRun,
  type HumanDecision,
  type TurnObservation,
} from "./chain-scoring.js";

/** The synthetic shopper who owns every order of synthetic-orders-v1 that the cases act on. */
const TEST_PRINCIPAL_ID = "synthetic-shopper-a";
export const DEFAULT_EXPIRE_TIMEOUT_MS = 1_000;
/** Real waiting: the Postgres approval path has no injectable clock (design §20.1). */
const EXPIRY_MARGIN_MS = 300;
const DEFAULT_CASE_TIMEOUT_MS = 60_000;
const CONFIRMATION_TIMEOUT_ENV = "TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS";

export interface DeterministicChainEvaluationInput {
  /** An isolated Postgres; every row the run writes is scoped to its own tenants and removed afterwards. */
  pool: Pool;
  cases: readonly ChainEvalCase[];
  corpus: readonly SourceDocument[];
  orderFixture: SyntheticOrderFixture;
  datasetVersion: string;
  evaluationRunId?: string;
  /** Approval timeout for the expiry cases only. */
  expireTimeoutMs?: number;
  caseTimeoutMs?: number;
  now?: () => number;
}

export class ChainCaseTimeoutError extends Error {
  readonly name = "ChainCaseTimeoutError";
  readonly code = "CHAIN_CASE_TIMEOUT";
}

/** What the deterministic script answers for the turn the harness is currently running. */
interface ScriptCursor {
  item: ChainEvalCase;
  turnIndex: number;
  orderCalls: ScriptedToolCall[];
}

function queryable(pool: Pool): Queryable {
  return {
    query: async (text, values = []) => {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

const noop = async () => undefined;

function errorCodeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "CHAIN_CASE_FAILED";
}

function expectationAt(cursor: ScriptCursor): ChainTurnExpectation {
  const expectation = cursor.item.expected.turns[cursor.turnIndex];
  if (expectation === undefined) throw new Error(`No expectation for turn ${cursor.turnIndex} of ${cursor.item.caseId}`);
  return expectation;
}

/**
 * Drives the real shopping_assistant graph for every case (design §20.5):
 * production authorization, the Postgres ledger, approvals and reconciliation
 * tasks, and the real dispatch pipeline for kb_search and the order tools.
 * Only the router, the request models and the policy synthesizer are scripts.
 */
export async function runDeterministicChainEvaluation(input: DeterministicChainEvaluationInput): Promise<ChainEvaluationRun> {
  const now = input.now ?? (() => Date.now());
  const evaluationRunId = input.evaluationRunId ?? `chain-eval-${randomUUID().slice(0, 8)}`;
  const tenantPrefix = `${evaluationRunId}-`;
  const runPrefix = `run-${evaluationRunId}-`;
  const pool = input.pool;
  const db = queryable(pool);
  const expireTimeoutMs = input.expireTimeoutMs ?? DEFAULT_EXPIRE_TIMEOUT_MS;
  await runMigrations("up", db);

  /** One backend instance: its own pipeline, governance and graph over the shared database and order system. */
  function createInstance(provider: MockOrderProvider, cursor: () => ScriptCursor) {
    const composition = createRuntimeToolAuthorizationComposition({ profile: "production", db, additionalPolicies: createOrderToolRiskPolicies() });
    const originalOperationResolver = new PgOriginalOperationResolver(db);
    const statusReader = new PgOrderOperationStatusReader(db, { originalOperationResolver });
    const orderTools = createOrderToolSet({ provider, statusReader });
    const registry = new RuntimeToolDescriptorRegistry();
    for (const descriptor of orderTools.descriptors) {
      registry.register({ toolName: descriptor.toolName, toolVersion: descriptor.toolVersion }, descriptor);
    }
    registry.register(
      { toolName: KB_SEARCH_TOOL_NAME, toolVersion: "1.0" },
      {
        toolName: KB_SEARCH_TOOL_NAME,
        toolVersion: "1.0",
        inputSchema: kbSearchInputSchema,
        outputSchema: z.string(),
        riskTier: "read",
        isReadOnly: true,
        isConcurrencySafe: () => true,
        timeoutPolicy: { timeoutMs: 5_000 },
        retryPolicy: { maxAttempts: 1, maxElapsedMs: 5_000, retryableCategories: [], backoffStrategy: "fixed", jitter: false },
        interruptBehavior: "cancel_safe",
      }
    );
    const runner = new ToolExecutionRunner(
      new PgBusinessEffectLedger(new PgSideEffectDatabase(pool)),
      new PgResultReferenceStore(db),
      { auditLogger: { record: noop }, spanManager: createNoopSpanManager(), recordMetric: noop },
      undefined,
      new PgReconciliationTaskStore(db)
    );
    const compensationRegistry: CompensationRegistry = {
      register: () => undefined,
      deregister: () => undefined,
      getActions: () => [],
      hasActions: () => false,
    };
    const pipeline = createRuntimeToolDispatchPipeline({
      pool: null,
      registry,
      toolExecutionRunner: runner,
      retryBudgetFactory: (stepId, policy) => ({ stepId, maxAttempts: policy.maxAttempts, maxElapsedMs: policy.maxElapsedMs, startedAt: Date.now(), attempts: 0 }),
      taskStepAdapter: { start: noop, complete: noop, fail: noop },
      compensationRegistry,
      sagaOrchestrator: { compensate: noop } as unknown as SagaOrchestrator,
      observability: { audit: noop, metric: noop },
      stepLock: new NoopStepLock(),
      stepLockTtlMs: 30_000,
      emitDeduplicatedOutcome: true,
      consumedAuthorizationVerifier: new PgConsumedAuthorizationVerifier(db),
    });
    // kb_search returns the case's scripted retrieval but goes through the same governance and dispatch as the order tools.
    const kbSearch = tool(async () => JSON.stringify(scriptedRetrieval(cursor().item, cursor().turnIndex, input.corpus)), {
      name: KB_SEARCH_TOOL_NAME,
      description: "Deterministic kb_search for the chain evaluation.",
      schema: kbSearchInputSchema,
    });
    const tools = applyToolGovernance([kbSearch, ...orderTools.tools], composition.authorization, {
      createExecutor: (source, defaultExecutor) => pipeline.createExecutor(source.name, defaultExecutor),
    });
    const unbound = async (): Promise<never> => {
      throw new Error("The scripted request model is only used through bindTools");
    };
    const scriptedModel = (calls: () => ScriptedToolCall[]): ChatModelInvoker => ({
      invoke: unbound,
      bindTools: () => ({ invoke: async () => new AIMessage({ content: "", tool_calls: calls() }) }),
    });
    const kbCall = (): ScriptedToolCall[] => {
      const { item, turnIndex } = cursor();
      const intent = expectationAt(cursor()).expectedIntent;
      return [
        {
          name: KB_SEARCH_TOOL_NAME,
          id: `kb-${item.caseId}-t${turnIndex}`,
          args: {
            query: item.input.turns[turnIndex]!.message,
            sourceTypes: intent === "product_lookup" ? ["product"] : ["policy", "faq"],
          },
        },
      ];
    };
    const graph = createShoppingAssistantGraph(
      {
        tools,
        confirmationStore: composition.confirmationStore,
        interruptManifestRepository: composition.interruptManifestRepository,
        intentRouter: { promptVersion: CHAIN_SCRIPT_VERSION, route: async () => scriptedRoute(expectationAt(cursor())) },
        createProductRequestModel: () => scriptedModel(kbCall),
        policyAnswerSynthesizer: {
          promptVersion: CHAIN_SCRIPT_VERSION,
          synthesize: async (_question, evidence) => scriptedPolicyAnswer(expectationAt(cursor()), evidence),
        },
        createOrderRequestModel: () => scriptedModel(() => cursor().orderCalls),
        checkDispatchReadiness: createDispatchReadinessCheck(db),
        confirmationWithdrawal: composition.confirmationStore,
        originalOperationResolver,
        operationRequests: new PgOrderOperationRequestStore(db),
        audit: noop,
      },
      { checkpointer: new MemorySaver() }
    );
    return { graph };
  }

  type Graph = ReturnType<typeof createInstance>["graph"];

  async function grantTools(tenantId: string) {
    const grants = new PgGrantStore(db);
    for (const toolName of [...ORDER_TOOL_NAMES, KB_SEARCH_TOOL_NAME]) {
      await grants.create({
        grantId: `${tenantId}-${toolName}`,
        resource: { resourceType: "tool", resourceId: toolName, tenantId, ownerScopeId: tenantId },
        granteeScopeId: tenantId,
        granteeTenantId: tenantId,
        actions: [ORDER_MUTATION_TOOL_NAMES.has(toolName) ? "tool:write" : "tool:read"],
        grantedByPrincipalId: "chain-evaluation",
        grantedByScopeId: tenantId,
        canDelegate: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
  }

  /** A run of its own, with the runtime task and step rows the ledger refers to. */
  async function startRun(tenantId: string, threadId: string, runId: string) {
    const context = {
      requestId: `request-${runId}`,
      threadId,
      runId,
      taskId: `task-${runId}`,
      stepId: `step-${runId}`,
      attempt: 1,
      principal: {
        principalId: TEST_PRINCIPAL_ID,
        principalType: "user" as const,
        tenantId,
        roles: [],
        scopes: [],
        authSource: "trusted_gateway" as const,
        authenticatedAt: new Date().toISOString(),
      },
      scope: { scopeId: tenantId, scopeType: "tenant" as const, tenantId },
    };
    await pool.query(
      `INSERT INTO agent_tasks (task_id, task_type, status, metadata, created_at, updated_at)
       VALUES ($1, 'interaction_runtime', 'running', '{}'::jsonb, NOW(), NOW())`,
      [context.taskId]
    );
    await pool.query(`INSERT INTO task_steps (step_id, task_id, step_name, status) VALUES ($1, $2, 'chain_evaluation', 'running')`, [
      context.stepId,
      context.taskId,
    ]);
    return { configurable: { thread_id: threadId, execution_context: context } };
  }

  type RunConfig = Awaited<ReturnType<typeof startRun>>;

  /** Runs one input to its end or interrupt, collecting card types from the update stream. */
  async function drive(graph: Graph, graphInput: unknown, config: RunConfig, cardTypes: string[]): Promise<ShoppingAssistantState> {
    const stream = await graph.stream(graphInput as Parameters<Graph["stream"]>[0], { ...config, streamMode: "updates" as const });
    for await (const chunk of stream) {
      for (const update of Object.values(chunk as Record<string, unknown>)) {
        const events = (update as { runtimeEvents?: readonly unknown[] } | null)?.runtimeEvents;
        for (const event of events ?? []) {
          const payload = parseRuntimeEventEnvelope(event).payload as { cardType?: unknown };
          if (typeof payload.cardType === "string") cardTypes.push(payload.cardType);
        }
      }
    }
    return (await graph.getState(config)).values as ShoppingAssistantState;
  }

  function resume(descriptor: ConfirmationRequiredDescriptor, decision: "approve" | "deny") {
    return new Command({
      resume: {
        type: "tool_authorization_confirmation",
        schemaVersion: descriptor.schemaVersion,
        approvalId: descriptor.approvalId,
        decisionId: descriptor.decisionId,
        decision,
      },
    });
  }

  /** The order system holds the first submission inside its commit until released. */
  function commitGate() {
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const inCommit = new Promise<void>((resolve) => (entered = resolve));
    return {
      release,
      inCommit,
      beforeCommit: async () => {
        entered();
        await hold;
      },
    };
  }

  async function runCase(item: ChainEvalCase, caseIndex: number): Promise<TurnObservation[]> {
    const tenantId = `${tenantPrefix}${caseIndex}`;
    const threadId = `thread-${tenantId}`;
    await grantTools(tenantId);
    const fixture = parseSyntheticOrderFixture({
      ...input.orderFixture,
      orders: input.orderFixture.orders.map((order) => ({ ...order, tenantId })),
    });
    const faults = item.expected.turns.flatMap((turn) => (turn.operation?.fault ? [turn.operation.fault] : []));
    const gate = faults.includes("concurrent_duplicate") ? commitGate() : undefined;
    const providerOptions: Partial<MockOrderProviderOptions> = {
      ...(faults.includes("response_lost_committed") ? { faults: { afterDispatch: { kind: "response_lost", committed: true } } } : {}),
      ...(faults.includes("response_lost_not_committed") ? { faults: { afterDispatch: { kind: "response_lost", committed: false } } } : {}),
      ...(gate ? { beforeCommit: gate.beforeCommit } : {}),
    };
    let externalOperations = 0;
    const provider = new MockOrderProvider({ fixture, createExternalOperationId: () => `ext-${tenantId}-${++externalOperations}`, ...providerOptions });
    const cursor: ScriptCursor = { item, turnIndex: 0, orderCalls: [] };
    const main = createInstance(provider, () => cursor);
    const observations: TurnObservation[] = [];

    for (let turnIndex = 0; turnIndex < item.expected.turns.length; turnIndex += 1) {
      const expectation = item.expected.turns[turnIndex]!;
      const message = item.input.turns[turnIndex]!.message;
      const runId = `${runPrefix}${caseIndex}-t${turnIndex}`;
      const toolCallId = `call-${caseIndex}-t${turnIndex}`;
      const operation = expectation.operation;
      cursor.turnIndex = turnIndex;
      cursor.orderCalls = operation ? [scriptedOrderCall(item, turnIndex, toolCallId)] : [];
      const submissionsAtStart = provider.submissions;
      const cardTypes: string[] = [];
      let humanDecisionSent: HumanDecision = "none";
      const auxiliary: NonNullable<TurnObservation["auxiliary"]> = [];

      const config = await startRun(tenantId, threadId, runId);
      const request = () => drive(main.graph, { messages: [new HumanMessage(message)] }, config, cardTypes);

      let state: ShoppingAssistantState;
      let approvalRequested = false;
      let submissionsBeforeDecision = 0;
      if (operation?.fault === "concurrent_duplicate") {
        // The first of two identical submissions comes from another instance and thread; this turn's is the duplicate.
        const other = createInstance(provider, () => cursor);
        const auxCallId = `${toolCallId}-first`;
        const auxConfig = await startRun(tenantId, `${threadId}-first-t${turnIndex}`, `${runId}-first`);
        cursor.orderCalls = [scriptedOrderCall(item, turnIndex, auxCallId)];
        const firstWaiting = await drive(other.graph, { messages: [new HumanMessage(message)] }, auxConfig, []);
        cursor.orderCalls = [scriptedOrderCall(item, turnIndex, toolCallId)];
        state = await request();
        const firstDescriptor = firstWaiting.pendingAuthorization as ConfirmationRequiredDescriptor | null | undefined;
        const descriptor = state.pendingAuthorization as ConfirmationRequiredDescriptor | null | undefined;
        approvalRequested = Boolean(descriptor) && Boolean(firstDescriptor);
        submissionsBeforeDecision = provider.submissions - submissionsAtStart;
        if (descriptor && firstDescriptor && gate) {
          const firstRun = drive(other.graph, resume(firstDescriptor, "approve"), auxConfig, []);
          // The first submission now holds its claim inside the order system's commit.
          await Promise.race([gate.inCommit, firstRun.then(() => undefined)]);
          humanDecisionSent = "approve";
          state = await drive(main.graph, resume(descriptor, "approve"), config, cardTypes);
          gate.release();
          const first = await firstRun;
          auxiliary.push({ toolCallId: auxCallId, state: first.operations[auxCallId]?.state ?? null });
        }
      } else {
        const decision = operation?.humanDecision ?? "none";
        const previousTimeout = process.env[CONFIRMATION_TIMEOUT_ENV];
        if (decision === "expire") process.env[CONFIRMATION_TIMEOUT_ENV] = String(expireTimeoutMs);
        try {
          state = await request();
        } finally {
          if (decision === "expire") {
            if (previousTimeout === undefined) delete process.env[CONFIRMATION_TIMEOUT_ENV];
            else process.env[CONFIRMATION_TIMEOUT_ENV] = previousTimeout;
          }
        }
        const descriptor = state.pendingAuthorization as ConfirmationRequiredDescriptor | null | undefined;
        approvalRequested = Boolean(descriptor);
        submissionsBeforeDecision = provider.submissions - submissionsAtStart;
        if (descriptor) {
          if (decision === "approve" || decision === "deny") {
            humanDecisionSent = decision;
            state = await drive(main.graph, resume(descriptor, decision), config, cardTypes);
          } else if (decision === "expire") {
            humanDecisionSent = "expire";
            await new Promise((resolve) => setTimeout(resolve, expireTimeoutMs + EXPIRY_MARGIN_MS));
            // A late approval probes the expiry: it must not reach the order system.
            state = await drive(main.graph, resume(descriptor, "approve"), config, cardTypes);
          } else if (decision === "cancel_before_effect") {
            humanDecisionSent = "cancel_before_effect";
            const cancelConfig = await startRun(tenantId, threadId, `${runId}-cancel`);
            state = await drive(main.graph, { kind: "cancel", targetRunId: runId }, cancelConfig, cardTypes);
          }
        }
      }

      const record = state.operations[toolCallId];
      observations.push({
        turnIndex,
        routedIntent: state.turn?.routedIntent ?? null,
        routeStatus: state.turn?.routeStatus ?? null,
        answerStatus: state.turnEvidence?.answerStatus ?? null,
        citations: state.turnEvidence?.citations ?? [],
        ...(operation
          ? {
              operation: {
                toolCallId,
                state: record?.state ?? null,
                ...(record?.dedup ? { dedupReason: record.dedup.reason } : {}),
                ...(record?.reasonCode ? { reasonCode: record.reasonCode } : {}),
              },
            }
          : {}),
        approvalRequested,
        humanDecisionSent,
        submissionsBeforeDecision,
        submissionsDuringTurn: provider.submissions - submissionsAtStart,
        providerSubmissions: provider.submissions,
        providerLookups: provider.lookups,
        cardTypes,
        ...(auxiliary.length > 0 ? { auxiliary } : {}),
      });
    }
    return observations;
  }

  async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ChainCaseTimeoutError(`Case exceeded ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const results: ChainCaseResult[] = [];
  try {
    for (const [caseIndex, item] of input.cases.entries()) {
      const startedAt = now();
      try {
        const observations = await withTimeout(runCase(item, caseIndex), input.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS);
        results.push(scoreChainCase(item, observations, now() - startedAt));
      } catch (error) {
        results.push({ caseId: item.caseId, split: item.split, status: "failed", errorCode: errorCodeOf(error), latencyMs: now() - startedAt });
      }
    }
  } finally {
    await cleanup(pool, tenantPrefix, runPrefix);
  }

  const failedCases = results.filter((result) => result.status === "failed").map((result) => result.caseId);
  return {
    mode: "deterministic",
    evaluationRunId,
    datasetVersion: input.datasetVersion,
    status: failedCases.length === 0 ? "completed" : "incomplete",
    failedCases,
    results,
    summary: summarizeChainRun(results, "deterministic"),
  };
}

/** Removes every runtime row of this evaluation run, scoped by its tenant and run prefixes. */
async function cleanup(pool: Pool, tenantPrefix: string, runPrefix: string): Promise<void> {
  const tenants = `${tenantPrefix}%`;
  const runs = `${runPrefix}%`;
  const executions = "SELECT tool_execution_id FROM tool_executions WHERE run_id LIKE $1";
  await pool.query("DELETE FROM reconciliation_tasks WHERE tenant_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM order_operation_requests WHERE tenant_id LIKE $1", [tenants]);
  await pool.query(`DELETE FROM tool_execution_attempts WHERE tool_execution_id IN (${executions})`, [runs]);
  await pool.query(`DELETE FROM result_references WHERE tool_execution_id IN (${executions})`, [runs]);
  await pool.query("DELETE FROM tool_executions WHERE run_id LIKE $1", [runs]);
  await pool.query("DELETE FROM business_effects WHERE tenant_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM interrupt_manifests WHERE scope_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM authorization_confirmations WHERE tenant_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM permission_decisions WHERE tenant_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM permission_grants WHERE resource_tenant_id LIKE $1", [tenants]);
  await pool.query("DELETE FROM task_steps WHERE task_id LIKE $1", [`task-${runs}`]);
  await pool.query("DELETE FROM agent_tasks WHERE task_id LIKE $1", [`task-${runs}`]);
}
