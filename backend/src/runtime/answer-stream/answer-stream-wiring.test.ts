import { describe, expect, it, vi } from "vitest";

import {
  ANSWER_STREAM_REQUIRED_GRAPHS,
  createAnswerStreamWiring,
  evaluateAnswerStreamReadiness,
} from "./answer-stream-wiring.js";
import { RunSequenceAllocator } from "../event-sequence.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";

const executionContext: ExecutionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  attempt: 2,
  principal: {
    principalId: "principal-1",
    principalType: "user",
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "trusted_gateway",
    authenticatedAt: "2026-09-27T00:00:00.000Z",
  },
  scope: { scopeId: "tenant-1", scopeType: "tenant", tenantId: "tenant-1" },
};

describe("createAnswerStreamWiring", () => {
  it("publishes through the injected allocator with the trusted context and run attempt", async () => {
    const allocator = new RunSequenceAllocator();
    allocator.next("run-1"); // another event of the same run already took sequence 1
    const writer = vi.fn();
    const wiring = createAnswerStreamWiring({
      sequenceAllocator: allocator,
      readSettings: () => ({ enabled: true, envelopeEnabled: true }),
      createMessageId: () => "msg-1",
      observer: { recordMetric: () => undefined },
    });

    const prepared = await wiring.prepare({ writer, configurable: { execution_context: executionContext } });
    expect(prepared.kind).toBe("stream");
    if (prepared.kind !== "stream") return;
    const attempt = prepared.sink.beginAttempt({ provider: "qwen", attemptIndex: 3 });
    await attempt.append("a");

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "model.stream",
        sequence: 2,
        context: expect.objectContaining({ runId: "run-1", attempt: 2 }),
        payload: { delta: "a", messageId: "msg-1", outputKind: "answer_text", textOffset: 0 },
      }),
    );
  });

  it("does not mark the answer published when the custom writer throws", async () => {
    const wiring = createAnswerStreamWiring({
      sequenceAllocator: new RunSequenceAllocator(),
      readSettings: () => ({ enabled: true, envelopeEnabled: true }),
      observer: { recordMetric: () => undefined },
    });
    const prepared = await wiring.prepare({
      writer: () => {
        throw new Error("writer closed");
      },
      configurable: { execution_context: executionContext },
    });
    if (prepared.kind !== "stream") throw new Error("expected stream");
    const attempt = prepared.sink.beginAttempt({ provider: "qwen", attemptIndex: 0 });

    await expect(attempt.append("a")).rejects.toThrow("writer closed");
    expect(prepared.sink.hasPublished).toBe(false);
  });

  it("records writer_missing when the config carries no custom writer", async () => {
    const metrics: unknown[] = [];
    const wiring = createAnswerStreamWiring({
      sequenceAllocator: new RunSequenceAllocator(),
      readSettings: () => ({ enabled: true, envelopeEnabled: true }),
      observer: { recordMetric: (name, payload) => void metrics.push({ name, payload }) },
    });

    await expect(wiring.prepare({ configurable: { execution_context: executionContext } })).resolves.toEqual({
      kind: "whole",
      reason: "writer_missing",
    });
    expect(metrics).toEqual([{ name: "answer.stream.degraded", payload: { reason: "writer_missing" } }]);
  });

  it("treats an invalid execution context as missing wiring", async () => {
    const metrics: unknown[] = [];
    const wiring = createAnswerStreamWiring({
      sequenceAllocator: new RunSequenceAllocator(),
      readSettings: () => ({ enabled: true, envelopeEnabled: true }),
      observer: { recordMetric: (name, payload) => void metrics.push({ name, payload }) },
    });

    await expect(
      wiring.prepare({ writer: vi.fn(), configurable: { execution_context: { runId: "" } } }),
    ).resolves.toEqual({ kind: "whole", reason: "execution_context_missing" });
    expect(metrics).toEqual([{ name: "answer.stream.degraded", payload: { reason: "execution_context_missing" } }]);
  });
});

describe("evaluateAnswerStreamReadiness", () => {
  const wired = new Set<string>(ANSWER_STREAM_REQUIRED_GRAPHS);

  it("is ready while the feature is disabled, whatever the wiring", () => {
    expect(evaluateAnswerStreamReadiness({ enabled: false, envelopeEnabled: false }, new Set())).toEqual({ ready: true, reasonCodes: [] });
  });

  it("is ready when enabled with envelopes and the chatbot wiring registered", () => {
    expect(evaluateAnswerStreamReadiness({ enabled: true, envelopeEnabled: true }, wired)).toEqual({ ready: true, reasonCodes: [] });
  });

  it("fails when enabled but the envelope or the wiring is missing", () => {
    expect(evaluateAnswerStreamReadiness({ enabled: true, envelopeEnabled: false }, new Set())).toEqual({
      ready: false,
      reasonCodes: ["answer_stream_envelope_disabled", "answer_stream_wiring_missing"],
    });
  });
});
