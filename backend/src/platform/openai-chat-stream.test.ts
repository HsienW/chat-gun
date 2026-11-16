import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnswerTextSink, type AnswerTextAttemptWriter } from "./answer-text-sink.js";
import {
  AnswerTextWriterError,
  ChatStreamDeadlines,
  ChatStreamProtocolError,
  ChatStreamTimeoutError,
  consumeOpenAiChatStream,
  SseFrameDecoder,
  type ChatStreamLimits,
} from "./openai-chat-stream.js";

const encoder = new TextEncoder();

const limits: ChatStreamLimits = {
  firstChunkTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  totalDeadlineMs: 5_000,
  maxPendingBytes: 65_536,
  maxFrameBytes: 65_536,
  maxDepth: 64,
};

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content: string, extra: Record<string, unknown> = {}) {
  return frame({ id: "chatcmpl-1", model: "qwen-fixture", choices: [{ index: 0, delta: { content, ...extra } }] });
}

/** One fixture covering role, heartbeat, reasoning, CJK, emoji, escaped quotes, empty frames and a usage tail. */
const FIXTURE_TEXT = [
  frame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant" } }] }),
  ": keep-alive\n\n",
  frame({ choices: [{ index: 0, delta: { reasoning_content: "secret plan" } }] }),
  delta("你好，"),
  delta('他說 "hi" \\ 😀'),
  frame({ choices: [{ index: 0, delta: { content: "" } }] }),
  frame({ choices: [] }),
  delta("結束。"),
  frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
  "data: [DONE]\n\n",
].join("");
const FIXTURE_ANSWER = '你好，他說 "hi" \\ 😀結束。';

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    parts.push(bytes.slice(start, cut));
    start = cut;
  }
  return parts;
}

function recordingWriter() {
  const fragments: Array<{ delta: string; textOffset: number }> = [];
  const sink = createAnswerTextSink({
    messageId: "msg-1",
    publish: ({ delta: text, textOffset }) => void fragments.push({ delta: text, textOffset }),
    observer: { recordMetric: () => undefined },
  });
  return { fragments, writer: sink.beginAttempt({ provider: "qwen", attemptIndex: 0 }) };
}

async function consume(chunks: Uint8Array[], writer: AnswerTextAttemptWriter, overrides: Partial<ChatStreamLimits> = {}) {
  return consumeOpenAiChatStream({
    body: streamOf(chunks),
    writer,
    limits: { ...limits, ...overrides },
    signal: new AbortController().signal,
  });
}

describe("consumeOpenAiChatStream", () => {
  it("decodes the same answer for every single byte boundary and publishes only visible text", async () => {
    const bytes = encoder.encode(FIXTURE_TEXT);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const { fragments, writer } = recordingWriter();
      const result = await consume(splitAt(bytes, [cut]), writer);

      expect(result.text).toBe(FIXTURE_ANSWER);
      expect(fragments.map((fragment) => fragment.delta).join("")).toBe(FIXTURE_ANSWER);
      expect(result).toMatchObject({ finishReason: "stop", sawDoneMarker: true, id: "chatcmpl-1", model: "qwen-fixture" });
      expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
      expect(result.text).not.toContain("secret plan");
    }
  });

  it("decodes one byte per chunk and CRLF line endings", async () => {
    const bytes = encoder.encode(FIXTURE_TEXT.replace(/\n/g, "\r\n"));
    const { writer } = recordingWriter();
    const result = await consume(Array.from(bytes, (byte) => Uint8Array.of(byte)), writer);
    expect(result.text).toBe(FIXTURE_ANSWER);
  });

  it("counts textOffset in UTF-16 code units, not UTF-8 bytes", async () => {
    const { fragments, writer } = recordingWriter();
    await consume([encoder.encode(delta("😀a") + delta("中") + delta("b") + frame({ choices: [{ finish_reason: "stop" }] }))], writer);

    expect(fragments).toEqual([
      { delta: "😀a", textOffset: 0 },
      { delta: "中", textOffset: 3 },
      { delta: "b", textOffset: 4 },
    ]);
  });

  it("holds a trailing high surrogate until its pair arrives", async () => {
    const { fragments, writer } = recordingWriter();
    const result = await consume(
      [encoder.encode(delta("a\uD83D") + delta("\uDE00b") + frame({ choices: [{ finish_reason: "stop" }] }))],
      writer,
    );

    expect(fragments).toEqual([
      { delta: "a", textOffset: 0 },
      { delta: "😀b", textOffset: 1 },
    ]);
    expect(result.text).toBe("a😀b");
  });

  it("rejects a high surrogate left unpaired at the end", async () => {
    const { writer } = recordingWriter();
    await expect(
      consume([encoder.encode(delta("a\uD83D") + frame({ choices: [{ finish_reason: "stop" }] }))], writer),
    ).rejects.toMatchObject({ code: "answer_stream_unpaired_surrogate" });
  });

  it("joins multi-line data fields of one event", async () => {
    const { writer } = recordingWriter();
    // Data lines are joined with "\n", which JSON accepts as whitespace between tokens.
    const multiLine = `data: {"choices":\ndata: [{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`;
    const result = await consume([encoder.encode(multiLine)], writer);
    expect(result.text).toBe("hi");
  });

  it("reports half a JSON frame at EOF as truncated", async () => {
    const { writer } = recordingWriter();
    const text = delta("ok") + 'data: {"choices":[{"delta":{"content":"cut';
    await expect(consume([encoder.encode(text)], writer)).rejects.toMatchObject({
      name: "ChatStreamProtocolError",
      code: "answer_stream_frame_truncated",
    });
  });

  it("reports an invalid JSON payload inside a complete frame", async () => {
    const { writer } = recordingWriter();
    await expect(consume([encoder.encode("data: {not json}\n\n")], writer)).rejects.toMatchObject({
      code: "answer_stream_frame_invalid",
    });
  });

  it("does not treat EOF without a finish reason as success, even with text", async () => {
    const { writer } = recordingWriter();
    await expect(consume([encoder.encode(delta("partial"))], writer)).rejects.toMatchObject({
      code: "answer_stream_incomplete",
    });
    await expect(consume([encoder.encode(delta("partial") + "data: [DONE]\n\n")], recordingWriter().writer)).rejects.toMatchObject({
      code: "answer_stream_incomplete",
    });
  });

  it("succeeds on a finish reason without usage or a done marker", async () => {
    const { writer } = recordingWriter();
    const result = await consume([encoder.encode(delta("x") + frame({ choices: [{ finish_reason: "length" }] }))], writer);
    expect(result).toMatchObject({ text: "x", finishReason: "length", sawDoneMarker: false });
    expect(result.usage).toBeUndefined();
  });

  it("rejects a stream whose pending bytes exceed the limit", async () => {
    const { writer } = recordingWriter();
    const text = `data: ${"x".repeat(5_000)}`;
    await expect(consume([encoder.encode(text)], writer, { maxPendingBytes: 4_096 })).rejects.toBeInstanceOf(
      ChatStreamProtocolError,
    );
  });

  it("rejects invalid UTF-8", async () => {
    const { writer } = recordingWriter();
    await expect(consume([Uint8Array.of(0x64, 0x61, 0xff, 0x0a, 0x0a)], writer)).rejects.toMatchObject({
      code: "answer_stream_invalid_utf8",
    });
  });

  it("stops reading and cancels the source when the writer fails", async () => {
    const onCancel = vi.fn();
    const writer: AnswerTextAttemptWriter = {
      append: async () => {
        throw new Error("writer down");
      },
      seal: () => undefined,
    };
    await expect(
      consumeOpenAiChatStream({
        body: streamOf([encoder.encode(delta("a")), encoder.encode(delta("b"))], onCancel),
        writer,
        limits,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AnswerTextWriterError);
    expect(onCancel).toHaveBeenCalled();
  });

  it("aborts a stalled read when the signal fires, even if the source ignores it", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: onCancel });
    const reason = new Error("caller cancelled");
    const pending = consumeOpenAiChatStream({ body: stalled, writer: recordingWriter().writer, limits, signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("SseFrameDecoder", () => {
  it("keeps a lone CR pending until it knows whether LF follows", () => {
    const decoder = new SseFrameDecoder(1_024);
    expect(decoder.push(encoder.encode("data: a\r"))).toEqual([]);
    expect(decoder.push(encoder.encode("\n\r\n"))).toEqual([{ data: "a" }]);
    expect(() => decoder.end()).not.toThrow();
  });
});

describe("ChatStreamDeadlines with the decoder", () => {
  function controlledStream() {
    let push: (text: string) => void = () => undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => {
          if (!cancelled) controller.enqueue(encoder.encode(text));
        };
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, push: (text: string) => push(text) };
  }

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  afterEach(() => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
  });

  async function runWithDeadlines(overrides: Partial<ChatStreamLimits>, drive: (push: (text: string) => void) => void) {
    const controller = new AbortController();
    const streamLimits = { ...limits, ...overrides };
    const deadlines = new ChatStreamDeadlines(streamLimits, (error) => controller.abort(error));
    const { body, push } = controlledStream();
    drive(push);
    try {
      return await consumeOpenAiChatStream({
        body,
        writer: recordingWriter().writer,
        limits: streamLimits,
        signal: controller.signal,
        onVisibleFragment: () => deadlines.onVisibleFragment(),
      });
    } finally {
      deadlines.dispose();
    }
  }

  it("fires the first-chunk timeout when no visible text arrives; role and heartbeat frames do not count", async () => {
    await expect(
      runWithDeadlines({ firstChunkTimeoutMs: 30 }, (push) => {
        push(frame({ choices: [{ delta: { role: "assistant" } }] }));
        push(": ping\n\n");
      }),
    ).rejects.toMatchObject({ name: "ChatStreamTimeoutError", code: "answer_stream_first_chunk_timeout" });
  });

  it("fires the idle timeout between fragments; heartbeats and usage frames do not reset it", async () => {
    await expect(
      runWithDeadlines({ idleTimeoutMs: 40 }, (push) => {
        push(delta("first"));
        timers.push(setInterval(() => push(": ping\n\n"), 5));
        timers.push(setTimeout(() => push(frame({ choices: [], usage: { prompt_tokens: 1 } })), 10));
      }),
    ).rejects.toMatchObject({ code: "answer_stream_idle_timeout" });
  });

  it("fires the total deadline even while fragments keep arriving", async () => {
    await expect(
      runWithDeadlines({ totalDeadlineMs: 60, idleTimeoutMs: 1_000 }, (push) => {
        timers.push(setInterval(() => push(delta("x")), 5));
      }),
    ).rejects.toBeInstanceOf(ChatStreamTimeoutError);
  });
});
