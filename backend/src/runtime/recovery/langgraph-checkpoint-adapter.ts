import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";

import type { SanitizedRecoveryMessage } from "./recovery-sanitizer.js";

export interface RecoveryCheckpointSnapshot {
  messages: unknown[];
  exists: boolean;
  hasPendingNodes: boolean;
  isTerminal: boolean;
}

export interface RecoveryCheckpointAdapter {
  read(threadId: string): Promise<RecoveryCheckpointSnapshot>;
  resume(input: {
    threadId: string;
    response: unknown;
    sanitizedHistory: SanitizedRecoveryMessage[];
  }): Promise<unknown>;
}

interface LangGraphLike {
  getState(config: RunnableConfig): Promise<unknown>;
  updateState(config: RunnableConfig, values: unknown): Promise<unknown>;
  invoke(input: unknown, config: RunnableConfig): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLangGraphLike(value: unknown): value is LangGraphLike {
  return (
    isRecord(value) &&
    typeof value.getState === "function" &&
    typeof value.updateState === "function" &&
    typeof value.invoke === "function"
  );
}

function hasCheckpointInterrupt(tasksValue: unknown): boolean {
  if (!Array.isArray(tasksValue)) return false;
  return tasksValue.some(
    (task) =>
      isRecord(task) &&
      Array.isArray(task.interrupts) &&
      task.interrupts.length > 0
  );
}

function readSnapshot(value: unknown): RecoveryCheckpointSnapshot {
  if (!isRecord(value)) throw new Error("Invalid LangGraph checkpoint snapshot");
  const values = isRecord(value.values) ? value.values : {};
  const messages = Array.isArray(values.messages) ? values.messages : [];
  const next = Array.isArray(value.next) ? value.next : [];
  const interrupted = hasCheckpointInterrupt(value.tasks);
  const exists = value.config !== undefined || Object.keys(values).length > 0;
  const hasPendingNodes = next.length > 0 || interrupted;
  return {
    messages,
    exists,
    hasPendingNodes,
    isTerminal: exists && !hasPendingNodes,
  };
}

export function createLangGraphCheckpointAdapter(input: {
  graph: unknown;
  createConfig?: (threadId: string) => RunnableConfig;
}): RecoveryCheckpointAdapter {
  if (!isLangGraphLike(input.graph)) {
    throw new Error("LangGraph checkpoint adapter requires a compiled graph");
  }
  const graph = input.graph;
  const createConfig =
    input.createConfig ??
    ((threadId: string): RunnableConfig => ({
      configurable: { thread_id: threadId },
    }));
  return {
    async read(threadId) {
      return readSnapshot(await graph.getState(createConfig(threadId)));
    },
    async resume({ threadId, response, sanitizedHistory }) {
      const config = createConfig(threadId);
      await graph.updateState(config, { messages: sanitizedHistory });
      return graph.invoke(new Command({ resume: response }), config);
    },
  };
}
