import { describe, expect, it } from "vitest";
import { containsUntrustedExecutionContext } from "./execution-context-boundary.js";

describe("public execution context boundary", () => {
  it.each([
    { config: { configurable: { execution_context: { taskId: "forged" } } } },
    { config: { configurable: { "x-bff-principal-id": "admin" } } },
    { config: { configurable: { task_id: "forged" } } },
    { config: { configurable: { thread_id: "other-thread" } } },
    { metadata: { execution_context: {} } },
    { input: { executionTaskId: "forged" } },
    { values: { executionTaskId: "forged" } },
    [{ config: { configurable: { taskId: "forged" } } }],
  ])("rejects authority supplied in public JSON: %j", (payload) => {
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify(payload)))).toBe(true);
  });

  it("preserves ordinary model config, native run input and user text", () => {
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify({
      input: { messages: [{ role: "human", content: "Explain execution_context and taskId" }] },
      config: { configurable: { model: "test-model", clientInteractionMetadata: { inputKind: "prompt" } } },
    })))).toBe(false);
    expect(containsUntrustedExecutionContext(undefined)).toBe(false);
  });
});
