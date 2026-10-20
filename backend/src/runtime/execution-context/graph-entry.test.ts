import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { createGraphEntryContextResolver } from "./graph-entry.js";
import { instrumentGraphWithExecutionContext } from "./instrument-graph.js";
import { readCanonicalExecutionContext, readDevelopmentExecutionContext, readExecutionCorrelation } from "./read-execution-context.js";
import type { ExecutionContext } from "./execution-context.js";

const config = {
  configurable: {
    "x-request-id": "request-1", thread_id: "thread-1", run_id: "run-1",
    "x-bff-principal-id": "principal-1", "x-bff-principal-type": "service",
    "x-bff-tenant-id": "tenant-1", "x-bff-roles": "member",
    "x-bff-scopes": "search:read", "x-bff-auth-source": "trusted_gateway",
    "x-bff-authenticated-at": "2026-10-11T00:00:00.000Z",
    "x-bff-scope-id": "scope-1", "x-bff-scope-type": "tenant",
  },
};

function setup(values: unknown = {}, admissionTimeoutMs = 10_000) {
  const admit = vi.fn(async (context: ExecutionContext, resumeTaskId?: string) => ({
    taskId: resumeTaskId ?? context.taskId,
    runId: resumeTaskId ? "persisted-product-run" : context.runId,
  }));
  const graph = {
    getState: vi.fn(async () => ({ values })),
    invoke: vi.fn(async (_input: unknown, prepared: unknown) => prepared),
    async *stream(_input: unknown, prepared: unknown) { yield prepared; },
  };
  const resolve = createGraphEntryContextResolver(graph, { admit }, { admissionTimeoutMs });
  return { graph, admit, wrapped: instrumentGraphWithExecutionContext(graph, resolve) };
}

afterEach(() => vi.useRealTimers());

describe("trusted graph entry", () => {
  it("allocates an independent task before invoke and preserves cancellation", async () => {
    const { wrapped, admit } = setup();
    const signal = new AbortController().signal;
    const prepared = await wrapped.invoke({ messages: [] }, { ...config, signal });
    const context = readCanonicalExecutionContext(prepared);
    expect(context).toMatchObject({ threadId: "thread-1", principal: { principalId: "principal-1" } });
    expect(context?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context?.runId).not.toBe("run-1");
    expect(prepared).toHaveProperty("configurable.nativeRunId", "run-1");
    expect(readExecutionCorrelation(prepared).runId).toBe(context?.runId);
    expect(context?.taskId).toBeTruthy();
    expect(context?.taskId).not.toBe("run-1");
    expect(admit).toHaveBeenCalledOnce();
    expect(prepared).toHaveProperty("signal", signal);
  });

  it("ignores client canonical identity and task aliases", async () => {
    const { wrapped } = setup();
    const prepared = await wrapped.invoke({}, { ...config, taskId: "forged", configurable: {
      ...config.configurable, task_id: "forged", execution_context: { principal: "admin" },
    } });
    expect(readCanonicalExecutionContext(prepared)?.taskId).not.toBe("forged");
    expect(readCanonicalExecutionContext(prepared)?.principal.principalId).toBe("principal-1");
    const development = readDevelopmentExecutionContext(null, prepared);
    expect(development.taskId).toBe(readCanonicalExecutionContext(prepared)?.taskId);
    expect(development.principal.principalId).toBe("anonymous");
  });

  it("reuses checkpoint task only for resume and validates it through admission", async () => {
    const { wrapped, admit } = setup({ executionTaskId: "task-saved" });
    const prepared = await wrapped.invoke(new Command({ resume: "answer" }), config);
    expect(admit.mock.calls[0]?.[1]).toBe("task-saved");
    expect(readCanonicalExecutionContext(prepared)?.taskId).toBe("task-saved");
    expect(readCanonicalExecutionContext(prepared)?.runId).toBe("persisted-product-run");
    const next = await wrapped.invoke({ messages: [] }, config);
    expect(readCanonicalExecutionContext(next)?.taskId).not.toBe("task-saved");
  });

  it("rejects legacy resume without task binding rather than inventing one", async () => {
    const { wrapped, admit } = setup();
    await expect(wrapped.invoke(null, config)).rejects.toThrow();
    expect(admit).not.toHaveBeenCalled();
  });

  it("fails closed before invoke when identity or persistence is unavailable", async () => {
    const { wrapped, graph, admit } = setup();
    await expect(wrapped.invoke({}, { configurable: { run_id: "run-1" } })).rejects.toThrow();
    expect(admit).not.toHaveBeenCalled();
    admit.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(wrapped.invoke({}, config)).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED", message: "ADAPTER_OPERATION_FAILED" });
    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it("awaits admission on stream and isolates parallel task allocations", async () => {
    const { wrapped } = setup();
    const outputs = await Promise.all([1, 2].map(async (index) => {
      const chunks = [];
      for await (const chunk of wrapped.stream({}, { configurable: { ...config.configurable, run_id: `run-${index}` } })) chunks.push(chunk);
      return readCanonicalExecutionContext(chunks[0]);
    }));
    expect(outputs[0]?.taskId).not.toBe(outputs[1]?.taskId);
    expect(outputs[0]?.runId).not.toBe(outputs[1]?.runId);
    expect(outputs[0]?.runId).not.toBe("run-1");
    expect(outputs[1]?.runId).not.toBe("run-2");
  });

  it("does not invoke after cancellation during admission", async () => {
    const { wrapped, graph, admit } = setup();
    const controller = new AbortController();
    admit.mockImplementationOnce(async (context) => {
      controller.abort();
      return { taskId: context.taskId, runId: context.runId };
    });
    await expect(wrapped.invoke({}, { ...config, signal: controller.signal })).rejects.toThrow();
    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancel"] as const)("does not enter a node when admission remains pending until %s", async (mode) => {
    vi.useFakeTimers();
    const { wrapped, graph, admit } = setup({}, 10);
    admit.mockImplementationOnce(async () => new Promise<{ taskId: string; runId: string }>(() => {}));
    const controller = new AbortController();
    const pending = wrapped.invoke({}, { ...config, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: mode === "timeout" ? "ADAPTER_OPERATION_TIMEOUT" : "ADAPTER_OPERATION_CANCELLED" });
    for (let index = 0; index < 10 && admit.mock.calls.length === 0; index += 1) await Promise.resolve();
    expect(admit).toHaveBeenCalledOnce();
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(10);
    else controller.abort();
    await rejection;
    expect(graph.invoke).not.toHaveBeenCalled();
  });
});
