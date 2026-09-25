import { AIMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

import { getEnv } from "../platform/env.js";
import { isContextHardLimitError } from "../context/context-errors.js";
import { llmGateway } from "../platform/llm-gateway.js";
import {
  applyInteractionGovernance,
  productionInteractionOrchestrator,
} from "../platform/interaction-runtime.js";
import { chatbotInstructions } from "../prompts.js";
import {
  assembleAgentContext,
  contextHardLimitErrorMessage,
  isContextAssemblyEnabled,
  legacyChatbotPrompt,
} from "./context-integration.js";

async function chatResponse(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig
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
      model: getEnv("CHAT_MODEL").trim() || undefined,
      temperature: Number(process.env.CHAT_TEMPERATURE ?? 0.7),
    });
    const response = await llm.invoke(prompt);
    return { messages: [response] };
  } catch (error) {
    if (!isContextHardLimitError(error)) throw error;
    return { messages: [contextHardLimitErrorMessage(error, config)] };
  }
}

const builder = new StateGraph(MessagesAnnotation)
  .addNode("chat_response", chatResponse)
  .addEdge(START, "chat_response")
  .addEdge("chat_response", END);

export const chatbotGraph = applyInteractionGovernance(
  builder.compile(),
  productionInteractionOrchestrator
);
