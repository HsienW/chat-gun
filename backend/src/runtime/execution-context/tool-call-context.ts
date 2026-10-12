import type { RunnableConfig } from "@langchain/core/runnables";
import { createRawInputReference } from "../input/normalized-agent-input.js";
import { readCanonicalExecutionContext, readExecutionCorrelation, withExecutionContext } from "./read-execution-context.js";

export function createToolCallContext(
  config: RunnableConfig | undefined,
  nodeName: string,
  toolName: string,
  input: Record<string, unknown>,
): { config: RunnableConfig; toolCallId: string } {
  const parent = readCanonicalExecutionContext(config);
  if (!parent) {
    const toolCallId = crypto.randomUUID();
    const existingStepId = readExecutionCorrelation(config).stepId;
    return {
      toolCallId,
      config: {
        ...config,
        configurable: {
          ...config?.configurable,
          tool_call_id: toolCallId,
          ...(existingStepId ? {} : { step_id: nodeName }),
        },
      },
    };
  }
  const digest = createRawInputReference({ taskId: parent.taskId, nodeName, toolName, input }).digest;
  const toolCallId = `call-${digest}`;
  const stepId = `step-${digest}`;
  const prepared = {
    ...config,
    configurable: { ...config?.configurable, tool_call_id: toolCallId, step_id: stepId },
  };
  return {
    config: withExecutionContext(prepared, { ...parent, toolCallId, stepId }),
    toolCallId,
  };
}
