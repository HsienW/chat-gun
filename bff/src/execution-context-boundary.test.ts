import { describe, expect, it } from "vitest";
import { containsUntrustedExecutionContext } from "./execution-context-boundary.js";

describe("public execution context boundary", () => {
  const metadata = {
    requestId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    inputKind: "prompt",
    activeRunHint: { runId: "previous-run", generation: 1 },
  };

  it.each(["prompt", "clarification_resume", "cancel", "command"])("preserves client correlation for %s without promoting it to authority", (inputKind) => {
    const payload = { config: { configurable: { clientInteractionMetadata: { ...metadata, inputKind } } } };
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify(payload)))).toBe(false);
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify([payload])))).toBe(false);
  });

  it.each([
    { ...metadata, execution_context: { taskId: "forged" } },
    { ...metadata, task_id: "forged" },
    { ...metadata, "x-bff-principal-id": "admin" },
    { ...metadata, requestId: { execution_context: {} } },
    { ...metadata, activeRunHint: { runId: { taskId: "forged" }, generation: 1 } },
    { ...metadata, activeRunHint: { ...metadata.activeRunHint, taskId: "forged" } },
    { ...metadata, nested: { requestId: "forged" } },
    { ...metadata, runId: "forged" },
  ])("still rejects authority hidden inside client metadata: %j", (clientInteractionMetadata) => {
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify({
      config: { configurable: { clientInteractionMetadata } },
    })))).toBe(true);
  });

  it.each([
    { config: { configurable: { requestId: metadata.requestId } } },
    { metadata: { clientInteractionMetadata: metadata } },
    { config: { nested: { configurable: { clientInteractionMetadata: metadata } } } },
    { config: { configurable: { clientInteractionMetadata: [metadata] } } },
  ])("does not allow correlation aliases outside the canonical client metadata path: %j", (payload) => {
    expect(containsUntrustedExecutionContext(Buffer.from(JSON.stringify(payload)))).toBe(true);
  });

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
