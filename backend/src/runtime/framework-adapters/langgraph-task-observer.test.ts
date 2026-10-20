import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../execution-context/execution-context.js";
import { instrumentLangGraphNode, observeLangGraphTasks, type GraphNodeStepPort } from "./langgraph-task-observer.js";
import { readCanonicalExecutionContext } from "../execution-context/read-execution-context.js";

const context: ExecutionContext = {
  requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1", attempt: 1,
  principal: { principalId: "principal-1", principalType: "service", tenantId: "tenant-1", roles: [], scopes: [], authSource: "service_token", authenticatedAt: "2026-10-14T00:00:00Z" },
  scope: { scopeId: "scope-1", scopeType: "tenant", tenantId: "tenant-1" },
};

function port() {
  let nextStep = 0;
  const start = vi.fn<GraphNodeStepPort["start"]>(async () => ({ stepId: `product-step-${++nextStep}`, attempt: nextStep }));
  const finish = vi.fn<GraphNodeStepPort["finish"]>(async () => {});
  return { start, finish };
}

describe("private LangGraph native task to product Step mapping", () => {
  it("does not complete a cancelled node or retry a failed completion write", async () => {
    const controller = new AbortController();
    const steps = port();
    const node = instrumentLangGraphNode(async () => { controller.abort(); return {}; }, {
      graphId: "fixture_graph", nodeName: "child", nativeTaskId: () => "native-child", port: steps,
    });
    await expect(node({}, { signal: controller.signal, configurable: { execution_context: context } })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(steps.finish.mock.calls.map(([input]) => input.outcome)).toEqual(["failed"]);
    const failedWrite = port();
    failedWrite.finish.mockRejectedValueOnce(new Error("store unavailable"));
    const completed = instrumentLangGraphNode(async () => ({}), {
      graphId: "fixture_graph", nodeName: "child", nativeTaskId: () => "native-child", port: failedWrite,
    });
    await expect(completed({}, { configurable: { execution_context: context } })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED" });
    expect(failedWrite.finish).toHaveBeenCalledOnce();
  });

  it("installs the trusted step and incremented attempt inside a real native node retry", async () => {
    const State = Annotation.Root({ value: Annotation<number>() });
    let attempt = 0;
    const steps = { start: vi.fn(async () => ({ stepId: "product-step-1", attempt: ++attempt })), finish: vi.fn<GraphNodeStepPort["finish"]>(async () => {}) };
    const observed: ExecutionContext[] = [];
    const node = instrumentLangGraphNode(async (_state: typeof State.State, config) => {
      const current = readCanonicalExecutionContext(config);
      if (!current) throw new Error("Missing node context");
      observed.push(current);
      if (current.attempt === 1) throw new Error("retry fixture");
      return { value: current.attempt };
    }, { graphId: "fixture_graph", nodeName: "retrying", nativeTaskId: () => "recorded-native-task", port: steps });
    const graph = new StateGraph(State).addNode("retrying", node, {
      retryPolicy: { maxAttempts: 2, initialInterval: 1, jitter: false, retryOn: () => true },
    }).addEdge(START, "retrying").addEdge("retrying", END).compile();
    expect(await graph.invoke({}, { configurable: { execution_context: context } })).toMatchObject({ value: 2 });
    expect(observed.map(({ runId, taskId, stepId, attempt }) => ({ runId, taskId, stepId, attempt }))).toEqual([
      { runId: "run-1", taskId: "task-1", stepId: "product-step-1", attempt: 1 },
      { runId: "run-1", taskId: "task-1", stepId: "product-step-1", attempt: 2 },
    ]);
    expect(steps.finish.mock.calls.map(([input]) => input.outcome)).toEqual(["failed", "completed"]);
  });

  it("maps two real graph nodes to distinct trusted product steps without treating native IDs as product IDs", async () => {
    const State = Annotation.Root({ value: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }) });
    const graph = new StateGraph(State)
      .addNode("first", (state) => ({ value: state.value + 1 }))
      .addNode("second", (state) => ({ value: state.value + 1 }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();
    const steps = port();
    const stream = await graph.stream({ value: 0 }, { streamMode: "tasks" });
    await observeLangGraphTasks(stream, { graphId: "fixture_graph", context, port: steps });
    expect(steps.start).toHaveBeenCalledTimes(2);
    expect(steps.finish).toHaveBeenCalledTimes(2);
    const starts = steps.start.mock.calls.map(([input]) => input);
    expect(starts.map(({ nodeName }) => nodeName)).toEqual(["first", "second"]);
    expect(starts.every(({ context: trusted }) => trusted.runId === "run-1" && trusted.taskId === "task-1")).toBe(true);
    expect(starts[0].nativeTaskId).not.toBe(starts[1].nativeTaskId);
    expect(steps.finish.mock.calls.map(([input]) => input.stepId)).toEqual(["product-step-1", "product-step-2"]);
    expect(steps.finish.mock.calls.map(([input]) => input.attempt)).toEqual([1, 2]);
    expect(steps.finish.mock.calls.every(([input]) => input.stepId !== input.nodeName && input.stepId !== input.nativeTaskId)).toBe(true);
  });

  it("rejects an orphan result or conflicting node name before product completion", async () => {
    const steps = port();
    async function* orphan() { yield { id: "native-1", name: "first", result: {}, interrupts: [] }; }
    await expect(observeLangGraphTasks(orphan(), { graphId: "fixture_graph", context, port: steps })).rejects.toMatchObject({ code: "ADAPTER_INVALID" });
    expect(steps.finish).not.toHaveBeenCalled();
    async function* conflict() {
      yield { id: "native-1", name: "first", input: {}, interrupts: [] };
      yield { id: "native-1", name: "second", result: {}, interrupts: [] };
    }
    await expect(observeLangGraphTasks(conflict(), { graphId: "fixture_graph", context, port: steps })).rejects.toMatchObject({ code: "ADAPTER_INVALID" });
    expect(steps.finish).not.toHaveBeenCalled();
  });

  it("rejects an invalid trusted context and never asks the port to create a product step", async () => {
    const steps = port();
    async function* events() { yield { id: "native-1", name: "first", input: {}, interrupts: [] }; }
    const invalid = { ...context, scope: { ...context.scope, tenantId: "other-tenant" } };
    await expect(observeLangGraphTasks(events(), { graphId: "fixture_graph", context: invalid, port: steps })).rejects.toMatchObject({ code: "ADAPTER_INVALID" });
    expect(steps.start).not.toHaveBeenCalled();
  });

  it("uses separate product attempts for repeated native tasks with the same node name", async () => {
    const steps = port();
    async function* retries() {
      yield { id: "native-1", name: "calculate", input: {}, interrupts: [] };
      yield { id: "native-1", name: "calculate", result: {}, interrupts: [] };
      yield { id: "native-2", name: "calculate", input: {}, interrupts: [] };
      yield { id: "native-2", name: "calculate", result: {}, interrupts: [] };
    }
    await observeLangGraphTasks(retries(), { graphId: "fixture_graph", context, port: steps });
    expect(steps.finish.mock.calls.map(([input]) => [input.stepId, input.attempt])).toEqual([
      ["product-step-1", 1], ["product-step-2", 2],
    ]);
  });

  it("preserves an interrupted node outcome and rejects an incomplete or cancelled task stream", async () => {
    const steps = port();
    async function* interrupted() {
      yield { id: "native-1", name: "approval", input: {}, interrupts: [] };
      yield { id: "native-1", name: "approval", result: {}, interrupts: [{ value: "wait" }] };
    }
    await observeLangGraphTasks(interrupted(), { graphId: "fixture_graph", context, port: steps });
    expect(steps.finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "interrupted" }));

    const pending = port();
    async function* incomplete() { yield { id: "native-2", name: "approval", input: {}, interrupts: [] }; }
    await expect(observeLangGraphTasks(incomplete(), { graphId: "fixture_graph", context, port: pending })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED" });
    expect(pending.finish).not.toHaveBeenCalled();

    const cancelled = port();
    const controller = new AbortController();
    async function* aborting() {
      yield { id: "native-3", name: "approval", input: {}, interrupts: [] };
      controller.abort();
      yield { id: "native-3", name: "approval", result: {}, interrupts: [] };
    }
    await expect(observeLangGraphTasks(aborting(), { graphId: "fixture_graph", context, port: cancelled, signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(cancelled.finish).not.toHaveBeenCalled();
  });
});
