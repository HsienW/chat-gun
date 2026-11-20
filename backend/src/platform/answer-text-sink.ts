import type { LlmProviderName } from "./llm-gateway.js";
import { recordMetric } from "./observability.js";
import { classifyProviderError } from "./provider-error-category.js";

/**
 * Answer-text streaming contract between the Gateway and the node that opted in (design D2).
 * A sink is bound to one assistant message; every real upstream attempt opens its own writer.
 */
export type AnswerStreamAttempt = {
  provider: LlmProviderName;
  /** Provider-level attempt counter; never overwrites the Run `attempt` in the envelope context. */
  attemptIndex: number;
};

export interface AnswerTextAttemptWriter {
  append(textDelta: string): Promise<void>;
  seal(outcome: "completed" | "abandoned"): void;
}

export interface AnswerTextSink {
  readonly messageId: string;
  /** Becomes true after the first successful append and never goes back. */
  readonly hasPublished: boolean;
  beginAttempt(attempt: AnswerStreamAttempt): AnswerTextAttemptWriter;
}

/** Publishes one validated answer fragment. `textOffset` counts UTF-16 code units already published. */
export type AnswerTextPublisher = (fragment: {
  messageId: string;
  delta: string;
  textOffset: number;
}) => Promise<void> | void;

export type AnswerTextSinkObserver = {
  recordMetric(name: string, payload: Record<string, unknown>): Promise<void> | void;
};

const defaultObserver: AnswerTextSinkObserver = { recordMetric };

async function safeMetric(
  observer: AnswerTextSinkObserver,
  name: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await observer.recordMetric(name, payload);
  } catch {
    // Observability must never change answer delivery.
  }
}

class PublishingAnswerTextSink implements AnswerTextSink {
  private published = false;
  private textOffset = 0;

  constructor(
    readonly messageId: string,
    private readonly publish: AnswerTextPublisher,
    private readonly observer: AnswerTextSinkObserver,
  ) {
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new AnswerTextSinkConfigurationError("answer_sink_message_id_missing");
    }
  }

  get hasPublished(): boolean {
    return this.published;
  }

  beginAttempt(attempt: AnswerStreamAttempt): AnswerTextAttemptWriter {
    let sealed = false;
    return {
      append: async (textDelta: string) => {
        if (sealed) {
          await safeMetric(this.observer, "answer.stream.late_delta_dropped", {
            messageId: this.messageId,
            provider: attempt.provider,
            attemptIndex: attempt.attemptIndex,
          });
          return;
        }
        if (typeof textDelta !== "string" || textDelta.length === 0) return;
        const textOffset = this.textOffset;
        await this.publish({ messageId: this.messageId, delta: textDelta, textOffset });
        // Offset and the published flag move only after the writer accepted the fragment.
        this.textOffset = textOffset + textDelta.length;
        this.published = true;
      },
      seal: () => {
        sealed = true;
      },
    };
  }
}

export function createAnswerTextSink(input: {
  messageId: string;
  publish: AnswerTextPublisher;
  observer?: AnswerTextSinkObserver;
}): AnswerTextSink {
  return new PublishingAnswerTextSink(input.messageId, input.publish, input.observer ?? defaultObserver);
}

export type AnswerTextSinkConfigurationCode =
  | "answer_sink_incompatible_call"
  | "answer_sink_message_id_missing";

/** Raised before any provider request when a sink is combined with an unsupported call shape. */
export class AnswerTextSinkConfigurationError extends Error {
  readonly code: AnswerTextSinkConfigurationCode;

  constructor(code: AnswerTextSinkConfigurationCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AnswerTextSinkConfigurationError";
    this.code = code;
  }
}

export type AnswerStreamInterruptedStage =
  | "provider_retry"
  | "tool_argument_repair"
  | "structured_output_repair"
  | "provider_fallback";

/** A failure after answer text reached the user; no layer may retry it transparently (design D3). */
export class AnswerStreamInterruptedError extends Error {
  readonly code = "answer_stream_interrupted" as const;
  readonly stage: AnswerStreamInterruptedStage;

  constructor(cause: unknown, stage: AnswerStreamInterruptedStage) {
    super("answer_stream_interrupted", { cause });
    this.name = "AnswerStreamInterruptedError";
    this.stage = stage;
  }
}

export type AnswerTextProjection = { kind: "json_string_field"; field: string };

type SinkCarrier = { answerTextSink?: AnswerTextSink; answerTextProjection?: AnswerTextProjection } | undefined;

export function isRetryBlockedByPublishedAnswer(options: SinkCarrier): boolean {
  return options?.answerTextSink?.hasPublished === true;
}

/** Wraps the error once; an already-interrupted error keeps its original stage. */
export function toAnswerStreamInterruptedError(
  error: unknown,
  stage: AnswerStreamInterruptedStage,
): AnswerStreamInterruptedError {
  return error instanceof AnswerStreamInterruptedError ? error : new AnswerStreamInterruptedError(error, stage);
}

export function assertAnswerSinkCompatible(
  options: SinkCarrier,
  call: { responseFormat?: { type: string }; hasTools: boolean },
): void {
  if (!options?.answerTextSink) return;
  if (call.hasTools) {
    throw new AnswerTextSinkConfigurationError("answer_sink_incompatible_call", "bindTools");
  }
  const compatibleFormat = options.answerTextProjection
    ? call.responseFormat?.type === "json_object"
    : call.responseFormat === undefined;
  if (!compatibleFormat) {
    throw new AnswerTextSinkConfigurationError("answer_sink_incompatible_call", "responseFormat");
  }
}

/** Closed set for `answer.stream.degraded{reason}` (design D9). */
export const ANSWER_STREAM_DEGRADED_REASONS = [
  "capability_unsupported",
  "feature_disabled",
  "execution_context_missing",
  "writer_missing",
  "envelope_disabled",
  "final_moderation_required",
] as const;
export type AnswerStreamDegradedReason = (typeof ANSWER_STREAM_DEGRADED_REASONS)[number];

export function normalizeAnswerStreamDegradedReason(value: unknown): AnswerStreamDegradedReason | "unknown" {
  return (ANSWER_STREAM_DEGRADED_REASONS as readonly unknown[]).includes(value)
    ? (value as AnswerStreamDegradedReason)
    : "unknown";
}

/** Records that a sink caller gets a whole reply instead of a stream. Never throws. */
export async function recordAnswerStreamDegraded(
  reason: unknown,
  context: { messageId?: string; provider?: string },
  observer: AnswerTextSinkObserver = defaultObserver,
): Promise<void> {
  await safeMetric(observer, "answer.stream.degraded", {
    reason: normalizeAnswerStreamDegradedReason(reason),
    ...(context.messageId ? { messageId: context.messageId } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
  });
}

/** Content filter ended a streamed answer; the node must not commit the published fragments. */
export class AnswerStreamRefusedError extends Error {
  readonly code = "answer_stream_refused" as const;

  constructor() {
    super("answer_stream_refused");
    this.name = "AnswerStreamRefusedError";
  }
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function readCauseCode(cause: unknown): string {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : classifyProviderError(cause);
}

/**
 * The run error a node throws for answer streaming failures (design D12, error code delivery).
 * Agent Server serializes it as `{ error: name, message }`; the message is an ErrorEnvelope the
 * frontend already parses. It carries codes only: no provider text and no answer text.
 */
export class AnswerStreamRunError extends Error {
  constructor(
    readonly code: "answer_stream_interrupted" | "answer_stream_refused",
    readonly causeCode: string | undefined,
    cause: unknown,
  ) {
    super(
      JSON.stringify({
        error: {
          source: "backend",
          stage: "chat_response",
          code,
          message: code,
          ...(causeCode ? { cause: { code: causeCode } } : {}),
        },
      }),
      { cause },
    );
    this.name = "AnswerStreamRunError";
  }
}

/** Maps the two answer streaming failures to a run error; anything else is left to the caller. */
export function toAnswerStreamRunError(error: unknown): AnswerStreamRunError | undefined {
  if (error instanceof AnswerStreamRefusedError) return new AnswerStreamRunError("answer_stream_refused", undefined, error);
  if (error instanceof AnswerStreamInterruptedError) {
    return new AnswerStreamRunError("answer_stream_interrupted", readCauseCode(error.cause), error);
  }
  return undefined;
}
