import { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

import { getEnv } from "../platform/env.js";
import { isContextHardLimitError } from "../context/context-errors.js";
import { llmGateway } from "../platform/llm-gateway.js";
import {
  applyInteractionGovernance,
  productionInteractionOrchestrator,
} from "../platform/interaction-runtime.js";
import {
  instrumentGraphWithOpik,
  withOpikNode,
} from "../platform/tracing/opik/opik-graph.js";
import { mcpSystemMessage } from "../prompts.js";
import { loadAgentToolRuntime } from "../tools/registry.js";
import {
  createToolAuthorizationGraphNodes,
  routeAfterAuthorizationConfirmation,
  routeAfterAuthorizationGate,
  routeAfterPhysicalDispatch,
  type AuthorizationGraphState,
} from "../runtime/authorization/confirmation-graph.js";
import {
  readDevelopmentExecutionContext,
  readExecutionContext,
} from "../runtime/execution-context/read-execution-context.js";
import { instrumentGraphWithExecutionContext } from "../runtime/execution-context/instrument-graph.js";
import { normalizeAiMessageForStream } from "./message-normalization.js";
import {
  assembleMcpMessageContext,
  contextHardLimitErrorMessage,
  isContextAssemblyEnabled,
  legacyMcpMessages,
} from "./context-integration.js";

const { tools, confirmationStore } = await loadAgentToolRuntime("mcp_agent", {
  includeMcp: true,
});
const authorizationNodes = createToolAuthorizationGraphNodes({
  tools,
  confirmationStore,
});

const McpAgentAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  toolQueue: Annotation<AuthorizationGraphState["toolQueue"]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  activeToolCall: Annotation<AuthorizationGraphState["activeToolCall"]>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  pendingAuthorization: Annotation<AuthorizationGraphState["pendingAuthorization"]>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
});

function shouldContinue(
  state: typeof McpAgentAnnotation.State
): "authorization_gate" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1] as {
    tool_calls?: unknown[];
  };
  return lastMessage?.tool_calls?.length ? "authorization_gate" : END;
}

async function callModel(
  state: typeof McpAgentAnnotation.State,
  config: RunnableConfig
): Promise<typeof McpAgentAnnotation.Update> {
  try {
    const modelInput = isContextAssemblyEnabled("mcp")
      ? (await assembleMcpMessageContext({
          systemPolicy: mcpSystemMessage,
          messages: state.messages,
          config,
        })).messages
      : legacyMcpMessages(mcpSystemMessage, state.messages);
    const llm = llmGateway.createChatModel({
      purpose: "tool",
      model: getEnv("MCP_AGENT_MODEL").trim() || undefined,
      temperature: Number(process.env.MCP_AGENT_TEMPERATURE ?? 0.2),
    });
    if (!llm.bindTools) {
      throw new Error("The selected model does not support bindTools.");
    }
    const response = await llm.bindTools(tools).invoke(modelInput);
    return { messages: [normalizeAiMessageForStream(response)] };
  } catch (error) {
    if (!isContextHardLimitError(error)) throw error;
    return { messages: [contextHardLimitErrorMessage(error, config)] };
  }
}

const builder = new StateGraph(McpAgentAnnotation)
  .addNode("call_model", withOpikNode("call_model", callModel))
  .addNode(
    "authorization_gate",
    withOpikNode("authorization_gate", authorizationNodes.authorizationGate)
  )
  .addNode(
    "authorization_confirmation",
    withOpikNode(
      "authorization_confirmation",
      authorizationNodes.authorizationConfirmation
    )
  )
  .addNode(
    "physical_dispatch",
    withOpikNode("physical_dispatch", authorizationNodes.physicalDispatch)
  )
  .addEdge(START, "call_model")
  .addConditionalEdges("call_model", shouldContinue, {
    authorization_gate: "authorization_gate",
    [END]: END,
  })
  .addConditionalEdges("authorization_gate", routeAfterAuthorizationGate, {
    confirmation: "authorization_confirmation",
    dispatch: "physical_dispatch",
    gate: "authorization_gate",
    model: "call_model",
  })
  .addConditionalEdges(
    "authorization_confirmation",
    routeAfterAuthorizationConfirmation,
    {
      dispatch: "physical_dispatch",
      gate: "authorization_gate",
      model: "call_model",
    }
  )
  .addConditionalEdges("physical_dispatch", routeAfterPhysicalDispatch, {
    gate: "authorization_gate",
    model: "call_model",
  });

function resolveMcpExecutionContext(input: unknown, config: unknown) {
  return getEnv("TOOL_AUTHORIZATION_PROFILE", "production") === "development"
    ? readDevelopmentExecutionContext(input, config)
    : readExecutionContext(input, config, "production");
}

export const mcpAgentGraph = instrumentGraphWithExecutionContext(
  applyInteractionGovernance(
    instrumentGraphWithOpik(builder.compile(), "mcp_agent"),
    productionInteractionOrchestrator
  ),
  resolveMcpExecutionContext
);
