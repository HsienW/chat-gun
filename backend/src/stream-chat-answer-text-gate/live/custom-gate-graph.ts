import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

import { applyInteractionGovernance, productionInteractionOrchestrator } from "../../platform/interaction-runtime.js";
import { REGISTERED_GRAPH_IDS, instrumentGraphWithUsageAttribution } from "../../platform/usage/attribution.js";

// stream-chat-answer-text Task 1.2 live gate only (registered by live/langgraph.json, never by production):
// writes a custom event, then holds the node so arrival before node return is observable end to end.
const HOLD_MS = 4000;

async function customGate(_state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) {
  config.writer?.({ gate: "before-return", writtenAt: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  return { messages: [] };
}

const compiled = new StateGraph(MessagesAnnotation)
  .addNode("custom_gate", customGate)
  .addEdge(START, "custom_gate")
  .addEdge("custom_gate", END)
  .compile();

// Same wrapper stack and order as chatbotGraph.
export const customGateGraph = instrumentGraphWithUsageAttribution(
  applyInteractionGovernance(compiled, productionInteractionOrchestrator),
  REGISTERED_GRAPH_IDS.chatbot,
);
