import type {
  MetricRecorder,
  StepMetric,
  TaskMetric,
  TokenMetric,
  ToolMetric,
} from "./metrics-collector.js";
import { getMetricsCollector } from "./metrics-collector.js";
import type { ExecutionContext } from "../../runtime/execution-context/execution-context.js";
import { executionCorrelation } from "../../runtime/execution-context/read-execution-context.js";

type TaskMetricInput = Omit<TaskMetric, "kind" | "ts">;
type StepMetricInput = Omit<StepMetric, "kind" | "ts">;
type ToolMetricInput = Omit<ToolMetric, "kind" | "ts">;

type TokenUsageMessage = {
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

type TokenMetricInput = Omit<
  TokenMetric,
  "kind" | "ts" | "inputTokens" | "outputTokens" | "totalTokens"
> & {
  message: TokenUsageMessage;
};

function recordSafely(
  metricKind: string,
  recorder: MetricRecorder,
  entry: Parameters<MetricRecorder["record"]>[0]
): void {
  try {
    recorder.record(entry);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metric_collection_failed",
        metricKind,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    );
  }
}

export function recordTaskMetric(
  input: TaskMetricInput,
  recorder: MetricRecorder = getMetricsCollector(),
  context?: ExecutionContext
): void {
  recordSafely("task", recorder, {
    kind: "task", ...input,
    ...(context ? { correlation: executionCorrelation(context) } : {}),
    ts: Date.now(),
  });
}

export function recordStepMetric(
  input: StepMetricInput,
  recorder: MetricRecorder = getMetricsCollector(),
  context?: ExecutionContext
): void {
  recordSafely("step", recorder, {
    kind: "step", ...input,
    ...(context ? { correlation: executionCorrelation(context) } : {}),
    ts: Date.now(),
  });
}

export function recordToolMetric(
  input: ToolMetricInput,
  recorder: MetricRecorder = getMetricsCollector(),
  context?: ExecutionContext
): void {
  recordSafely("tool", recorder, {
    kind: "tool", ...input,
    ...(context ? { correlation: executionCorrelation(context) } : {}),
    ts: Date.now(),
  });
}

export function recordTokenMetric(
  input: TokenMetricInput,
  recorder: MetricRecorder = getMetricsCollector()
): void {
  const usage = input.message.usage_metadata;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;

  recordSafely("token", recorder, {
    kind: "token",
    taskId: input.taskId,
    stepId: input.stepId,
    model: input.model,
    provider: input.provider,
    inputTokens,
    outputTokens,
    totalTokens,
    ts: Date.now(),
  });
}
