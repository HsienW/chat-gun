import { randomUUID } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isCommand } from "@langchain/langgraph";
import { executionContextSchema, executionIdSchema, type ExecutionContext } from "./execution-context.js";
import { readDevelopmentExecutionContext, readExecutionContext } from "./read-execution-context.js";

export interface GraphTaskAdmission {
  admit(context: ExecutionContext, resumeTaskId?: string): Promise<string>;
}

interface CheckpointReader {
  getState(config: RunnableConfig): Promise<{ values: unknown }>;
}

/** Reads the candidate context before admission; graphs keep their own development switch. */
export type GraphEntryContextReader = (input: unknown, config: RunnableConfig) => ExecutionContext;

function readEntryContext(input: unknown, config: RunnableConfig): ExecutionContext {
  return process.env.NODE_ENV === "development" && process.env.EXECUTION_CONTEXT_DEV_ENABLED === "true"
    ? readDevelopmentExecutionContext(input, config)
    : readExecutionContext(input, config, "production");
}

const ENTRY_OWNED_KEYS = new Set([
  "execution_context", "taskId", "task_id", "stepId", "step_id",
  "toolCallId", "tool_call_id", "toolExecutionId", "tool_execution_id",
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
  readContext: GraphEntryContextReader = readEntryContext,
) {
  return async (input: unknown, config: unknown): Promise<ExecutionContext> => {
    const prepared = entryConfig(config);
    prepared.signal?.throwIfAborted();
    const candidateTaskId = randomUUID();
    const candidateConfig = {
      ...prepared,
      configurable: { ...prepared.configurable, task_id: candidateTaskId },
    };
    const candidate = readContext(input, candidateConfig);
    const isResume = input === null || input === undefined || isCommand(input);
    let resumeTaskId: string | undefined;
    if (isResume) {
      const checkpoint = await graph.getState(prepared);
      resumeTaskId = executionIdSchema.parse(
        isRecord(checkpoint.values) ? checkpoint.values.executionTaskId : undefined,
      );
    }
    const taskId = await admission.admit(candidate, resumeTaskId);
    prepared.signal?.throwIfAborted();
    return executionContextSchema.parse({ ...candidate, taskId });
  };
}
