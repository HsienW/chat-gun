import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnswerTextSink } from "./answer-text-sink.js";
import type { ProviderUsage } from "./usage/price-table.js";

const encoder = new TextEncoder();

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content: string): string {
  return frame({ id: "chatcmpl-1", model: "qwen-provider-model", choices: [{ index: 0, delta: { content } }] });
}

const finish = (reason = "stop") => frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageFrame = frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });

function sseResponse(chunks: string[], options: { stallAfter?: boolean } = {}): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (options.stallAfter) return new Promise<void>(() => undefined);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function jsonResponse(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type Harness = {
  usage: ProviderUsage[];
  metrics: Array<{ name: string; payload: Record<string, unknown> }>;
  fragments: Array<{ delta: string; textOffset: number }>;
  fetchMock: ReturnType<typeof vi.fn>;
};

async function loadGateway(
  responses: Array<Response | ((init?: RequestInit) => Promise<Response>)>,
  env: Record<string, string> = {},
) {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("QWEN_BASE_URL", "http://qwen.internal/v1");
  vi.stubEnv("LLM_FALLBACK_ENABLED", "false");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();

  const harness: Harness = { usage: [], metrics: [], fragments: [], fetchMock: vi.fn() };
  vi.doMock("./usage/runtime.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./usage/runtime.js")>();
    return { ...actual, recordProviderUsage: (usage: ProviderUsage) => void harness.usage.push(usage) };
  });
  vi.doMock("./observability.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./observability.js")>();
    return {
      ...actual,
      recordMetric: async (name: string, payload: Record<string, unknown>) => void harness.metrics.push({ name, payload }),
    };
  });

  let call = 0;
  harness.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const next = responses[call++];
    if (!next) throw new Error("unexpected extra request");
    return typeof next === "function" ? next(init) : next;
  });
  vi.stubGlobal("fetch", harness.fetchMock);

  const gateway = await import("./llm-gateway.js");
  const sink = createAnswerTextSink({
    messageId: "msg-1",
    publish: ({ delta: text, textOffset }) => void harness.fragments.push({ delta: text, textOffset }),
    observer: { recordMetric: (name, payload) => void harness.metrics.push({ name, payload }) },
  });
  return { ...gateway, harness, sink };
}

function requestBody(harness: Harness, index = 0): Record<string, unknown> {
  const init = harness.fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe("OpenAI-compatible answer streaming", () => {
  afterEach(() => {
    vi.doUnmock("./usage/runtime.js");
    vi.doUnmock("./observability.js");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("streams visible text to the sink, returns the same text once, and meters the attempt once", async () => {
    const { llmGateway, harness, sink } = await loadGateway([
      sseResponse([delta("你好"), delta("，世界"), finish(), usageFrame, "data: [DONE]\n\n"]),
    ]);

    const message = await llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink });

    expect(harness.fragments).toEqual([
      { delta: "你好", textOffset: 0 },
      { delta: "，世界", textOffset: 2 },
    ]);
    expect(message.content).toBe("你好，世界");
    expect(message.response_metadata).toMatchObject({ answer_streamed: true, finish_reason: "stop", provider_model: "qwen-provider-model" });
    expect(message).toMatchObject({ usage_metadata: { input_tokens: 10, output_tokens: 4 } });
    expect(requestBody(harness)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(harness.usage).toHaveLength(1);
    expect(harness.usage[0]).toMatchObject({ provider: "qwen", inputTokens: 10, outputTokens: 4 });
    expect(harness.usage[0]).not.toHaveProperty("usageMissingReason");
    expect(harness.metrics.map((metric) => metric.name)).not.toContain("answer.stream.degraded");
  });

  const answerProjection = { kind: "json_string_field", field: "answer" } as const;
  const jsonFormat = { type: "json_object" } as const;

  it("projects only the answer and reuses the raw JSON for the final message and usage", async () => {
    const pieces = ['{"abstained":false,"reason":"hidden","answer":"你好\\uD83D', '\\uDE00！"}'];
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([...pieces.map(delta), finish(), usageFrame])]);
    const message = await llmGateway.createChatModel({ responseFormat: jsonFormat, maxRetries: 0 }).invoke("hi", {
      answerTextSink: sink, answerTextProjection: answerProjection,
    });
    expect(harness.fragments).toEqual([{ delta: "你好", textOffset: 0 }, { delta: "😀！", textOffset: 2 }]);
    expect(message.content).toBe(pieces.join(""));
    expect(requestBody(harness)).toMatchObject({ stream: true, response_format: jsonFormat });
    expect(harness.usage).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 4 })]);
  });

  it("rejects sink plus projection without json_object before making any request", async () => {
    const { llmGateway, harness, sink } = await loadGateway([]);
    for (const responseFormat of [undefined, { type: "json_schema" } as unknown as typeof jsonFormat]) {
      await expect(llmGateway.createChatModel({ responseFormat }).invoke("hi", {
        answerTextSink: sink, answerTextProjection: answerProjection,
      })).rejects.toMatchObject({ code: "answer_sink_incompatible_call" });
    }
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("ignores projection when no sink was supplied", async () => {
    const { llmGateway, harness } = await loadGateway([jsonResponse('{"answer":"whole"}')]);
    const message = await llmGateway.createChatModel({ responseFormat: jsonFormat, maxRetries: 0 }).invoke("hi", { answerTextProjection: answerProjection });
    expect(message.content).toBe('{"answer":"whole"}');
    expect(requestBody(harness)).not.toHaveProperty("stream");
    expect(harness.fragments).toEqual([]);
  });

  it("degrades before requesting a structured stream from an undeclared adapter", async () => {
    const { llmGateway, harness, sink } = await loadGateway([jsonResponse('{"answer":"whole"}')], {
      LLM_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_BASE_URL: "http://other.internal/v1",
    });
    const message = await llmGateway.createChatModel({ responseFormat: jsonFormat, maxRetries: 0 }).invoke("hi", {
      answerTextSink: sink, answerTextProjection: answerProjection,
    });
    expect(message.content).toBe('{"answer":"whole"}');
    expect(requestBody(harness)).not.toHaveProperty("stream");
    expect(harness.fragments).toEqual([]);
    expect(harness.metrics).toContainEqual({ name: "answer.stream.degraded", payload: { reason: "capability_unsupported", messageId: "msg-1", provider: "openai-compatible" } });
  });

  it("stops projection once on malformed JSON but returns it for domain validation", async () => {
    const pieces = ['{"answer":"partial', '\\xhidden"', '}'];
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([...pieces.map(delta), finish(), usageFrame])]);
    const message = await llmGateway.createChatModel({ responseFormat: jsonFormat, maxRetries: 0 }).invoke("hi", {
      answerTextSink: sink, answerTextProjection: answerProjection,
    });
    expect(harness.fragments).toEqual([{ delta: "partial", textOffset: 0 }]);
    expect(message.content).toBe(pieces.join(""));
    expect(harness.metrics.filter(({ name }) => name === "answer.stream.projection_stopped")).toHaveLength(1);
  });

  it("does not retry if a projected answer was already published", async () => {
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([delta('{"answer":"partial')])]);
    await expect(llmGateway.createChatModel({ responseFormat: jsonFormat, maxRetries: 2 }).invoke("hi", {
      answerTextSink: sink, answerTextProjection: answerProjection,
    })).rejects.toMatchObject({ code: "answer_stream_interrupted" });
    expect(harness.fragments).toEqual([{ delta: "partial", textOffset: 0 }]);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records usage_frame_missing when the stream completes without a usage frame", async () => {
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([delta("ok"), finish(), "data: [DONE]\n\n"])]);

    await llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink });

    expect(harness.usage).toEqual([
      expect.objectContaining({ inputTokens: null, outputTokens: null, usageMissingReason: "usage_frame_missing" }),
    ]);
  });

  it("interrupts without retry when the stream stalls after published text, metering stream_aborted", async () => {
    const { llmGateway, harness, sink } = await loadGateway(
      [sseResponse([delta("partial")], { stallAfter: true })],
      { LLM_STREAM_IDLE_TIMEOUT_MS: "3000", LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS: "5000" },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = llmGateway.createChatModel({ maxRetries: 2 }).invoke("hi", { answerTextSink: sink });
      const settled = pending.then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(3_001);
      const error = await settled;

      expect(error).toMatchObject({ code: "answer_stream_interrupted", stage: "provider_retry" });
      expect((error as Error).cause).toMatchObject({ code: "answer_stream_idle_timeout" });
    } finally {
      vi.useRealTimers();
    }
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.fragments.map((fragment) => fragment.delta)).toEqual(["partial"]);
    expect(harness.usage).toEqual([expect.objectContaining({ inputTokens: null, usageMissingReason: "stream_aborted" })]);
  });

  it("retries a first-chunk timeout before anything was published", async () => {
    const { llmGateway, harness, sink } = await loadGateway(
      [sseResponse([], { stallAfter: true }), sseResponse([delta("second"), finish(), usageFrame])],
      { LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS: "2000" },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = llmGateway.createChatModel({ maxRetries: 1 }).invoke("hi", { answerTextSink: sink });
      await vi.advanceTimersByTimeAsync(2_001);
      const message = await pending;
      expect(message.content).toBe("second");
    } finally {
      vi.useRealTimers();
    }
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.usage).toEqual([
      expect.objectContaining({ inputTokens: null, usageMissingReason: "stream_aborted" }),
      expect.objectContaining({ inputTokens: 10, outputTokens: 4 }),
    ]);
  });

  it("throws answer_stream_refused for a content filter after published text and never retries", async () => {
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([delta("draft"), finish("content_filter")])]);

    await expect(
      llmGateway.createChatModel({ maxRetries: 2 }).invoke("hi", { answerTextSink: sink }),
    ).rejects.toMatchObject({ code: "answer_stream_refused" });
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not wrap a refusal behind the fallback layer", async () => {
    const { llmGateway, harness, sink } = await loadGateway(
      [sseResponse([delta("draft"), finish("content_filter")])],
      { LLM_FALLBACK_ENABLED: "true", LLM_FALLBACK_PROVIDERS: "openai-compatible", OPENAI_COMPATIBLE_BASE_URL: "http://other.internal/v1" },
    );

    await expect(
      llmGateway.createChatModelWithFallback({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink }),
    ).rejects.toMatchObject({ code: "answer_stream_refused" });
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivers a legal whole JSON reply without publishing and records the degradation", async () => {
    const { llmGateway, harness, sink } = await loadGateway([jsonResponse("whole reply")]);

    const message = await llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink });

    expect(message.content).toBe("whole reply");
    expect(message.response_metadata).toMatchObject({ answer_streamed: false });
    expect(harness.fragments).toEqual([]);
    expect(sink.hasPublished).toBe(false);
    expect(harness.metrics).toContainEqual({
      name: "answer.stream.degraded",
      payload: { reason: "capability_unsupported", messageId: "msg-1", provider: "qwen" },
    });
    expect(harness.usage).toEqual([expect.objectContaining({ inputTokens: 3, outputTokens: 2 })]);
  });

  it("reports an unexpected media type as a protocol error", async () => {
    const { llmGateway, sink } = await loadGateway([
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);

    await expect(
      llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink }),
    ).rejects.toMatchObject({ name: "ChatStreamProtocolError", code: "answer_stream_unexpected_media_type" });
  });

  it("propagates caller cancellation to the reader and meters the aborted attempt", async () => {
    const controller = new AbortController();
    const { llmGateway, harness, sink } = await loadGateway([sseResponse([delta("a")], { stallAfter: true })]);

    const pending = llmGateway
      .createChatModel({ maxRetries: 2 })
      .invoke("hi", { answerTextSink: sink, signal: controller.signal });
    await vi.waitFor(() => expect(harness.fragments).toHaveLength(1));
    controller.abort(new Error("user cancelled"));

    await expect(pending).rejects.toThrow("user cancelled");
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.usage).toEqual([expect.objectContaining({ usageMissingReason: "stream_aborted" })]);
  });

  it("degrades before the request on a provider without declared streaming support", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://other.internal/v1");
    const { llmGateway, harness, sink } = await loadGateway([jsonResponse("whole")], { LLM_PROVIDER: "openai-compatible" });

    const message = await llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi", { answerTextSink: sink });

    expect(message.content).toBe("whole");
    expect(requestBody(harness)).not.toHaveProperty("stream");
    expect(harness.metrics).toContainEqual(
      expect.objectContaining({ name: "answer.stream.degraded", payload: expect.objectContaining({ reason: "capability_unsupported" }) }),
    );
  });

  it("keeps callers without a sink on the whole-reply request", async () => {
    const { llmGateway, harness } = await loadGateway([jsonResponse("plain")]);

    const message = await llmGateway.createChatModel({ maxRetries: 0 }).invoke("hi");

    expect(message.content).toBe("plain");
    expect(requestBody(harness)).not.toHaveProperty("stream");
    expect(requestBody(harness)).not.toHaveProperty("stream_options");
    expect(harness.usage[0]).not.toHaveProperty("usageMissingReason");
  });
});
