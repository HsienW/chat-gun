import { describe, expect, it } from "vitest";
import { createToolCallContext } from "./tool-call-context.js";
import { readCanonicalExecutionContext, readExecutionContext, withExecutionContext } from "./read-execution-context.js";

const parent = readExecutionContext(null, { configurable: {
  request_id: "request-1", thread_id: "thread-1", run_id: "run-1", task_id: "task-1",
} }, "development");

describe("canonical tool child context", () => {
  it("preserves authority and signal, with stable logical call identity on replay", () => {
    const signal = new AbortController().signal;
    const config = withExecutionContext({ signal }, parent);
    const first = createToolCallContext(config, "search_web", "web_search", { query: "news" });
    const replay = createToolCallContext(withExecutionContext({}, { ...parent, runId: "resume-run" }), "search_web", "web_search", { query: "news" });
    expect(replay.toolCallId).toBe(first.toolCallId);
    expect(readCanonicalExecutionContext(first.config)).toMatchObject({
      taskId: parent.taskId, principal: parent.principal, scope: parent.scope,
      toolCallId: first.toolCallId, stepId: expect.stringMatching(/^step-/),
    });
    expect(first.config.signal).toBe(signal);
    expect(parent).not.toHaveProperty("toolCallId");
    const next = createToolCallContext(config, "search_web", "web_search", { query: "other news" });
    expect(next.toolCallId).not.toBe(first.toolCallId);
    const otherTask = createToolCallContext(withExecutionContext({}, { ...parent, taskId: "task-2" }), "search_web", "web_search", { query: "news" });
    expect(otherTask.toolCallId).not.toBe(first.toolCallId);
  });

  it("preserves UUID shape for bounded legacy callers without canonical context", () => {
    const { toolCallId, config } = createToolCallContext(undefined, "search_web", "web_search", {});
    expect(toolCallId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(readCanonicalExecutionContext(config)).toBeUndefined();
    expect(config.configurable?.step_id).toBe("search_web");
    const legacy = createToolCallContext({ configurable: { step_id: "legacy-step" } }, "search_web", "web_search", {});
    expect(legacy.config.configurable?.step_id).toBe("legacy-step");
  });
});
