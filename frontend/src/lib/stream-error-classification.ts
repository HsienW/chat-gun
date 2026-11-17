import type { StreamErrorKind } from '@/lib/stream-activity-state';
import { parseErrorEnvelope } from '@/types/errors';
import type { ErrorEnvelope } from '@/types/errors';

function getStreamErrorEnvelope(error: unknown): ErrorEnvelope | undefined {
  return (
    parseErrorEnvelope(error) ||
    parseErrorEnvelope(error instanceof Error ? error.message : String(error))
  );
}

export function isStreamAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    return /abort|aborted/i.test(`${error.name} ${error.message}`);
  }
  return /abort|aborted/i.test(String(error));
}

export function classifyStreamError(error: unknown): StreamErrorKind {
  const envelope = getStreamErrorEnvelope(error);
  const code = envelope?.error.code.toLowerCase();
  const causeCode = envelope?.error.cause?.code?.toLowerCase();

  if (
    code === 'timeout' ||
    code === 'upstream_timeout' ||
    code === 'bff_timeout' ||
    causeCode === 'timeout' ||
    causeCode === 'bff_timeout'
  ) {
    return 'timeout';
  }

  if (code === 'client_disconnected' || code === 'client_cancelled') {
    return 'abort';
  }

  if (isStreamAbortError(error)) {
    return 'abort';
  }

  return 'generic';
}

export type AnswerStreamFailure = {
  code: 'answer_stream_interrupted' | 'answer_stream_refused';
  causeCode?: string;
};

/** Reads the coded answer streaming failure from the structured error channel (design D12). */
export function readAnswerStreamFailure(error: unknown): AnswerStreamFailure | undefined {
  const envelope = getStreamErrorEnvelope(error);
  const code = envelope?.error.code;
  if (code !== 'answer_stream_interrupted' && code !== 'answer_stream_refused') return undefined;
  const causeCode = envelope?.error.cause?.code;
  return { code, ...(causeCode ? { causeCode } : {}) };
}

/** Timeouts are told apart from other interruptions by their cause code, never by text. */
export function isAnswerStreamTimeoutCause(causeCode: string | undefined): boolean {
  return (
    causeCode === 'answer_stream_first_chunk_timeout' ||
    causeCode === 'answer_stream_idle_timeout' ||
    causeCode === 'answer_stream_total_deadline_exceeded' ||
    causeCode === 'provider_timeout'
  );
}
