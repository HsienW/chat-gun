import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  buildAgentContext,
  type AgentContextLimits,
  type AssembledAgentContext,
} from "../context/agent-context-assembler.js";
import type { ContextHardLimitError } from "../context/context-errors.js";
import type { ContextSection } from "../context/context-source.js";
import { getBooleanEnv } from "../platform/env.js";
import { createErrorEnvelope, serializeErrorEnvelope } from "../platform/errors.js";
import {
  getConfiguredLlmCapabilities,
  type ModelPurpose,
} from "../platform/llm-gateway.js";
import { getMemoryComposition } from "../platform/memory-composition.js";
import { getAgentRuntimeConfig } from "../platform/runtime-config.js";
import {
  readCanonicalExecutionContext,
} from "../runtime/execution-context/read-execution-context.js";
import {
  buildConversationContext,
  getLatestUserMessage,
  isAiMessage,
  isHumanMessage,
  messageContentToString,
} from "../state.js";

export type ContextEnabledAgent = "chatbot" | "math" | "mcp" | "deep_researcher";

const FEATURE_FLAG_BY_AGENT: Readonly<Record<ContextEnabledAgent, string>> = {
  chatbot: "CONTEXT_ASSEMBLY_ENABLED_CHATBOT",
  math: "CONTEXT_ASSEMBLY_ENABLED_MATH",
  mcp: "CONTEXT_ASSEMBLY_ENABLED_MCP",
  deep_researcher: "CONTEXT_ASSEMBLY_ENABLED_DEEP_RESEARCHER",
};

export function isContextAssemblyEnabled(agent: ContextEnabledAgent): boolean {
  return getBooleanEnv(FEATURE_FLAG_BY_AGENT[agent], true);
}

export function legacyChatbotPrompt(
  template: string,
  messages: BaseMessage[]
): string {
  return template
    .replaceAll("{conversation_context}", buildConversationContext(messages))
    .replaceAll("{current_message}", getLatestUserMessage(messages));
}

export function legacyMathMessages(
  systemPolicy: string,
  latestUserText: string
): Array<{ role: "system" | "human"; content: string }> {
  return [
    { role: "system", content: systemPolicy },
    { role: "human", content: latestUserText },
  ];
}

export function legacyMcpMessages(
  systemPolicy: string,
  messages: BaseMessage[]
): McpModelMessage[] {
  return [{ role: "system", content: systemPolicy }, ...messages];
}

function defaultLimits(purpose: ModelPurpose): AgentContextLimits {
  const config = getAgentRuntimeConfig();
  return {
    contextBudgetTotal: config.contextBudgetTotal,
    contextOutputReserveTokens: config.contextOutputReserveTokens,
    capabilities: getConfiguredLlmCapabilities(purpose),
  };
}

function memoryBoundary(config?: RunnableConfig) {
  const executionContext = readCanonicalExecutionContext(config);
  if (!executionContext) {
    return { executionContext, provider: undefined };
  }
  const provider = getMemoryComposition().provider;
  if (!provider) return { executionContext, provider };
  return {
    executionContext,
    provider,
    memoryRecall: {
      principal: executionContext.principal,
      scope: executionContext.scope,
      namespace: {
        tenantId: executionContext.principal.tenantId,
        principalId: executionContext.principal.principalId,
        scopeId: executionContext.scope.scopeId,
      },
    },
  };
}

function latestHumanIndex(messages: readonly BaseMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(messages[index])) return index;
  }
  return -1;
}

function conversationLabel(message: BaseMessage): string {
  if (isHumanMessage(message)) return "Recent user message";
  if (isAiMessage(message)) return "Recent assistant message";
  return "Recent message";
}

export interface AssembleAgentContextInput {
  systemPolicy: string;
  currentTaskLabel?: string;
  messages: readonly BaseMessage[];
  purpose?: ModelPurpose;
  config?: RunnableConfig;
  limits?: AgentContextLimits;
  activeState?: ReadonlyArray<{ content: string; referenceId?: string }>;
  toolOutputs?: ReadonlyArray<{ content: string; referenceId?: string }>;
  signal?: AbortSignal;
}

export async function assembleAgentContext(
  input: AssembleAgentContextInput
): Promise<AssembledAgentContext> {
  const currentIndex = latestHumanIndex(input.messages);
  const sources: ContextSection[] = [
    {
      source: "system_policy",
      label: "System policy",
      content: input.systemPolicy,
      referenceId: "system-policy",
    },
  ];
  if (currentIndex >= 0) {
    sources.push({
      source: "current_task",
      label: input.currentTaskLabel ?? "Current task",
      content: messageContentToString(input.messages[currentIndex]),
      referenceId: `message-${currentIndex}`,
    });
  }
  input.messages.forEach((message, index) => {
    if (index === currentIndex) return;
    const tool = message.getType?.() === "tool";
    sources.push({
      source: tool ? "tool_output" : "recent_messages",
      label: tool ? "Tool output" : conversationLabel(message),
      content: messageContentToString(message),
      referenceId: `message-${index}`,
    });
  });
  input.activeState?.forEach((state, index) => {
    sources.push({
      source: "active_state",
      label: "Active state",
      content: state.content,
      referenceId: state.referenceId ?? `active-state-${index}`,
    });
  });
  input.toolOutputs?.forEach((output, index) => {
    sources.push({
      source: "tool_output",
      label: "Tool output",
      content: output.content,
      referenceId: output.referenceId ?? `tool-output-${index}`,
    });
  });
  const memory = memoryBoundary(input.config);
  return buildAgentContext({
    sources,
    limits: input.limits ?? defaultLimits(input.purpose ?? "chat"),
    ...(memory.executionContext === undefined
      ? {}
      : { executionContext: memory.executionContext }),
    ...(memory.provider === undefined ? {} : { memoryProvider: memory.provider }),
    ...(memory.memoryRecall === undefined ? {} : { memoryRecall: memory.memoryRecall }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

type SystemModelMessage = { role: "system"; content: string };
export type McpModelMessage = BaseMessage | SystemModelMessage;

interface McpUnit {
  startIndex: number;
  referenceId: string;
  source: "recent_messages" | "tool_output";
  content: string;
  messages: BaseMessage[];
}

function toolCallIds(message: BaseMessage): string[] {
  if (!isAiMessage(message)) return [];
  const calls = (message as AIMessage).tool_calls ?? [];
  return calls.map(({ id }) => id).filter((id): id is string => Boolean(id));
}

function toolMessageId(message: BaseMessage): string | undefined {
  return message.getType?.() === "tool"
    ? (message as ToolMessage).tool_call_id
    : undefined;
}

function boundedMessageContent(message: BaseMessage, content: string): BaseMessage {
  if (isHumanMessage(message)) return new HumanMessage(content);
  if (isAiMessage(message)) return new AIMessage(content);
  return message;
}

function mcpUnits(messages: readonly BaseMessage[], currentIndex: number): McpUnit[] {
  const units: McpUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index === currentIndex) continue;
    const message = messages[index];
    if (message.getType?.() === "system") continue;
    const callIds = toolCallIds(message);
    if (callIds.length > 0) {
      const paired: BaseMessage[] = [message];
      let cursor = index + 1;
      while (cursor < messages.length) {
        const candidate = messages[cursor];
        const toolId = toolMessageId(candidate);
        if (!toolId || !callIds.includes(toolId)) break;
        paired.push(candidate);
        cursor += 1;
      }
      if (paired.length > 1) {
        units.push({
          startIndex: index,
          referenceId: `tool-pair-${index}`,
          source: "tool_output",
          content: paired.map(messageContentToString).join("\n"),
          messages: paired,
        });
      }
      index = cursor - 1;
      continue;
    }
    if (toolMessageId(message)) continue;
    units.push({
      startIndex: index,
      referenceId: `message-${index}`,
      source: "recent_messages",
      content: messageContentToString(message),
      messages: [message],
    });
  }
  return units;
}

export async function assembleMcpMessageContext(input: {
  systemPolicy: string;
  messages: readonly BaseMessage[];
  config?: RunnableConfig;
  limits?: AgentContextLimits;
  signal?: AbortSignal;
}): Promise<{ messages: McpModelMessage[]; assembled: AssembledAgentContext }> {
  const currentIndex = latestHumanIndex(input.messages);
  const units = mcpUnits(input.messages, currentIndex);
  const sources: ContextSection[] = [
    {
      source: "system_policy",
      content: input.systemPolicy,
      label: "System policy",
      referenceId: "system-policy",
    },
    ...(currentIndex < 0
      ? []
      : [{
          source: "current_task" as const,
          content: messageContentToString(input.messages[currentIndex]),
          label: "Current task",
          referenceId: `message-${currentIndex}`,
        }]),
    ...units.map(({ source, content, referenceId }) => ({
      source,
      content,
      referenceId,
      label: source === "tool_output" ? "Tool exchange" : "Recent message",
    })),
  ];
  const memory = memoryBoundary(input.config);
  const assembled = await buildAgentContext({
    sources,
    limits: input.limits ?? defaultLimits("tool"),
    ...(memory.executionContext === undefined
      ? {}
      : { executionContext: memory.executionContext }),
    ...(memory.provider === undefined ? {} : { memoryProvider: memory.provider }),
    ...(memory.memoryRecall === undefined ? {} : { memoryRecall: memory.memoryRecall }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const retained = new Map(
    assembled.blocks.map((block) => [block.referenceId, block] as const)
  );
  const bounded: McpModelMessage[] = [{ role: "system", content: input.systemPolicy }];
  const selected: Array<{ index: number; messages: BaseMessage[] }> = [];
  for (const unit of units) {
    const retainedBlock = retained.get(unit.referenceId);
    if (!retainedBlock) continue;
    if (
      unit.source === "tool_output" &&
      retainedBlock.content !== unit.content
    ) {
      continue;
    }
    selected.push({
      index: unit.startIndex,
      messages:
        retainedBlock.content === unit.content
          ? unit.messages
          : unit.messages.map((message) =>
              boundedMessageContent(message, retainedBlock.content)
            ),
    });
  }
  if (currentIndex >= 0 && retained.has(`message-${currentIndex}`)) {
    selected.push({ index: currentIndex, messages: [input.messages[currentIndex]] });
  }
  selected
    .sort((left, right) => left.index - right.index)
    .forEach(({ messages }) => bounded.push(...messages));
  return { messages: bounded, assembled };
}

export function contextHardLimitErrorMessage(
  error: ContextHardLimitError,
  config?: RunnableConfig
): AIMessage {
  const executionContext = readCanonicalExecutionContext(config);
  return new AIMessage(
    serializeErrorEnvelope(
      createErrorEnvelope(error, {
        source: "backend",
        stage: "context_assembly",
        code: error.code,
        details: { ...error.details },
        ...(executionContext === undefined ? {} : { executionContext }),
      })
    )
  );
}
