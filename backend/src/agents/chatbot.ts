import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

import { getEnv } from "../platform/env.js";
import { isContextHardLimitError } from "../context/context-errors.js";
import { toAnswerStreamRunError } from "../platform/answer-text-sink.js";
import { chatModelDefaults, llmGateway } from "../platform/llm-gateway.js";
import { REGISTERED_GRAPH_IDS, instrumentGraphWithUsageAttribution, readUsageAttribution } from "../platform/usage/attribution.js";
import {
  applyInteractionGovernance,
  productionInteractionOrchestrator,
} from "../platform/interaction-runtime.js";
import { chatbotInstructions } from "../prompts.js";
import { getRuntimeIdentityStatusInstrumentation } from "../runtime/authorization/identity-status-composition.js";
import {
  answerStreamSequenceAllocator,
  createAnswerStreamWiring,
  registerAnswerStreamGraph,
  type AnswerStreamWiring,
} from "../runtime/answer-stream/answer-stream-wiring.js";
import { createGraphEntryContextResolver } from "../runtime/execution-context/graph-entry.js";
import { PgGraphTaskAdmission } from "../runtime/execution-context/graph-task-admission.js";
import { instrumentGraphWithExecutionContext } from "../runtime/execution-context/instrument-graph.js";
import {
  assembleAgentContext,
  contextHardLimitErrorMessage,
  isContextAssemblyEnabled,
  legacyChatbotPrompt,
} from "./context-integration.js";

/**
 * The final message carries the streamed draft's id (design D4). Messages serialize from their
 * constructor fields, so the id must be set by constructing a new message, not by assignment.
 */
function withMessageId(message: BaseMessage, id: string): BaseMessage {
  if (!AIMessage.isInstance(message)) return message;
  return new AIMessage({
    id,
    content: message.content,
    name: message.name,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
  });
}

function createChatResponseNode(answerStream: AnswerStreamWiring) {
  return async function chatResponse(
    state: typeof MessagesAnnotation.State,
    config: LangGraphRunnableConfig
  ): Promise<typeof MessagesAnnotation.Update> {
    if (!state.messages.length) {
      return {
        messages: [new AIMessage("你好！今天需要我幫你什麼？")],
      };
    }

    try {
      const prompt = isContextAssemblyEnabled("chatbot")
        ? (await assembleAgentContext({
            systemPolicy: chatbotInstructions
              .replaceAll("{conversation_context}", "")
              .replaceAll("{current_message}", ""),
            messages: state.messages,
            purpose: "chat",
            config,
          })).text
        : legacyChatbotPrompt(chatbotInstructions, state.messages);
      const llm = llmGateway.createChatModel({
        purpose: "chat",
        ...chatModelDefaults(),
        model: getEnv("CHAT_MODEL").trim() || undefined,
        temperature: Number(process.env.CHAT_TEMPERATURE ?? 0.7),
      });
      // Decided before generation: the message id allocated here is the final message's id.
      const streaming = await answerStream.prepare(config);
      const response = await llm.invoke(prompt, {
        signal: config.signal,
        attribution: readUsageAttribution(config),
        ...(streaming.kind === "stream" ? { answerTextSink: streaming.sink } : {}),
      });
      return { messages: [streaming.kind === "stream" ? withMessageId(response, streaming.messageId) : response] };
    } catch (error) {
      // Answer streaming failures reach the browser as a coded ErrorEnvelope (design D12).
      const answerStreamError = toAnswerStreamRunError(error);
      if (answerStreamError) throw answerStreamError;
      if (!isContextHardLimitError(error)) throw error;
      return { messages: [contextHardLimitErrorMessage(error, config)] };
    }
  };
}

/** The chatbot node graph; production adds context, governance and usage wrappers below. */
export function buildChatbotGraph(answerStream: AnswerStreamWiring) {
  return new StateGraph(MessagesAnnotation)
    .addNode("chat_response", createChatResponseNode(answerStream))
    .addEdge(START, "chat_response")
    .addEdge("chat_response", END)
    .compile();
}

const compiledChatbotGraph = buildChatbotGraph(
  createAnswerStreamWiring({ sequenceAllocator: answerStreamSequenceAllocator })
);

// Same composition as deep_researcher (design D4 chatbot wiring decision): the trusted
// ExecutionContext is resolved and admitted at graph entry before governance runs.
export const chatbotGraph = instrumentGraphWithUsageAttribution(instrumentGraphWithExecutionContext(
  applyInteractionGovernance(
    compiledChatbotGraph,
    productionInteractionOrchestrator
  ),
  createGraphEntryContextResolver(compiledChatbotGraph, new PgGraphTaskAdmission()),
  getRuntimeIdentityStatusInstrumentation(),
), REGISTERED_GRAPH_IDS.chatbot);

registerAnswerStreamGraph(REGISTERED_GRAPH_IDS.chatbot);
