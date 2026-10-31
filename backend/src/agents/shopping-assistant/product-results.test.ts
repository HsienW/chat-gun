import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { readKbSearchOutcome } from "./product-results.js";

function envelopeWith(result: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    kind: "tool_result",
    correlation: { requestId: "request-1", threadId: "thread-1", runId: "run-1", toolCallId: "call-1" },
    tool: { name: "kb_search", version: "1", riskTier: "read", readOnly: true },
    outcome: { type: "succeeded", result },
    terminationCause: "completed",
    emittedAt: "2026-10-31T00:00:00.000Z",
  });
}

describe("readKbSearchOutcome", () => {
  it("reads a typed egress failure that carries a reason", () => {
    const content = envelopeWith(JSON.stringify({
      schemaVersion: "kb_search_result@1",
      outcome: "error",
      errorCode: "EGRESS_POLICY_UNAVAILABLE",
      retryable: false,
      egressReasonCode: "DNS_RESOLUTION_FAILED",
    }));

    expect(readKbSearchOutcome([new ToolMessage({ content, tool_call_id: "call-1" })], "call-1")).toEqual({
      kind: "failed",
      errorCode: "EGRESS_POLICY_UNAVAILABLE",
      egressReasonCode: "DNS_RESOLUTION_FAILED",
    });
  });

  it("keeps the errorCode and marks a reason outside the known set as UNKNOWN", () => {
    const content = envelopeWith(JSON.stringify({
      schemaVersion: "kb_search_result@1",
      outcome: "error",
      errorCode: "EGRESS_DENIED",
      retryable: false,
      egressReasonCode: "FUTURE_REASON",
    }));

    expect(readKbSearchOutcome([new ToolMessage({ content, tool_call_id: "call-1" })], "call-1")).toEqual({
      kind: "failed",
      errorCode: "EGRESS_DENIED",
      egressReasonCode: "UNKNOWN",
    });
  });

  it("still rejects unknown fields on a failure result", () => {
    const content = envelopeWith(JSON.stringify({
      schemaVersion: "kb_search_result@1",
      outcome: "error",
      errorCode: "EGRESS_DENIED",
      retryable: false,
      unexpected: true,
    }));

    expect(readKbSearchOutcome([new ToolMessage({ content, tool_call_id: "call-1" })], "call-1")).toEqual({
      kind: "failed",
      errorCode: "KB_SEARCH_RESULT_INVALID",
    });
  });
});
