import { z } from "zod";

import { ContextPriority, type ContextItem } from "./context-budget.js";

export const AGENT_CONTEXT_SOURCES = [
  "system_policy",
  "current_task",
  "active_state",
  "memory",
  "recent_messages",
  "tool_output",
] as const;

export type AgentContextSource = (typeof AGENT_CONTEXT_SOURCES)[number];

export interface ContextSection {
  source: AgentContextSource;
  content: string;
  referenceId?: string;
  label?: string;
}

export interface SourcedContextItem extends ContextItem {
  source: AgentContextSource;
  referenceId?: string;
}

const contextSectionSchema = z.object({
  source: z.enum(AGENT_CONTEXT_SOURCES),
  content: z.string(),
  referenceId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
}).strict();

const PRIORITY_BY_SOURCE: Readonly<Record<AgentContextSource, ContextPriority>> = {
  system_policy: ContextPriority.P0,
  current_task: ContextPriority.P1,
  active_state: ContextPriority.P2,
  memory: ContextPriority.P3,
  recent_messages: ContextPriority.P4,
  tool_output: ContextPriority.P5,
};

export function priorityForSource(source: AgentContextSource): ContextPriority {
  const priority = PRIORITY_BY_SOURCE[source];
  if (priority === undefined) {
    throw new TypeError(`Unknown context source: ${String(source)}`);
  }
  return priority;
}

export function toContextItem(input: unknown): SourcedContextItem {
  const section = contextSectionSchema.parse(input);
  return {
    priority: priorityForSource(section.source),
    label: section.label ?? section.source,
    content: section.content,
    source: section.source,
    ...(section.referenceId === undefined
      ? {}
      : { referenceId: section.referenceId }),
  };
}
