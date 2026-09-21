import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { executionCorrelation } from "../runtime/execution-context/read-execution-context.js";

export type ContextSource = {
  sourceId: string;
  sourceType: "message" | "asset" | "tool" | "business_card" | "profile";
  title: string;
  summary?: string;
};

export type AgentRuntimeEvent = (
  | { type: "agent.plan.start"; title: string; ts: number }
  | { type: "agent.tool.start"; toolName: string; input?: unknown; ts: number }
  | {
      type: "agent.tool.success";
      toolName: string;
      output?: unknown;
      costMs: number;
      ts: number;
    }
  | { type: "agent.tool.error"; toolName: string; error: string; ts: number }
  | {
      type: "agent.context.build";
      sources: ContextSource[];
      tokenEstimate: number;
      ts: number;
    }
  | { type: "agent.answer.stream"; delta: string; ts: number }
  | { type: "agent.card.emit"; cardType: string; payload: unknown; ts: number }
  | {
      type: "agent.unknown";
      originalType: string;
      rawPayload?: Record<string, unknown>;
      ts: number;
    }
) & { correlation?: ReturnType<typeof executionCorrelation> };

type RuntimeEventInput = AgentRuntimeEvent extends infer T
  ? T extends AgentRuntimeEvent
    ? Omit<T, "ts">
    : never
  : never;

export function createRuntimeEvent(
  event: RuntimeEventInput,
  executionContext?: ExecutionContext
): AgentRuntimeEvent {
  return {
    ...event,
    ...(executionContext ? { correlation: executionCorrelation(executionContext) } : {}),
    ts: Date.now(),
  } as AgentRuntimeEvent;
}
