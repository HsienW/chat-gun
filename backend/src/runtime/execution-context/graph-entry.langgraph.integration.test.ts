import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { createGraphEntryContextResolver } from "./graph-entry.js";
import { instrumentGraphWithExecutionContext } from "./instrument-graph.js";
import { readCanonicalExecutionContext } from "./read-execution-context.js";
import type { ExecutionContext } from "./execution-context.js";

const trustedConfig = {
  configurable: {
    thread_id: "thread-memory-saver",
    "x-request-id": "request-1",
    "x-bff-principal-id": "principal-1",
    "x-bff-principal-type": "service",
    "x-bff-tenant-id": "tenant-1",
    "x-bff-roles": "member",
    "x-bff-scopes": "search:read",
    "x-bff-auth-source": "trusted_gateway",
    "x-bff-authenticated-at": "2026-10-11T00:00:00.000Z",
    "x-bff-scope-id": "scope-1",
    "x-bff-scope-type": "tenant",
  },
};

describe("LangGraph graph entry identity with MemorySaver", () => {
  it("restores product runId from admission binding while native run_id changes on resume", async () => {
    const State = Annotation.Root({
      executionTaskId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
      decision: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
    });
    const observedContexts: Array<{ runId: string; taskId: string; nativeRunId: string | undefined }> = [];
    const graph = new StateGraph(State)
      .addNode("admit", (_state, config) => {
        const context = readCanonicalExecutionContext(config);
        if (!context) throw new Error("Missing canonical execution context");
        const nativeRunId = (config.configurable as Record<string, unknown> | undefined)?.nativeRunId;
        observedContexts.push({ runId: context.runId, taskId: context.taskId, nativeRunId: typeof nativeRunId === "string" ? nativeRunId : undefined });
        return { executionTaskId: context.taskId };
      })
      .addNode("approve", (_state, config) => {
        const context = readCanonicalExecutionContext(config);
        if (!context) throw new Error("Missing canonical execution context");
        const nativeRunId = (config.configurable as Record<string, unknown> | undefined)?.nativeRunId;
        observedContexts.push({ runId: context.runId, taskId: context.taskId, nativeRunId: typeof nativeRunId === "string" ? nativeRunId : undefined });
        return { decision: String(interrupt({ kind: "approval" })) };
      })
      .addEdge(START, "admit")
      .addEdge("admit", "approve")
      .addEdge("approve", END)
      .compile({ checkpointer: new MemorySaver() });

    const bindings = new Map<string, string>();
    const admission = {
      async admit(context: ExecutionContext, resumeTaskId?: string) {
        if (resumeTaskId) {
          const runId = bindings.get(resumeTaskId);
          if (!runId) throw new Error("Missing durable product Run binding");
          return { taskId: resumeTaskId, runId };
        }
        bindings.set(context.taskId, context.runId);
        return { taskId: context.taskId, runId: context.runId };
      },
    };
    const wrapped = instrumentGraphWithExecutionContext(
      graph,
      createGraphEntryContextResolver(graph, admission),
    );

    const paused = await wrapped.invoke({}, {
      ...trustedConfig,
      configurable: { ...trustedConfig.configurable, run_id: "native-run-first" },
    });
    const checkpoint = await wrapped.getState({ configurable: trustedConfig.configurable });
    const productRunId = observedContexts[0]?.runId;
    expect(paused).toMatchObject({ executionTaskId: expect.any(String) });
    expect(checkpoint.next).toEqual(["approve"]);
    expect(productRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(productRunId).not.toBe("native-run-first");
    const taskId = checkpoint.values.executionTaskId;

    const resumed = await wrapped.invoke(new Command({ resume: "approved" }), {
      ...trustedConfig,
      configurable: { ...trustedConfig.configurable, run_id: "native-run-resume" },
    });
    expect(resumed).toMatchObject({ executionTaskId: taskId, decision: "approved" });
    expect(observedContexts[1]?.runId).toBe(productRunId);
    expect(observedContexts[1]?.taskId).toBe(taskId);
    expect(observedContexts.map(({ runId }) => runId)).toEqual([productRunId, productRunId, productRunId]);
    expect(observedContexts.map(({ nativeRunId }) => nativeRunId)).toEqual(["native-run-first", "native-run-first", "native-run-resume"]);
    expect(observedContexts.every(({ runId, nativeRunId }) => runId !== nativeRunId)).toBe(true);
  });
});
