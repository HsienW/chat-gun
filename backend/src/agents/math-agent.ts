import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createHash } from "node:crypto";

import { getEnv } from "../platform/env.js";
import { isContextHardLimitError } from "../context/context-errors.js";
import { llmGateway } from "../platform/llm-gateway.js";
import {
  applyInteractionGovernance,
  productionInteractionOrchestrator,
} from "../platform/interaction-runtime.js";
import { mathSystemMessage } from "../prompts.js";
import { isHumanMessage } from "../state.js";
import {
  isToolDispatchPipelineEnabled,
  loadMathCalculatorTool,
} from "../tools/registry.js";
import {
  readCanonicalExecutionContext,
  readDevelopmentExecutionContext,
  readExecutionContext,
  withExecutionContext,
} from "../runtime/execution-context/read-execution-context.js";
import { instrumentGraphWithExecutionContext } from "../runtime/execution-context/instrument-graph.js";
import {
  tryToLegacyToolResult,
} from "../runtime/tool-dispatch/structured-tool-result.js";
import {
  assembleAgentContext,
  contextHardLimitErrorMessage,
  isContextAssemblyEnabled,
  legacyMathMessages,
} from "./context-integration.js";

const mathDispatchPipelineEnabled =
  isToolDispatchPipelineEnabled("math_agent");
const mathCalculatorTool = await loadMathCalculatorTool();

function mathToolConfig(
  config: RunnableConfig,
  expression: string
): RunnableConfig {
  const context = readCanonicalExecutionContext(config);
  if (!mathDispatchPipelineEnabled || context === undefined) {
    return config;
  }
  const correlationHash = createHash("sha256")
    .update(`${context.runId}:${expression}`)
    .digest("hex")
    .slice(0, 24);
  return withExecutionContext({ ...config }, {
    ...context,
    stepId: context.stepId ?? `math-step-${correlationHash}`,
    toolCallId: context.toolCallId ?? `math-call-${correlationHash}`,
  });
}

function presentMathToolResult(result: unknown): string {
  return tryToLegacyToolResult(result) ?? String(result);
}

function extractExpressionFromUserMessage(messages: BaseMessage[]): string {
  const latestHuman = [...messages]
    .reverse()
    .find((message) => isHumanMessage(message));

  const content =
    typeof latestHuman?.content === "string" ? latestHuman.content : "";
  const candidates =
    content.match(
      /(?:sqrt|sin|cos|tan|log10|log|exp|abs|round|ceil|floor|pi|e|[\d+\-*/().\s])+/gi
    ) ?? [];

  return candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => /\d/.test(candidate))
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function latestUserText(messages: BaseMessage[]): string {
  const latestHuman = [...messages]
    .reverse()
    .find((message) => isHumanMessage(message));
  return typeof latestHuman?.content === "string" ? latestHuman.content : "";
}

async function callModel(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig
): Promise<typeof MessagesAnnotation.Update> {
  const expression = extractExpressionFromUserMessage(state.messages);

  if (expression) {
    const rawResult = await mathCalculatorTool.invoke(
      { expression },
      mathToolConfig(config, expression)
    );
    const result = presentMathToolResult(rawResult);
    return {
      messages: [
        new AIMessage(
          `計算步驟：\n\n1. 從問題中抽取 expression：\`${expression}\`。\n2. 使用 calculator_tool 計算。\n3. 得到結果：\`${result}\`。\n\n最終答案是 **${result}**。`
        ),
      ],
    };
  }

  try {
    const modelInput = isContextAssemblyEnabled("math")
      ? (await assembleAgentContext({
          systemPolicy: mathSystemMessage,
          messages: state.messages,
          purpose: "math",
          config,
        })).text
      : legacyMathMessages(mathSystemMessage, latestUserText(state.messages));
    const llm = llmGateway.createChatModel({
      purpose: "math",
      model: getEnv("MATH_MODEL").trim() || undefined,
      temperature: Number(process.env.MATH_TEMPERATURE ?? 0.1),
    });
    const response = await llm.invoke(modelInput);
    return { messages: [response] };
  } catch (error) {
    if (!isContextHardLimitError(error)) throw error;
    return { messages: [contextHardLimitErrorMessage(error, config)] };
  }
}

const builder = new StateGraph(MessagesAnnotation)
  .addNode("call_model", callModel)
  .addEdge(START, "call_model")
  .addEdge("call_model", END);

const governedMathGraph = applyInteractionGovernance(
  builder.compile(),
  productionInteractionOrchestrator
);

function resolveMathExecutionContext(input: unknown, config: unknown) {
  return getEnv("TOOL_AUTHORIZATION_PROFILE", "production") === "development"
    ? readDevelopmentExecutionContext(input, config)
    : readExecutionContext(input, config, "production");
}

export const mathAgentGraph = mathDispatchPipelineEnabled
  ? instrumentGraphWithExecutionContext(
      governedMathGraph,
      resolveMathExecutionContext
    )
  : governedMathGraph;
