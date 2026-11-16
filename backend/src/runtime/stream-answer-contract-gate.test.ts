import { describe, expect, it } from "vitest";

import { parseRuntimeEventEnvelope } from "./event-envelope.js";
import { parseRuntimeEventPayload, RUNTIME_EVENT_PAYLOAD_SCHEMAS } from "./event-payloads.js";

const answer = { delta: "正文😀", messageId: "answer-1", outputKind: "answer_text", textOffset: 0 };

describe("stream-chat-answer-text Task 1.4 / 1.7 contract gate", () => {
  it("preserves legacy delta-only payloads without adding identity", () => {
    expect(parseRuntimeEventPayload("model.stream", { delta: "legacy" })).toEqual({ delta: "legacy" });
  });

  it("preserves complete answer identity through the consumer adapter", () => {
    expect(parseRuntimeEventPayload("model.stream", answer)).toEqual(answer);
  });

  it("retains independently optional fields and only normalizes messageId whitespace", () => {
    expect(parseRuntimeEventPayload("model.stream", { delta: "partial", messageId: "  answer-1  " }))
      .toEqual({ delta: "partial", messageId: "answer-1" });
  });

  it.each([
    ["empty messageId", { messageId: "" }],
    ["blank messageId", { messageId: "   " }],
    ["negative offset", { textOffset: -1 }],
    ["fractional offset", { textOffset: 0.5 }],
    ["unsafe offset", { textOffset: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown outputKind", { outputKind: "reasoning" }],
    ["unknown field", { unexpected: true }],
  ])("rejects %s", (_name, invalid) => {
    expect(RUNTIME_EVENT_PAYLOAD_SCHEMAS["model.stream"].safeParse({ ...answer, ...invalid }).success).toBe(false);
    expect(() => parseRuntimeEventPayload("model.stream", { ...answer, ...invalid })).toThrow();
  });

  it("preserves identity through kernel envelope parsing and JSON forwarding", () => {
    const envelope = {
      schemaVersion: "1.0.0", eventId: "answer-event-1", sequence: 1,
      type: "model.stream", emittedAt: "2026-11-09T00:00:00.000Z",
      context: { requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1", attempt: 1,
        principalId: "principal-1", tenantId: "tenant-1", scopeId: "tenant-1", scopeType: "tenant" },
      payload: answer,
    };
    const parsed = parseRuntimeEventEnvelope(envelope);
    const forwarded: unknown = JSON.parse(JSON.stringify(parsed));
    const received = parseRuntimeEventEnvelope(forwarded);
    expect(parseRuntimeEventPayload(received.type, received.payload)).toEqual(answer);
  });
});
