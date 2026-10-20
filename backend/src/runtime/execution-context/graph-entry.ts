import { randomUUID } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isCommand } from "@langchain/langgraph";
import { FrameworkAdapterError, runBoundedAdapterOperation } from "../framework-adapters/bounded-operation.js";
import { executionContextSchema, executionIdSchema, type ExecutionContext } from "./execution-context.js";
import { readDevelopmentExecutionContext, readExecutionContext } from "./read-execution-context.js";

export interface GraphTaskAdmission {
  admit(context: ExecutionContext, resumeTaskId?: string, signal?: AbortSignal): Promise<{ taskId: string; runId: string }>;
}

interface CheckpointReader {
  getState(config: RunnableConfig): Promise<{ values: unknown }>;
}

const ENTRY_OWNED_KEYS = new Set([
  "execution_context", "taskId", "task_id", "stepId", "step_id",
  "toolCallId", "tool_call_id", "toolExecutionId", "tool_execution_id",
  "runId", "nativeRunId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryConfig(config: unknown): RunnableConfig {
  const record = isRecord(config) ? config : {};
  const configurable = isRecord(record.configurable) ? record.configurable : {};
  return {
    ...Object.fromEntries(Object.entries(record).filter(([key]) => !ENTRY_OWNED_KEYS.has(key))),
    configurable: Object.fromEntries(Object.entries(configurable).filter(([key]) => !ENTRY_OWNED_KEYS.has(key))),
  };
}

export function createGraphEntryContextResolver(
  graph: CheckpointReader,
  admission: GraphTaskAdmission,
  options: { admissionTimeoutMs: number } = { admissionTimeoutMs: 10_000 },
) {
  return async (input: unknown, config: unknown): Promise<ExecutionContext> => {
    const prepared = entryConfig(config);
    if (prepared.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
    const candidateTaskId = randomUUID();
    const candidateRunId = randomUUID();
    const candidateConfig = {
      ...Object.fromEntries(Object.entries(prepared).filter(([key]) => key !== "run_id")),
      configurable: {
        ...Object.fromEntries(Object.entries(prepared.configurable ?? {}).filter(([key]) => key !== "run_id")),
        runId: candidateRunId,
        task_id: candidateTaskId,
      },
    };
    let candidate: ExecutionContext;
    try {
      candidate = process.env.NODE_ENV === "development" && process.env.EXECUTION_CONTEXT_DEV_ENABLED === "true"
        ? readDevelopmentExecutionContext(input, candidateConfig)
        : readExecutionContext(input, candidateConfig, "production");
    } catch {
      throw new FrameworkAdapterError("ADAPTER_INVALID");
    }
    const isResume = input === null || input === undefined || isCommand(input);
    const admitted = await runBoundedAdapterOperation(async (signal) => {
      let resumeTaskId: string | undefined;
      if (isResume) {
        const checkpoint = await graph.getState({ ...prepared, signal });
        const parsed = executionIdSchema.safeParse(
          isRecord(checkpoint.values) ? checkpoint.values.executionTaskId : undefined,
        );
        if (!parsed.success) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
        resumeTaskId = parsed.data;
      }
      signal.throwIfAborted();
      const admitted = await admission.admit(candidate, resumeTaskId, signal);
      signal.throwIfAborted();
      return admitted;
    }, { timeoutMs: options.admissionTimeoutMs, signal: prepared.signal });
    const context = executionContextSchema.safeParse({ ...candidate, ...admitted });
    if (!context.success) throw new FrameworkAdapterError("ADAPTER_INVALID");
    return context.data;
  };
}
