import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChatbotGraph, chatbotGraph } from "./chatbot.js";
import { AnswerStreamInterruptedError, AnswerStreamRefusedError } from "../platform/answer-text-sink.js";
import { ChatStreamTimeoutError } from "../platform/openai-chat-stream.js";
import type { ChatModelInvokeOptions } from "../platform/llm-gateway.js";
import { llmGateway } from "../platform/llm-gateway.js";
import { REGISTERED_GRAPH_IDS, instrumentGraphWithUsageAttribution } from "../platform/usage/attribution.js";
import {
  createAnswerStreamWiring,
  type AnswerStreamSettings,
} from "../runtime/answer-stream/answer-stream-wiring.js";
import { RunSequenceAllocator } from "../runtime/event-sequence.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";

const executionContext: ExecutionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  attempt: 1,
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

function harness(settings: AnswerStreamSettings) {
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const wiring = createAnswerStreamWiring({
    sequenceAllocator: new RunSequenceAllocator(),
    readSettings: () => settings,
    createMessageId: () => "msg-fixed",
    now: () => new Date("2026-11-15T00:00:00.000Z"),
    observer: { recordMetric: (name, payload) => void metrics.push({ name, payload }) },
  });
  const graph = instrumentGraphWithUsageAttribution(buildChatbotGraph(wiring), REGISTERED_GRAPH_IDS.chatbot);
  return { graph, metrics };
}

const enabled: AnswerStreamSettings = { enabled: true, envelopeEnabled: true };
const disabled: AnswerStreamSettings = { enabled: false, envelopeEnabled: true };

/** A model double that streams two fragments through the sink the node handed over. */
function streamingModel(text: [string, string]) {
  return vi.fn(async (_prompt: unknown, options?: ChatModelInvokeOptions) => {
    const writer = options?.answerTextSink?.beginAttempt({ provider: "qwen", attemptIndex: 0 });
    await writer?.append(text[0]);
    await writer?.append(text[1]);
    writer?.seal("completed");
    return new AIMessage(text.join(""));
  });
}

async function collect(stream: AsyncIterable<unknown>) {
  const custom: unknown[] = [];
  let lastValues: { messages?: unknown[] } | undefined;
  for await (const chunk of stream) {
    if (!Array.isArray(chunk)) continue;
    if (chunk[0] === "custom") custom.push(chunk[1]);
    if (chunk[0] === "values") lastValues = chunk[1];
  }
  return { custom, messages: lastValues?.messages ?? [] };
}

describe("chatbot shared context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends multi-turn input through the priority-based shared boundary", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage("ok"));
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    await harness(disabled).graph.invoke({
      messages: [
        new HumanMessage("old question"),
        new AIMessage("old answer"),
        new HumanMessage("current question"),
      ],
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining("## System policy"),
      { signal: expect.any(AbortSignal), attribution: { graphId: "chatbot" } }
    );
    expect(String(invoke.mock.calls[0]?.[0])).toContain("## Current task");
    expect(String(invoke.mock.calls[0]?.[0])).toContain("## Recent user message");
  });

  it("does not call the model when P0 cannot fit", async () => {
    vi.stubEnv("AGENT_CONTEXT_BUDGET_TOTAL", "1");
    const invoke = vi.fn();
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    const result = await harness(disabled).graph.invoke({
      messages: [new HumanMessage("current question")],
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(String(result.messages.at(-1)?.content)).toContain("context_p0_overflow");
  });
});

describe("chatbot answer streaming wiring (Task 4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes versioned model.stream envelopes before returning and reuses the message id", async () => {
    const invoke = streamingModel(["你好", "，世界"]);
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });
    const { graph, metrics } = harness(enabled);

    const { custom, messages } = await collect(
      await graph.stream(
        { messages: [new HumanMessage("hi")] },
        { streamMode: ["custom", "values"], configurable: { execution_context: executionContext } },
      ),
    );

    expect(custom).toEqual([
      expect.objectContaining({
        type: "model.stream",
        sequence: 1,
        context: expect.objectContaining({ runId: "run-1", threadId: "thread-1", requestId: "request-1", attempt: 1 }),
        payload: { delta: "你好", messageId: "msg-fixed", outputKind: "answer_text", textOffset: 0 },
      }),
      expect.objectContaining({
        type: "model.stream",
        sequence: 2,
        payload: { delta: "，世界", messageId: "msg-fixed", outputKind: "answer_text", textOffset: 2 },
      }),
    ]);
    const final = messages.at(-1);
    expect(final).toBeInstanceOf(AIMessage);
    expect(final).toMatchObject({ id: "msg-fixed", content: "你好，世界" });
    // The id must survive serialization, which is what the thread state and the browser receive.
    const serialized: unknown = JSON.parse(JSON.stringify(final));
    expect(serialized).toMatchObject({ kwargs: { id: "msg-fixed", content: "你好，世界" } });
    expect(metrics.map((metric) => metric.name)).not.toContain("answer.stream.degraded");
  });

  // `writer_missing` cannot occur inside a LangGraph run (the runtime always supplies a writer);
  // it is covered at the wiring level in answer-stream-wiring.test.ts.
  it.each<[string, AnswerStreamSettings, Record<string, unknown>]>([
    ["feature_disabled", disabled, { execution_context: executionContext }],
    ["envelope_disabled", { enabled: true, envelopeEnabled: false }, { execution_context: executionContext }],
    ["execution_context_missing", enabled, {}],
  ])("keeps the whole reply and records %s", async (reason, settings, configurable) => {
    const invoke = vi.fn(async (_prompt: unknown, _options?: ChatModelInvokeOptions) => new AIMessage("whole"));
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });
    const { graph, metrics } = harness(settings);

    const result = (await collect(
      await graph.stream({ messages: [new HumanMessage("hi")] }, { streamMode: ["custom", "values"], configurable }),
    )).messages;

    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty("answerTextSink");
    expect(result.at(-1)).toMatchObject({ content: "whole" });
    expect(result.at(-1)).not.toMatchObject({ id: "msg-fixed" });
    expect(metrics).toContainEqual({ name: "answer.stream.degraded", payload: { reason } });
  });

  it.each([
    [
      "interruption",
      () => new AnswerStreamInterruptedError(new ChatStreamTimeoutError("answer_stream_idle_timeout"), "provider_retry"),
      { code: "answer_stream_interrupted", cause: { code: "answer_stream_idle_timeout" } },
    ],
    ["refusal", () => new AnswerStreamRefusedError(), { code: "answer_stream_refused" }],
  ])("turns a %s after published text into a coded run error without committing the partial answer", async (_label, makeError, expected) => {
    const invoke = vi.fn(async (_prompt: unknown, options?: ChatModelInvokeOptions) => {
      const writer = options?.answerTextSink?.beginAttempt({ provider: "qwen", attemptIndex: 0 });
      await writer?.append("partial");
      throw makeError();
    });
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    const failure = await collect(
      await harness(enabled).graph.stream(
        { messages: [new HumanMessage("hi")] },
        { streamMode: ["custom", "values"], configurable: { execution_context: executionContext } },
      ),
    ).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ name: "AnswerStreamRunError" });
    const envelope: unknown = JSON.parse((failure as Error).message);
    expect(envelope).toEqual({ error: { source: "backend", stage: "chat_response", message: expected.code, ...expected } });
    expect((failure as Error).message).not.toContain("partial");
  });

  it("production graph refuses a run without a trusted execution context before calling the model", async () => {
    const invoke = vi.fn();
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    await expect(chatbotGraph.invoke({ messages: [new HumanMessage("hi")] })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
