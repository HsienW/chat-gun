import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { deepResearcherGraph } from "../../agents/deep-researcher.js";
import { parseExecutedToolCallArtifact } from "../../agents/executed-tool-call.js";
import { getConfiguredLlmProvider } from "../../platform/llm-gateway.js";
import { TRUSTED_PRINCIPAL_HEADERS } from "../../runtime/authorization/principal.js";
import { TRUSTED_SCOPE_FIELDS } from "../../runtime/execution-context/read-execution-context.js";
import { getAgentRuntimeConfig } from "../../platform/runtime-config.js";
import {
  getOpikTracer,
  type OpikTracer,
} from "../../platform/tracing/opik/opik-tracer.js";
import { sanitizeErrorMessage } from "../../platform/tracing/span-manager.js";
import { loadOrCreateWeatherGoldenDataset } from "./dataset.js";
import {
  publishHostedExperiment,
  type HostedExperimentInput,
  type HostedExperimentPublication,
} from "./hosted-experiment.js";
import type {
  ActualToolCall,
  AgentRunResult,
  EvaluationDataset,
  EvaluationItem,
  EvaluationMetric,
  MetricScore,
} from "./types.js";

const DEFAULT_ITEM_TIMEOUT_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ExperimentAgentConfig {
  model: string;
  provider: string;
  promptVersion?: string;
}

export interface ExperimentJudgeConfig {
  model: string;
  provider: string;
  temperature: number;
  promptVersion: string;
  promptTemplateHash: string;
}

export interface ExperimentConfig {
  datasetVersion: string;
  agentConfig: ExperimentAgentConfig;
  metrics: EvaluationMetric[];
  judgeConfig?: ExperimentJudgeConfig;
  maxItems?: number;
  perItemTimeoutMs?: number;
  maxTotalCostUsd?: number;
  outputDir?: string;
}

export type ExperimentItemStatus =
  | "COMPLETED"
  | "FAILED"
  | "TIMEOUT"
  | "SKIPPED";

export interface ExperimentItemResult {
  itemId: string;
  status: ExperimentItemStatus;
  metrics: MetricScore[];
  traceId?: string;
  response?: string;
  tokenCostUsd?: number;
  error?: { type: string; message: string };
}

interface ExperimentResultBase {
  localExperimentId: string;
  experimentId: string | null;
  comparisonKey: string;
  datasetName: string;
  datasetVersion: string;
  agentConfig: ExperimentAgentConfig;
  judgeConfig?: ExperimentJudgeConfig;
  items: ExperimentItemResult[];
  metrics: MetricScore[];
  traceIds: string[];
  timestamp: string;
  outputPath: string;
}

export type ExperimentResult = ExperimentResultBase &
  (
    | HostedExperimentPublication
    | {
        hostedStatus: "FAILED";
        hostedError: { type: string; message: string };
      }
  );

export interface ExperimentAgentContext {
  signal: AbortSignal;
  agentConfig: ExperimentAgentConfig;
  threadId: string;
  runId: string;
  taskId: string;
}

export interface ExperimentDependencies {
  loadDataset(version: string): Promise<EvaluationDataset>;
  runAgent(
    item: EvaluationItem,
    context: ExperimentAgentContext
  ): Promise<AgentRunResult>;
  tracer: OpikTracer;
  now(): Date;
  localExperimentId(): string;
  publishHostedExperiment(
    input: HostedExperimentInput
  ): Promise<HostedExperimentPublication>;
}

class ItemTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms`);
    this.name = "ItemTimeoutError";
  }
}

class ItemExecutionError extends Error {
  constructor(
    readonly result: ExperimentItemResult,
    options: { cause: unknown }
  ) {
    super(result.error?.message ?? "Experiment item failed", options);
    this.name = "ItemExecutionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function comparisonKey(config: ExperimentConfig): string {
  const comparable = {
    datasetVersion: config.datasetVersion,
    agentConfig: config.agentConfig,
    judgeConfig: config.judgeConfig,
    metrics: config.metrics.map((metric) => ({
      name: metric.name,
      deterministic: metric.deterministic,
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(comparable)))
    .digest("hex");
}

function zeroScores(metrics: readonly EvaluationMetric[], reason: string): MetricScore[] {
  return metrics.map((metric) => ({
    name: metric.name,
    value: 0,
    reason,
    status: "FAILED",
    deterministic: metric.deterministic,
  }));
}

async function evaluateMetrics(
  metrics: readonly EvaluationMetric[],
  item: EvaluationItem,
  result: AgentRunResult
): Promise<MetricScore[]> {
  return Promise.all(
    metrics.map(async (metric) => {
      try {
        return await metric.evaluate(item, result);
      } catch (error) {
        return {
          name: metric.name,
          value: 0,
          reason: sanitizeErrorMessage(
            error instanceof Error ? error.message : String(error)
          ),
          status: "FAILED" as const,
          deterministic: metric.deterministic,
        };
      }
    })
  );
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ItemTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function readToolCalls(messages: unknown[]): ActualToolCall[] {
  const calls: ActualToolCall[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.name !== "string") continue;
        calls.push({
          name: call.name,
          arguments: isRecord(call.args) ? call.args : {},
        });
      }
    }
    const executedCall = parseExecutedToolCallArtifact(
      message.artifact,
      message.name
    );
    if (executedCall) {
      calls.push(executedCall);
    }
  }
  return calls;
}

function renderStructuredRequest(item: EvaluationItem): string {
  return [
    "Execute this approved evaluation item from structured input.",
    "Do not infer or add personal data.",
    JSON.stringify(item.input),
  ].join("\n");
}

const EVALUATION_ID_PREFIX = "opik-eval";

/** The part of the deep-researcher graph the default runner calls; tests pass an entry-wrapped stub. */
interface EvaluationGraph {
  invoke(
    input: { messages: HumanMessage[]; reasoning_model: string },
    config: { runId: string; signal: AbortSignal; configurable: Record<string, string> }
  ): Promise<unknown>;
}

/**
 * The graph entry ignores any caller-supplied execution context and rebuilds it
 * from the trusted gateway fields, so this in-process, opt-in evaluation supplies
 * them the way the BFF does. Each experiment acts as its own synthetic principal
 * and tenant, keeping its runtime rows apart from other experiments and real users.
 */
function createEvaluationGraphConfigurable(
  context: Pick<ExperimentAgentContext, "threadId" | "runId">,
  authenticatedAt: Date
): Record<string, string> {
  const tenantId = `${EVALUATION_ID_PREFIX}-${context.threadId}`;
  return {
    thread_id: context.threadId,
    run_id: context.runId,
    request_id: `${EVALUATION_ID_PREFIX}-request-${context.runId}`,
    [TRUSTED_PRINCIPAL_HEADERS.principalId]: `${EVALUATION_ID_PREFIX}-principal-${context.threadId}`,
    [TRUSTED_PRINCIPAL_HEADERS.principalType]: "user",
    [TRUSTED_PRINCIPAL_HEADERS.tenantId]: tenantId,
    [TRUSTED_PRINCIPAL_HEADERS.roles]: "",
    [TRUSTED_PRINCIPAL_HEADERS.scopes]: "",
    [TRUSTED_PRINCIPAL_HEADERS.authSource]: "trusted_gateway",
    [TRUSTED_PRINCIPAL_HEADERS.authenticatedAt]: authenticatedAt.toISOString(),
    [TRUSTED_SCOPE_FIELDS.scopeId]: tenantId,
    [TRUSTED_SCOPE_FIELDS.scopeType]: "tenant",
  };
}

async function runDefaultAgent(
  item: EvaluationItem,
  context: ExperimentAgentContext,
  graph: EvaluationGraph = deepResearcherGraph
): Promise<AgentRunResult> {
  const output: unknown = await graph.invoke(
    {
      messages: [new HumanMessage(renderStructuredRequest(item))],
      reasoning_model: context.agentConfig.model,
    },
    {
      runId: context.runId,
      signal: context.signal,
      configurable: createEvaluationGraphConfigurable(context, new Date()),
    }
  );
  const messages = isRecord(output) && Array.isArray(output.messages)
    ? output.messages
    : [];
  const lastMessage = messages.at(-1);
  return {
    response: isRecord(lastMessage) ? messageContent(lastMessage.content) : "",
    toolCalls: readToolCalls(messages),
  };
}

function defaultDependencies(): ExperimentDependencies {
  return {
    loadDataset: (version) => loadOrCreateWeatherGoldenDataset(version),
    runAgent: runDefaultAgent,
    tracer: getOpikTracer(),
    now: () => new Date(),
    localExperimentId: () => randomUUID(),
    publishHostedExperiment,
  };
}

export function createPinnedDatasetLoader(
  dataset: EvaluationDataset
): ExperimentDependencies["loadDataset"] {
  return async (version) => {
    if (version !== dataset.version) {
      throw new Error(
        `Pinned dataset version ${dataset.version} does not match ${version}`
      );
    }
    return dataset;
  };
}

function validateConfig(config: ExperimentConfig): void {
  if (!config.datasetVersion.trim()) {
    throw new TypeError("datasetVersion must not be empty");
  }
  if (!config.agentConfig.model.trim() || !config.agentConfig.provider.trim()) {
    throw new TypeError("Agent model and provider must not be empty");
  }
  if (config.judgeConfig && config.judgeConfig.temperature !== 0) {
    throw new TypeError("Experiment judge temperature must be 0");
  }
  if (
    config.judgeConfig &&
    (!config.judgeConfig.model.trim() ||
      !config.judgeConfig.provider.trim() ||
      !config.judgeConfig.promptVersion.trim() ||
      !/^[a-f0-9]{64}$/.test(config.judgeConfig.promptTemplateHash))
  ) {
    throw new TypeError("Experiment judge config is incomplete or invalid");
  }
  if (
    config.perItemTimeoutMs !== undefined &&
    (!Number.isSafeInteger(config.perItemTimeoutMs) ||
      config.perItemTimeoutMs <= 0 ||
      config.perItemTimeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new TypeError(
      `perItemTimeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`
    );
  }
  if (
    config.maxItems !== undefined &&
    (!Number.isSafeInteger(config.maxItems) || config.maxItems < 0)
  ) {
    throw new TypeError("maxItems must be a non-negative safe integer");
  }
  if (
    config.maxTotalCostUsd !== undefined &&
    (!Number.isFinite(config.maxTotalCostUsd) || config.maxTotalCostUsd < 0)
  ) {
    throw new TypeError("maxTotalCostUsd must be a non-negative finite number");
  }
  if (config.outputDir !== undefined && !config.outputDir.trim()) {
    throw new TypeError("outputDir must not be empty");
  }
  validateJudgeEvidence(config);
}

function readMetricJudgeConfig(
  metric: EvaluationMetric
): ExperimentJudgeConfig | undefined {
  if (!isRecord(metric) || !("judgeConfig" in metric)) return undefined;
  const candidate = metric.judgeConfig;
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.model !== "string" ||
    typeof candidate.provider !== "string" ||
    candidate.temperature !== 0 ||
    typeof candidate.promptVersion !== "string" ||
    typeof candidate.promptTemplateHash !== "string"
  ) {
    return undefined;
  }
  return {
    model: candidate.model,
    provider: candidate.provider,
    temperature: 0,
    promptVersion: candidate.promptVersion,
    promptTemplateHash: candidate.promptTemplateHash,
  };
}

function validateJudgeEvidence(config: ExperimentConfig): void {
  const judgeMetrics = config.metrics.filter(
    (metric) => metric.name === "response_quality"
  );
  if (judgeMetrics.length === 0) return;
  if (!config.judgeConfig) {
    throw new TypeError("judgeConfig is required for response_quality");
  }
  const expected = JSON.stringify(stableValue(config.judgeConfig));
  for (const metric of judgeMetrics) {
    const actual = readMetricJudgeConfig(metric);
    if (!actual || JSON.stringify(stableValue(actual)) !== expected) {
      throw new TypeError(
        "Experiment judgeConfig does not match the executing response_quality metric"
      );
    }
  }
}

async function flushExperimentTracer(tracer: OpikTracer): Promise<void> {
  try {
    await tracer.flush();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "opik_experiment_flush_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    );
  }
}

function validateDefaultProvider(
  requestedProvider: string,
  configuredProvider: string
): void {
  if (requestedProvider !== configuredProvider) {
    throw new TypeError(
      `Agent provider ${requestedProvider} does not match configured provider ${configuredProvider}`
    );
  }
}

async function writeResult(
  outputDirectory: string,
  timestamp: string,
  result: Omit<ExperimentResult, "outputPath">
): Promise<string> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const safeTimestamp = timestamp.replaceAll(":", "-");
  let suffix = 0;
  while (true) {
    const filename = `experiment-${safeTimestamp}${suffix ? `-${suffix}` : ""}.json`;
    const outputPath = resolve(directory, filename);
    try {
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return outputPath;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

export async function runExperiment(
  config: ExperimentConfig,
  dependencies: Partial<ExperimentDependencies> = {}
): Promise<ExperimentResult> {
  validateConfig(config);
  if (!dependencies.runAgent) {
    validateDefaultProvider(
      config.agentConfig.provider,
      getConfiguredLlmProvider()
    );
  }
  const resolvedDependencies: ExperimentDependencies = {
    ...defaultDependencies(),
    ...dependencies,
  };
  const dataset = await resolvedDependencies.loadDataset(config.datasetVersion);
  if (dataset.version !== config.datasetVersion) {
    throw new Error(
      `Loaded dataset version ${dataset.version} does not match ${config.datasetVersion}`
    );
  }

  const localExperimentId = resolvedDependencies.localExperimentId();
  const timestamp = resolvedDependencies.now().toISOString();
  const itemLimit = config.maxItems ?? dataset.items.length;
  const timeoutMs = config.perItemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  let accumulatedCostUsd = 0;
  const items: ExperimentItemResult[] = [];

  for (const [index, item] of dataset.items.entries()) {
    const budgetReached =
      config.maxTotalCostUsd !== undefined &&
      accumulatedCostUsd >= config.maxTotalCostUsd;
    if (index >= itemLimit || budgetReached) {
      items.push({ itemId: item.id, status: "SKIPPED", metrics: [] });
      continue;
    }

    const runId = `${localExperimentId}:${item.id}`;
    const contextBase = {
      agentConfig: config.agentConfig,
      threadId: localExperimentId,
      runId,
      taskId: item.id,
    };
    try {
      const completed = await resolvedDependencies.tracer.traceAgentRun(
        "weather",
        {
          threadId: contextBase.threadId,
          runId,
          taskId: item.id,
          modelName: config.agentConfig.model,
          providerName: config.agentConfig.provider,
        },
        async () => {
          const traceId = resolvedDependencies.tracer.getActiveTraceId();
          try {
            const agentResult = await withTimeout(
              (signal) =>
                resolvedDependencies.runAgent(item, { ...contextBase, signal }),
              timeoutMs
            );
            const scores = await evaluateMetrics(config.metrics, item, agentResult);
            for (const score of scores) {
              resolvedDependencies.tracer.logFeedback(
                score.name,
                score.value,
                score.reason
              );
            }
            return { agentResult, scores, traceId };
          } catch (error) {
            const status: ExperimentItemStatus =
              error instanceof ItemTimeoutError ? "TIMEOUT" : "FAILED";
            const message = sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error)
            );
            const scores = zeroScores(config.metrics, message);
            for (const score of scores) {
              resolvedDependencies.tracer.logFeedback(
                score.name,
                score.value,
                score.reason
              );
            }
            throw new ItemExecutionError(
              {
                itemId: item.id,
                status,
                metrics: scores,
                ...(traceId ? { traceId } : {}),
                error: {
                  type: error instanceof Error ? error.name : "UnknownError",
                  message,
                },
              },
              { cause: error }
            );
          }
        }
      );
      accumulatedCostUsd += completed.agentResult.tokenCostUsd ?? 0;
      items.push({
        itemId: item.id,
        status: "COMPLETED",
        metrics: completed.scores,
        ...(completed.traceId ? { traceId: completed.traceId } : {}),
        response: completed.agentResult.response,
        ...(completed.agentResult.tokenCostUsd !== undefined
          ? { tokenCostUsd: completed.agentResult.tokenCostUsd }
          : {}),
      });
    } catch (error) {
      if (error instanceof ItemExecutionError) {
        items.push(error.result);
        continue;
      }
      throw error;
    }
  }

  await flushExperimentTracer(resolvedDependencies.tracer);

  const traceIds = items.flatMap((item) => (item.traceId ? [item.traceId] : []));
  const metrics = items.flatMap((item) => item.metrics);
  let hostedPublication:
    | HostedExperimentPublication
    | {
        hostedStatus: "FAILED";
        hostedError: { type: string; message: string };
      };
  try {
    hostedPublication = await resolvedDependencies.publishHostedExperiment({
      localExperimentId,
      dataset,
      agentConfig: { ...config.agentConfig },
      ...(config.judgeConfig ? { judgeConfig: { ...config.judgeConfig } } : {}),
      metrics: config.metrics.map((metric) => ({
        name: metric.name,
        deterministic: metric.deterministic,
      })),
      traceReferences: items.flatMap((item) =>
        item.traceId ? [{ caseId: item.itemId, traceId: item.traceId }] : []
      ),
    });
  } catch (error) {
    hostedPublication = {
      hostedStatus: "FAILED",
      hostedError: {
        type: error instanceof Error ? error.name : "UnknownError",
        message: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error)
        ),
      },
    };
    console.warn(
      JSON.stringify({
        event: "opik_hosted_experiment_failed",
        localExperimentId,
        errorName: hostedPublication.hostedError.type,
      })
    );
  }
  const resultWithoutPath = {
    localExperimentId,
    experimentId:
      hostedPublication.hostedStatus === "SUCCEEDED"
        ? hostedPublication.hostedExperimentId
        : null,
    ...hostedPublication,
    comparisonKey: comparisonKey(config),
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    agentConfig: { ...config.agentConfig },
    ...(config.judgeConfig ? { judgeConfig: { ...config.judgeConfig } } : {}),
    items,
    metrics,
    traceIds,
    timestamp,
  };
  const runtimeConfig = getAgentRuntimeConfig();
  const outputPath = await writeResult(
    config.outputDir ?? runtimeConfig.opikEvalOutputDir,
    timestamp,
    resultWithoutPath
  );
  const completedCount = items.filter((item) => item.status === "COMPLETED").length;
  console.info(
    `Local experiment ${localExperimentId}: ${completedCount}/${items.length} items completed; hosted status: ${hostedPublication.hostedStatus}; results: ${outputPath}`
  );
  return { ...resultWithoutPath, outputPath };
}

export const experimentTestInternals = {
  createEvaluationGraphConfigurable,
  readToolCalls,
  runDefaultAgent,
  validateDefaultProvider,
};
