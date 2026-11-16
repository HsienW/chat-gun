import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AnswerStreamInterruptedError,
  AnswerTextSinkConfigurationError,
  createAnswerTextSink,
  isRetryBlockedByPublishedAnswer,
  toAnswerStreamInterruptedError,
  type AnswerStreamAttempt,
  type AnswerTextSink,
} from "./answer-text-sink.js";
import {
  FallbackChatModelInvoker,
  type FallbackObservability,
  type ModelFallbackPolicy,
} from "./llm-fallback.js";
import type { ChatModelInvoker } from "./llm-gateway.js";
import { classifyProviderError, isFallbackEligibleCategory } from "./provider-error-category.js";

/** Test sink whose published flag is controlled by the test, recording every attempt lifecycle. */
function controlledSink() {
  const attempts: Array<AnswerStreamAttempt & { outcome?: "completed" | "abandoned" }> = [];
  const state = { published: false };
  const sink: AnswerTextSink = {
    messageId: "msg-1",
    get hasPublished() {
      return state.published;
    },
    beginAttempt(attempt) {
      const record: (typeof attempts)[number] = { ...attempt };
      attempts.push(record);
      return {
        append: async () => {
          state.published = true;
        },
        seal: (outcome) => {
          record.outcome = outcome;
        },
      };
    },
  };
  return { sink, state, attempts };
}

const fallbackPolicy: ModelFallbackPolicy = {
  primaryProvider: "ccr",
  fallbackProviders: ["qwen"],
  maxTotalAttempts: 2,
  repairStrategy: "retry_once",
  perProviderTimeoutMs: 30_000,
};

const silentObserver: FallbackObservability = {
  recordMetric: async () => undefined,
  recordAudit: async () => undefined,
};

function stubQwenEnv() {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("QWEN_BASE_URL", "http://qwen.internal/v1");
  vi.stubEnv("LLM_FALLBACK_ENABLED", "false");
}

function okCompletion(content = "hello") {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createAnswerTextSink", () => {
  it("publishes fragments with UTF-16 offsets and flips hasPublished only after the first accepted append", async () => {
    const published: Array<{ messageId: string; delta: string; textOffset: number }> = [];
    const sink = createAnswerTextSink({
      messageId: "msg-1",
      publish: (fragment) => {
        published.push(fragment);
      },
      observer: { recordMetric: () => undefined },
    });
    expect(sink.hasPublished).toBe(false);

    const writer = sink.beginAttempt({ provider: "qwen", attemptIndex: 0 });
    await writer.append("");
    expect(sink.hasPublished).toBe(false);
    await writer.append("你好");
    await writer.append("😀!");
    writer.seal("completed");

    expect(sink.hasPublished).toBe(true);
    expect(published).toEqual([
      { messageId: "msg-1", delta: "你好", textOffset: 0 },
      { messageId: "msg-1", delta: "😀!", textOffset: 2 },
    ]);
  });

  it("drops appends after seal and records answer.stream.late_delta_dropped", async () => {
    const publish = vi.fn();
    const metrics: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const sink = createAnswerTextSink({
      messageId: "msg-1",
      publish,
      observer: { recordMetric: (name, payload) => void metrics.push({ name, payload }) },
    });
    const writer = sink.beginAttempt({ provider: "qwen", attemptIndex: 1 });
    writer.seal("abandoned");
    await writer.append("late");

    expect(publish).not.toHaveBeenCalled();
    expect(sink.hasPublished).toBe(false);
    expect(metrics).toEqual([
      {
        name: "answer.stream.late_delta_dropped",
        payload: { messageId: "msg-1", provider: "qwen", attemptIndex: 1 },
      },
    ]);
  });

  it("keeps hasPublished false and the offset unchanged when the publisher rejects", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("writer failed")).mockResolvedValue(undefined);
    const sink = createAnswerTextSink({ messageId: "msg-1", publish, observer: { recordMetric: () => undefined } });
    const writer = sink.beginAttempt({ provider: "qwen", attemptIndex: 0 });

    await expect(writer.append("a")).rejects.toThrow("writer failed");
    expect(sink.hasPublished).toBe(false);
    await writer.append("b");
    expect(publish).toHaveBeenLastCalledWith({ messageId: "msg-1", delta: "b", textOffset: 0 });
  });

  it("ignores observability failures when dropping late deltas", async () => {
    const sink = createAnswerTextSink({
      messageId: "msg-1",
      publish: vi.fn(),
      observer: {
        recordMetric: () => {
          throw new Error("metrics down");
        },
      },
    });
    const writer = sink.beginAttempt({ provider: "qwen", attemptIndex: 0 });
    writer.seal("abandoned");
    await expect(writer.append("late")).resolves.toBeUndefined();
  });

  it("rejects a missing messageId with a classifiable configuration error", () => {
    expect(() => createAnswerTextSink({ messageId: "", publish: vi.fn() })).toThrow(
      expect.objectContaining({ code: "answer_sink_message_id_missing" }),
    );
  });
});

describe("answer stream interruption classification", () => {
  it("blocks retries only after an answer was published", () => {
    const { sink, state } = controlledSink();
    expect(isRetryBlockedByPublishedAnswer(undefined)).toBe(false);
    expect(isRetryBlockedByPublishedAnswer({})).toBe(false);
    expect(isRetryBlockedByPublishedAnswer({ answerTextSink: sink })).toBe(false);
    state.published = true;
    expect(isRetryBlockedByPublishedAnswer({ answerTextSink: sink })).toBe(true);
  });

  it("wraps once, keeps the cause and the first failing stage", () => {
    const cause = new Error("boom");
    const first = toAnswerStreamInterruptedError(cause, "provider_retry");
    const again = toAnswerStreamInterruptedError(first, "provider_fallback");

    expect(again).toBe(first);
    expect(first).toMatchObject({ code: "answer_stream_interrupted", stage: "provider_retry", cause });
  });

  it("classifies interruption as answer_stream_interrupted and never fallback-eligible", () => {
    const error = new AnswerStreamInterruptedError(
      Object.assign(new Error("upstream"), { statusCode: 503 }),
      "provider_retry",
    );
    const category = classifyProviderError(error);
    expect(category).toBe("answer_stream_interrupted");
    expect(isFallbackEligibleCategory(category)).toBe(false);
  });
});

describe("FallbackChatModelInvoker with an answer sink", () => {
  it("does not fall back after the primary published answer text", async () => {
    const { sink, state } = controlledSink();
    const fallback = vi.fn(async () => new AIMessage("fallback"));
    const model = new FallbackChatModelInvoker(
      [
        {
          provider: "ccr",
          invoker: {
            invoke: async () => {
              state.published = true;
              throw Object.assign(new Error("primary unavailable"), { statusCode: 502 });
            },
          },
        },
        { provider: "qwen", invoker: { invoke: fallback } },
      ],
      fallbackPolicy,
      silentObserver,
    );

    await expect(model.invoke("ping", { answerTextSink: sink })).rejects.toMatchObject({
      code: "answer_stream_interrupted",
      stage: "provider_fallback",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("still falls back when nothing was published", async () => {
    const { sink } = controlledSink();
    const model = new FallbackChatModelInvoker(
      [
        {
          provider: "ccr",
          invoker: {
            invoke: async () => {
              throw Object.assign(new Error("primary unavailable"), { statusCode: 502 });
            },
          },
        },
        { provider: "qwen", invoker: { invoke: async () => new AIMessage("fallback") } },
      ],
      fallbackPolicy,
      silentObserver,
    );

    await expect(model.invoke("ping", { answerTextSink: sink })).resolves.toMatchObject({ content: "fallback" });
  });

  it("passes the sink and an abort signal to each provider, and late deltas of a timed-out attempt are dropped", async () => {
    const metrics: string[] = [];
    const publish = vi.fn();
    const sink = createAnswerTextSink({
      messageId: "msg-1",
      publish,
      observer: { recordMetric: (name) => void metrics.push(name) },
    });
    let lateAppend: Promise<void> | undefined;
    const slowPrimary: ChatModelInvoker = {
      invoke: (_input, options) => {
        expect(options?.answerTextSink).toBe(sink);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        const writer = options!.answerTextSink!.beginAttempt({ provider: "ccr", attemptIndex: 0 });
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => {
            // An adapter seals in `finally`; anything the reader still yields afterwards is late.
            writer.seal("abandoned");
            lateAppend = writer.append("late text");
            reject(options!.signal!.reason);
          });
        });
      },
    };
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: slowPrimary },
        { provider: "qwen", invoker: { invoke: async () => new AIMessage("fallback") } },
      ],
      { ...fallbackPolicy, perProviderTimeoutMs: 5 },
      silentObserver,
    );

    await expect(model.invoke("ping", { answerTextSink: sink })).resolves.toMatchObject({ content: "fallback" });
    await lateAppend;
    expect(publish).not.toHaveBeenCalled();
    expect(metrics).toContain("answer.stream.late_delta_dropped");
  });
});

describe("FallbackChatModelInvoker first-chunk timeout (design D8)", () => {
  function hangingUntilAbort(): ChatModelInvoker {
    return {
      invoke: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        }),
    };
  }

  it("uses streamFirstChunkTimeoutMs instead of perProviderTimeoutMs when a sink is present", async () => {
    const { sink } = controlledSink();
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: hangingUntilAbort() },
        { provider: "qwen", invoker: { invoke: async () => new AIMessage("fallback") } },
      ],
      { ...fallbackPolicy, perProviderTimeoutMs: 60_000, streamFirstChunkTimeoutMs: 5 },
      silentObserver,
    );

    await expect(model.invoke("ping", { answerTextSink: sink })).resolves.toMatchObject({ content: "fallback" });
  });

  it("keeps perProviderTimeoutMs for callers without a sink", async () => {
    vi.useFakeTimers();
    try {
      const fallback = vi.fn(async () => new AIMessage("fallback"));
      const model = new FallbackChatModelInvoker(
        [
          { provider: "ccr", invoker: hangingUntilAbort() },
          { provider: "qwen", invoker: { invoke: fallback } },
        ],
        { ...fallbackPolicy, perProviderTimeoutMs: 1_000, streamFirstChunkTimeoutMs: 5 },
        silentObserver,
      );
      const pending = model.invoke("ping");
      await vi.advanceTimersByTimeAsync(10);
      expect(fallback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ content: "fallback" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abort an attempt that already published text", async () => {
    const { sink, state } = controlledSink();
    const primary: ChatModelInvoker = {
      invoke: (_input, options) =>
        new Promise((resolve, reject) => {
          state.published = true;
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
          setTimeout(() => resolve(new AIMessage("streamed answer")), 30);
        }),
    };
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: primary },
        { provider: "qwen", invoker: { invoke: async () => new AIMessage("fallback") } },
      ],
      { ...fallbackPolicy, streamFirstChunkTimeoutMs: 5 },
      silentObserver,
    );

    await expect(model.invoke("ping", { answerTextSink: sink })).resolves.toMatchObject({ content: "streamed answer" });
  });
});

describe("StructuredOutputRepairChatModelInvoker with an answer sink", () => {
  it("does not resend a repair request after answer text was published", async () => {
    const { StructuredOutputRepairChatModelInvoker } = await import("./llm-gateway.js");
    const { sink, state } = controlledSink();
    const delegate = vi.fn(async () => {
      state.published = true;
      return new AIMessage("not json");
    });
    const model = new StructuredOutputRepairChatModelInvoker({ invoke: delegate }, "retry_once");

    await expect(model.invoke("ping", { answerTextSink: sink })).rejects.toMatchObject({
      code: "answer_stream_interrupted",
      stage: "structured_output_repair",
    });
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("keeps repairing when nothing was published", async () => {
    const { StructuredOutputRepairChatModelInvoker } = await import("./llm-gateway.js");
    const { sink } = controlledSink();
    const delegate = vi
      .fn()
      .mockResolvedValueOnce(new AIMessage("not json"))
      .mockResolvedValueOnce(new AIMessage('{"ok":true}'));
    const model = new StructuredOutputRepairChatModelInvoker({ invoke: delegate }, "retry_once");

    await expect(model.invoke("ping", { answerTextSink: sink })).resolves.toMatchObject({ content: '{"ok":true}' });
    expect(delegate).toHaveBeenCalledTimes(2);
  });
});

describe("Gateway adapters with an answer sink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("OpenAI-compatible adapter stops its retry loop once answer text was published", async () => {
    stubQwenEnv();
    vi.resetModules();
    const { sink, state, attempts } = controlledSink();
    const fetchMock = vi.fn(async () => {
      state.published = true;
      return new Response("unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    await expect(
      llmGateway.createChatModel({ maxRetries: 2 }).invoke("ping", { answerTextSink: sink }),
    ).rejects.toMatchObject({ code: "answer_stream_interrupted", stage: "provider_retry" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([{ provider: "qwen", attemptIndex: 0, outcome: "abandoned" }]);
  });

  it("OpenAI-compatible adapter still retries before publication and seals every attempt", async () => {
    stubQwenEnv();
    vi.resetModules();
    const { sink, attempts } = controlledSink();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(okCompletion("hello"));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel({ maxRetries: 2 }).invoke("ping", { answerTextSink: sink });

    expect(response.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([
      { provider: "qwen", attemptIndex: 0, outcome: "abandoned" },
      { provider: "qwen", attemptIndex: 1, outcome: "completed" },
    ]);
  });

  it("CCR adapter stops its retry loop once answer text was published", async () => {
    vi.stubEnv("LLM_PROVIDER", "ccr");
    vi.stubEnv("CCR_BASE_URL", "http://ccr.internal/v1");
    vi.stubEnv("LLM_FALLBACK_ENABLED", "false");
    vi.resetModules();
    const { sink, state, attempts } = controlledSink();
    const fetchMock = vi.fn(async () => {
      state.published = true;
      return new Response("unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    await expect(
      llmGateway.createChatModel({ maxRetries: 2 }).invoke("ping", { answerTextSink: sink }),
    ).rejects.toMatchObject({ code: "answer_stream_interrupted", stage: "provider_retry" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([{ provider: "ccr", attemptIndex: 0, outcome: "abandoned" }]);
  });

  it("rejects a sink combined with responseFormat before any provider request", async () => {
    stubQwenEnv();
    vi.resetModules();
    const fetchMock = vi.fn(async () => okCompletion());
    vi.stubGlobal("fetch", fetchMock);
    const { sink } = controlledSink();

    const { llmGateway } = await import("./llm-gateway.js");
    const call = llmGateway
      .createChatModel({ maxRetries: 0, responseFormat: { type: "json_object" } })
      .invoke("ping", { answerTextSink: sink });

    // resetModules loads a fresh module graph, so compare by name rather than class identity.
    await expect(call).rejects.toMatchObject({
      name: AnswerTextSinkConfigurationError.name,
      code: "answer_sink_incompatible_call",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a sink combined with bound tools before any provider request", async () => {
    stubQwenEnv();
    vi.resetModules();
    const fetchMock = vi.fn(async () => okCompletion());
    vi.stubGlobal("fetch", fetchMock);
    const { sink } = controlledSink();
    const lookup = tool(async () => "ok", {
      name: "lookup",
      description: "Look something up.",
      schema: z.object({ query: z.string() }),
    });

    const { llmGateway } = await import("./llm-gateway.js");
    const bound = llmGateway.createChatModel({ maxRetries: 0 }).bindTools?.([lookup]);
    expect(bound).toBeDefined();

    await expect(bound!.invoke("ping", { answerTextSink: sink })).rejects.toMatchObject({
      code: "answer_sink_incompatible_call",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves callers without a sink unchanged: retries continue and nothing is sealed", async () => {
    stubQwenEnv();
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(okCompletion("hello"));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway
      .createChatModel({ maxRetries: 2, responseFormat: { type: "json_object" } })
      .invoke("ping");

    expect(response.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tracing and metric wrappers forward the sink and the caller signal to the adapter", async () => {
    stubQwenEnv();
    vi.resetModules();
    const controller = new AbortController();
    let upstreamAborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // The request only ends when the caller's cancellation reaches the upstream signal.
            init?.signal?.addEventListener("abort", () => {
              upstreamAborted = true;
              reject(init.signal?.reason);
            });
          }),
      ),
    );
    const { sink, attempts } = controlledSink();

    const { llmGateway } = await import("./llm-gateway.js");
    const pending = llmGateway
      .createChatModel({ maxRetries: 2 })
      .invoke("ping", { answerTextSink: sink, signal: controller.signal });
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow("caller cancelled");
    expect(upstreamAborted).toBe(true);
    expect(attempts).toEqual([{ provider: "qwen", attemptIndex: 0, outcome: "abandoned" }]);
  });
});
