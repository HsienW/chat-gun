import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isGraphInterrupt } from "@langchain/langgraph";

import { executionContextSchema, executionIdSchema, type ExecutionContext } from "../execution-context/execution-context.js";
import { FrameworkAdapterError } from "./bounded-operation.js";
import { readCanonicalExecutionContext, withExecutionContext } from "../execution-context/read-execution-context.js";

const nativeTaskSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  interrupts: z.array(z.unknown()),
});

const productStepSchema = z.object({
  stepId: executionIdSchema,
  attempt: z.number().int().positive().safe(),
}).strict();

export interface GraphNodeStepReference {
  context: ExecutionContext;
  graphId: string;
  nativeTaskId: string;
  nodeName: string;
}

export interface GraphNodeStepPort {
  start(reference: GraphNodeStepReference): Promise<{ stepId: string; attempt: number }>;
  finish(reference: GraphNodeStepReference & {
    stepId: string;
    attempt: number;
    outcome: "completed" | "interrupted" | "failed";
  }): Promise<void>;
}

/** Each native invocation/retry obtains its step/attempt from the existing trusted owner. */
export function instrumentLangGraphNode<Input, Output>(
  node: (state: Input, config: RunnableConfig) => Promise<Output>,
  host: { graphId: string; nodeName: string; nativeTaskId(config: RunnableConfig): string; port: GraphNodeStepPort },
) {
  return async (state: Input, config: RunnableConfig): Promise<Output> => {
    const context = readCanonicalExecutionContext(config);
    const nativeTaskId = executionIdSchema.safeParse(host.nativeTaskId(config));
    if (!context || !nativeTaskId.success || !executionIdSchema.safeParse(host.graphId).success || !executionIdSchema.safeParse(host.nodeName).success) throw new FrameworkAdapterError("ADAPTER_INVALID");
    if (config.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
    const reference = { context, graphId: host.graphId, nodeName: host.nodeName, nativeTaskId: nativeTaskId.data };
    const step = productStepSchema.safeParse(await host.port.start(reference));
    if (!step.success || step.data.stepId === reference.nativeTaskId || step.data.stepId === reference.nodeName) throw new FrameworkAdapterError("ADAPTER_INVALID");
    const completion = { ...reference, ...step.data };
    let output: Output;
    try {
      if (config.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
      output = await node(state, withExecutionContext({ ...config }, { ...context, ...step.data }));
      if (config.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
    } catch (error) {
      await host.port.finish({ ...completion, outcome: isGraphInterrupt(error) ? "interrupted" : "failed" });
      if (isGraphInterrupt(error) || error instanceof FrameworkAdapterError) throw error;
      throw new FrameworkAdapterError("ADAPTER_NODE_FAILED");
    }
    try { await host.port.finish({ ...completion, outcome: "completed" }); }
    catch { throw new FrameworkAdapterError("ADAPTER_OPERATION_FAILED"); }
    return output;
  };
}

export async function observeLangGraphTasks(
  stream: AsyncIterable<unknown>,
  options: {
    graphId: string;
    context: ExecutionContext;
    port: GraphNodeStepPort;
    signal?: AbortSignal;
  },
): Promise<void> {
  const context = executionContextSchema.safeParse(options.context);
  const graphId = executionIdSchema.safeParse(options.graphId);
  if (!context.success || !graphId.success || typeof options.port?.start !== "function" || typeof options.port.finish !== "function") {
    throw new FrameworkAdapterError("ADAPTER_INVALID");
  }
  const active = new Map<string, { reference: GraphNodeStepReference; stepId: string; attempt: number }>();
  const finished = new Set<string>();
  try {
    for await (const raw of stream) {
      if (options.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
      const parsed = nativeTaskSchema.safeParse(raw);
      if (!parsed.success || raw === null || typeof raw !== "object") throw new FrameworkAdapterError("ADAPTER_INVALID");
      const { id: nativeTaskId, name: nodeName, interrupts } = parsed.data;
      const start = Object.hasOwn(raw, "input");
      const end = Object.hasOwn(raw, "result");
      if (start === end) throw new FrameworkAdapterError("ADAPTER_INVALID");
      if (start) {
        if (active.has(nativeTaskId) || finished.has(nativeTaskId)) throw new FrameworkAdapterError("ADAPTER_DUPLICATE");
        const reference = { context: context.data, graphId: graphId.data, nativeTaskId, nodeName };
        const productStep = productStepSchema.safeParse(await options.port.start(reference));
        if (!productStep.success || productStep.data.stepId === nodeName || productStep.data.stepId === nativeTaskId) {
          throw new FrameworkAdapterError("ADAPTER_INVALID");
        }
        active.set(nativeTaskId, { reference, ...productStep.data });
        continue;
      }
      const matched = active.get(nativeTaskId);
      if (!matched || matched.reference.nodeName !== nodeName) throw new FrameworkAdapterError("ADAPTER_INVALID");
      await options.port.finish({
        ...matched.reference,
        stepId: matched.stepId,
        attempt: matched.attempt,
        outcome: interrupts.length > 0 ? "interrupted" : "completed",
      });
      active.delete(nativeTaskId);
      finished.add(nativeTaskId);
    }
    if (options.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
    if (active.size > 0) throw new FrameworkAdapterError("ADAPTER_OPERATION_FAILED");
  } catch (error) {
    if (error instanceof FrameworkAdapterError) throw error;
    throw new FrameworkAdapterError("ADAPTER_OPERATION_FAILED");
  }
}
