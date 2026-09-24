import { describe, expect, it } from "vitest";

import { createToolCallDecodeTelemetryPayloads } from "./llm-gateway.js";

describe("Tool call decode telemetry architecture", () => {
  it("projects diagnostics onto an explicit safe-field allowlist", () => {
    const rawArgument = "private.person@example.test";
    const rawProviderBody = '{"secret":"provider-body"}';
    const payloads = createToolCallDecodeTelemetryPayloads({
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      finishReason: "length",
      invokeOptions: {
        runId: "run-1",
        taskId: "task-1",
        stepId: "step-1",
        toolCallId: "tool-call-1",
      },
      diagnostics: [{
        index: 0,
        reason: "arguments_decode_failed",
        decodeKind: "incomplete",
        errorCode: "JSON_DECODE_INCOMPLETE",
        byteLength: 64,
        rawHash: "sha256-redacted",
        rawArgument,
        rawProviderBody,
      } as never],
    });

    expect(payloads).toEqual([{
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      finishReason: "length",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      toolCallId: "tool-call-1",
      byteLength: 64,
      rawHash: "sha256-redacted",
      errorCode: "JSON_DECODE_INCOMPLETE",
    }]);

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain(rawArgument);
    expect(serialized).not.toContain(rawProviderBody);
    expect(serialized).not.toContain("secret");
  });

  it("uses a stable safe error code when the Tool name is missing", () => {
    expect(createToolCallDecodeTelemetryPayloads({
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      diagnostics: [{ index: 0, reason: "missing_name" }],
    })).toEqual([{
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      errorCode: "TOOL_CALL_NAME_MISSING",
    }]);
  });
});
