import { z } from "zod";

import type { AnswerTextAttemptWriter } from "./answer-text-sink.js";
import { decodeJsonText } from "./json-decode.js";

/**
 * Incremental decoder for OpenAI-compatible `chat/completions` SSE streams (design D7, D8).
 * Only the selected choice's visible `delta.content` is published; role, heartbeat, usage,
 * reasoning content and tool arguments are kept on their own branches and never published.
 */

export type ChatStreamLimits = {
  firstChunkTimeoutMs: number;
  idleTimeoutMs: number;
  totalDeadlineMs: number;
  /** Upper bound for undecoded bytes plus the partially assembled event. */
  maxPendingBytes: number;
  /** Upper bound for one complete `data:` payload. */
  maxFrameBytes: number;
  maxDepth: number;
};

export type ChatStreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ChatStreamResult = {
  /** Exactly the accepted fragments, in order; the final message is built from this. */
  text: string;
  finishReason?: string;
  usage?: ChatStreamUsage;
  sawDoneMarker: boolean;
  id?: string;
  model?: string;
};

export type ChatStreamProtocolCode =
  | "answer_stream_unexpected_media_type"
  | "answer_stream_frame_invalid"
  | "answer_stream_frame_truncated"
  | "answer_stream_pending_overflow"
  | "answer_stream_incomplete"
  | "answer_stream_unpaired_surrogate"
  | "answer_stream_invalid_utf8";

/** The endpoint broke the streaming protocol; classified as an invalid provider response. */
export class ChatStreamProtocolError extends Error {
  constructor(readonly code: ChatStreamProtocolCode) {
    super(code);
    this.name = "ChatStreamProtocolError";
  }
}

export type ChatStreamTimeoutCode =
  | "answer_stream_first_chunk_timeout"
  | "answer_stream_idle_timeout"
  | "answer_stream_total_deadline_exceeded";

/** A stream deadline fired; classified as a provider timeout. */
export class ChatStreamTimeoutError extends Error {
  constructor(readonly code: ChatStreamTimeoutCode) {
    super(code);
    this.name = "ChatStreamTimeoutError";
  }
}

/** The answer writer rejected a fragment; the stream stops and is never retried. */
export class AnswerTextWriterError extends Error {
  readonly code = "answer_stream_writer_failed" as const;
  constructor(cause: unknown) {
    super("answer_stream_writer_failed", { cause });
    this.name = "AnswerTextWriterError";
  }
}

const nullableString = z.string().nullable().optional();
const chunkSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative().optional(),
            delta: z
              .object({ role: nullableString, content: nullableString, reasoning_content: nullableString })
              .passthrough()
              .nullable()
              .optional(),
            finish_reason: nullableString,
          })
          .passthrough(),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ChatStreamChunk = z.infer<typeof chunkSchema>;

export type SseEvent = { data: string };

/**
 * SSE framing over an incremental UTF-8 decoder: CRLF / CR / LF line ends, several events per
 * chunk, multi-line `data:` fields, comment heartbeats. Unconsumed input is kept between pushes.
 */
export class SseFrameDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private dataLines: string[] = [];
  private dataBytes = 0;

  constructor(private readonly maxPendingBytes: number) {}

  push(bytes: Uint8Array): SseEvent[] {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new ChatStreamProtocolError("answer_stream_invalid_utf8");
    }
    this.pending += text;
    const events = this.drainLines();
    if (Buffer.byteLength(this.pending, "utf8") + this.dataBytes > this.maxPendingBytes) {
      throw new ChatStreamProtocolError("answer_stream_pending_overflow");
    }
    return events;
  }

  /** EOF: anything not closed by a blank line is a truncated frame. */
  end(): void {
    try {
      this.pending += this.decoder.decode();
    } catch {
      throw new ChatStreamProtocolError("answer_stream_invalid_utf8");
    }
    if (this.pending.length > 0 || this.dataLines.length > 0) {
      throw new ChatStreamProtocolError("answer_stream_frame_truncated");
    }
  }

  private drainLines(): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    for (let index = 0; index < this.pending.length; index += 1) {
      const char = this.pending[index];
      if (char !== "\n" && char !== "\r") continue;
      if (char === "\r" && index === this.pending.length - 1) break; // may be the first half of CRLF
      const line = this.pending.slice(start, index);
      if (char === "\r" && this.pending[index + 1] === "\n") index += 1;
      start = index + 1;
      const event = this.acceptLine(line);
      if (event) events.push(event);
    }
    this.pending = this.pending.slice(start);
    return events;
  }

  private acceptLine(line: string): SseEvent | undefined {
    if (line === "") {
      if (this.dataLines.length === 0) return undefined;
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      this.dataBytes = 0;
      return { data };
    }
    if (line.startsWith(":")) return undefined; // heartbeat / comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return undefined;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.dataLines.push(value);
    this.dataBytes += Buffer.byteLength(value, "utf8") + 1;
    return undefined;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Holds a trailing high surrogate until its pair arrives, so offsets never split a code point. */
export class SurrogateCarry {
  private carry = "";

  take(delta: string): string {
    const text = this.carry + delta;
    this.carry = "";
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      this.carry = text.slice(-1);
      return text.slice(0, -1);
    }
    return text;
  }

  end(): void {
    if (this.carry) throw new ChatStreamProtocolError("answer_stream_unpaired_surrogate");
  }
}

/** First-chunk, idle and total deadlines. Heartbeats, role and usage frames never reset them. */
export class ChatStreamDeadlines {
  private firedError: ChatStreamTimeoutError | undefined;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly totalTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly limits: Pick<ChatStreamLimits, "firstChunkTimeoutMs" | "idleTimeoutMs" | "totalDeadlineMs">,
    private readonly onTimeout: (error: ChatStreamTimeoutError) => void,
  ) {
    this.totalTimer = setTimeout(() => this.fire("answer_stream_total_deadline_exceeded"), limits.totalDeadlineMs);
    this.gapTimer = setTimeout(() => this.fire("answer_stream_first_chunk_timeout"), limits.firstChunkTimeoutMs);
  }

  get error(): ChatStreamTimeoutError | undefined {
    return this.firedError;
  }

  onVisibleFragment(): void {
    if (this.firedError) return;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => this.fire("answer_stream_idle_timeout"), this.limits.idleTimeoutMs);
  }

  dispose(): void {
    clearTimeout(this.totalTimer);
    if (this.gapTimer) clearTimeout(this.gapTimer);
  }

  private fire(code: ChatStreamTimeoutCode): void {
    if (this.firedError) return;
    this.firedError = new ChatStreamTimeoutError(code);
    this.dispose();
    this.onTimeout(this.firedError);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Reads one chunk but gives up as soon as the signal aborts, even if the source ignores it. */
async function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parseChunk(data: string, limits: ChatStreamLimits, signal: AbortSignal): ChatStreamChunk {
  const decoded = decodeJsonText<unknown>(data, {
    maxBytes: limits.maxFrameBytes,
    maxDepth: limits.maxDepth,
    signal,
  });
  if (decoded.status === "aborted") throw abortReason(signal);
  if (decoded.status !== "valid") throw new ChatStreamProtocolError("answer_stream_frame_invalid");
  const parsed = chunkSchema.safeParse(decoded.value);
  if (!parsed.success) throw new ChatStreamProtocolError("answer_stream_frame_invalid");
  return parsed.data;
}

/**
 * Consumes the body until the `[DONE]` marker or EOF. Visible text is appended to the attempt
 * writer as it arrives; a writer failure stops reading. The caller owns the abort signal and
 * deadlines; `onVisibleFragment` reports each published fragment.
 */
export async function consumeOpenAiChatStream(input: {
  body: ReadableStream<Uint8Array>;
  writer: AnswerTextAttemptWriter;
  limits: ChatStreamLimits;
  signal: AbortSignal;
  onVisibleFragment?: () => void;
}): Promise<ChatStreamResult> {
  const frames = new SseFrameDecoder(input.limits.maxPendingBytes);
  const surrogates = new SurrogateCarry();
  const reader = input.body.getReader();
  const result: ChatStreamResult = { text: "", sawDoneMarker: false };

  const handle = async (event: SseEvent): Promise<boolean> => {
    if (event.data === "[DONE]") {
      result.sawDoneMarker = true;
      return true;
    }
    const chunk = parseChunk(event.data, input.limits, input.signal);
    if (chunk.id && !result.id) result.id = chunk.id;
    if (chunk.model && !result.model) result.model = chunk.model;
    if (chunk.usage) result.usage = chunk.usage;
    const choice = chunk.choices?.find((candidate) => (candidate.index ?? 0) === 0);
    const content = choice?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      const visible = surrogates.take(content);
      if (visible.length > 0) {
        try {
          await input.writer.append(visible);
        } catch (error) {
          throw new AnswerTextWriterError(error);
        }
        result.text += visible;
        input.onVisibleFragment?.();
      }
    }
    if (typeof choice?.finish_reason === "string") result.finishReason = choice.finish_reason;
    return false;
  };

  try {
    while (true) {
      const { done, value } = await readOrAbort(reader, input.signal);
      if (done) {
        frames.end();
        break;
      }
      let finished = false;
      for (const event of frames.push(value)) {
        if (await handle(event)) {
          finished = true;
          break;
        }
      }
      if (finished) break;
    }
    surrogates.end();
    if (!result.finishReason) throw new ChatStreamProtocolError("answer_stream_incomplete");
    return result;
  } finally {
    // Release the upstream connection whatever happened; never leave a reader running.
    void reader.cancel().catch(() => undefined);
  }
}
