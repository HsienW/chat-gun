import {
  parseRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
} from '@/lib/runtime-event-envelope';

/**
 * Answer text streaming consumer (stream-chat-answer-text design D6, D11, D12).
 * Pure parsing, ownership and draft reduction; the React hook only schedules and wires these.
 */

export const ANSWER_DRAFT_GAP_WAIT_MS = 3_000;
const MAX_PENDING_FRAGMENTS = 256;
const MAX_SEALED_KEYS = 512;
const MAX_SEEN_EVENT_IDS = 2_048;
const MAX_DRAFTS = 16;
const MAX_MESSAGE_ID_LENGTH = 256;

export type AnswerFragment = {
  eventId: string;
  threadId: string;
  runId: string;
  requestId: string;
  messageId: string;
  textOffset: number;
  delta: string;
};

export type AnswerEventParseResult =
  | { kind: 'fragment'; fragment: AnswerFragment }
  | { kind: 'not_answer' }
  | { kind: 'invalid'; reason: 'invalid_envelope' | 'invalid_payload' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function claimsAnswerText(value: unknown): boolean {
  return asRecord(asRecord(value)?.payload)?.outputKind === 'answer_text';
}

/** True for a versioned `model.stream` envelope that carries answer text. */
export function isAnswerTextEnvelope(envelope: RuntimeEventEnvelope): boolean {
  return envelope.type === 'model.stream' && asRecord(envelope.payload)?.outputKind === 'answer_text';
}

/**
 * Runtime validation of one custom event. Old `model.stream` events with only `delta`, other
 * event types and foreign custom data are `not_answer`; anything claiming to be answer text but
 * failing validation is `invalid` and never reaches the draft.
 */
export function parseAnswerTextEvent(value: unknown): AnswerEventParseResult {
  const parsed = parseRuntimeEventEnvelope(value);
  if (parsed.kind !== 'versioned') {
    return claimsAnswerText(value) ? { kind: 'invalid', reason: 'invalid_envelope' } : { kind: 'not_answer' };
  }
  const { envelope } = parsed;
  if (!isAnswerTextEnvelope(envelope)) return { kind: 'not_answer' };

  const payload = asRecord(envelope.payload);
  const messageId = payload?.messageId;
  const textOffset = payload?.textOffset;
  const delta = payload?.delta;
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > MAX_MESSAGE_ID_LENGTH ||
    typeof textOffset !== 'number' ||
    !Number.isSafeInteger(textOffset) ||
    textOffset < 0 ||
    typeof delta !== 'string'
  ) {
    return { kind: 'invalid', reason: 'invalid_payload' };
  }
  return {
    kind: 'fragment',
    fragment: {
      eventId: envelope.eventId,
      threadId: envelope.context.threadId,
      runId: envelope.context.runId,
      requestId: envelope.context.requestId,
      messageId,
      textOffset,
      delta,
    },
  };
}

export type AnswerOwnership = { threadId?: string; runId?: string };

/** `pending` until the stream's own metadata names the run; foreign data never enters a draft. */
export function checkAnswerOwnership(
  fragment: AnswerFragment,
  owner: AnswerOwnership
): 'owned' | 'pending' | 'foreign' {
  if (owner.threadId && fragment.threadId !== owner.threadId) return 'foreign';
  if (!owner.runId) return 'pending';
  return fragment.runId === owner.runId ? 'owned' : 'foreign';
}

export type AnswerDraftStatus =
  | 'streaming'
  | 'awaiting_final'
  | 'interrupted'
  | 'timeout'
  | 'refused'
  | 'cancelled';

export type AnswerRunOutcome = 'completed' | 'interrupted' | 'timeout' | 'refused' | 'cancelled';

export interface AnswerDraft {
  key: string;
  threadId: string;
  runId: string;
  messageId: string;
  /** The longest provable prefix; only contiguous fragments extend it. */
  text: string;
  pending: ReadonlyArray<{ textOffset: number; delta: string }>;
  gapSince?: number;
  status: AnswerDraftStatus;
}

export interface AnswerDraftState {
  drafts: readonly AnswerDraft[];
  /** FIFO event identities, retained across finalization and run changes. */
  seenEventIds: readonly string[];
  /** Keys whose final message arrived or whose run ended; late fragments for them are dropped. */
  sealed: readonly string[];
}

export type AnswerDraftAction =
  | { type: 'fragments'; fragments: readonly AnswerFragment[]; now: number }
  | { type: 'tick'; now: number; gapWaitMs: number }
  | { type: 'finalized'; messageIds: readonly string[] }
  | { type: 'runEnded'; runId: string; outcome: AnswerRunOutcome }
  | { type: 'runStarted'; runId: string };

export const initialAnswerDraftState: AnswerDraftState = { drafts: [], seenEventIds: [], sealed: [] };

export function answerDraftKey(parts: Pick<AnswerFragment, 'threadId' | 'runId' | 'messageId'>): string {
  return JSON.stringify([parts.threadId, parts.runId, parts.messageId]);
}

function seal(sealed: readonly string[], keys: readonly string[]): readonly string[] {
  const next = [...sealed.filter((key) => !keys.includes(key)), ...keys];
  return next.length > MAX_SEALED_KEYS ? next.slice(next.length - MAX_SEALED_KEYS) : next;
}

/** Applies one fragment to the provable prefix: duplicates once, overlap checked, gaps held. */
function applyFragment(draft: AnswerDraft, textOffset: number, delta: string, now: number): AnswerDraft {
  if (draft.status !== 'streaming') return draft;
  const length = draft.text.length;
  const end = textOffset + delta.length;
  if (end <= length) {
    // Replayed fragment: identical content is a no-op, different content is a conflict.
    return draft.text.slice(textOffset, end) === delta ? draft : { ...draft, status: 'awaiting_final', pending: [], gapSince: undefined };
  }
  if (textOffset <= length) {
    const overlap = draft.text.slice(textOffset);
    if (!delta.startsWith(overlap)) return { ...draft, status: 'awaiting_final', pending: [], gapSince: undefined };
    return drainPending({ ...draft, text: draft.text + delta.slice(length - textOffset) }, now);
  }
  if (draft.pending.some((entry) => entry.textOffset === textOffset && entry.delta === delta)) return draft;
  if (draft.pending.length >= MAX_PENDING_FRAGMENTS) {
    return { ...draft, status: 'awaiting_final', pending: [], gapSince: undefined };
  }
  const pending = [...draft.pending, { textOffset, delta }].sort((a, b) => a.textOffset - b.textOffset);
  return { ...draft, pending, gapSince: draft.gapSince ?? now };
}

function drainPending(draft: AnswerDraft, now: number): AnswerDraft {
  let current: AnswerDraft = { ...draft, pending: [] };
  let waiting: Array<{ textOffset: number; delta: string }> = [];
  for (const entry of draft.pending) {
    if (entry.textOffset <= current.text.length) {
      current = applyFragment(current, entry.textOffset, entry.delta, now);
      if (current.status !== 'streaming') return current;
    } else {
      waiting.push(entry);
    }
  }
  // Entries made contiguous by earlier ones in this pass are applied by repeated draining.
  if (waiting.length > 0 && waiting[0]!.textOffset <= current.text.length) {
    return drainPending({ ...current, pending: waiting }, now);
  }
  waiting = waiting.sort((a, b) => a.textOffset - b.textOffset);
  return { ...current, pending: waiting, gapSince: waiting.length > 0 ? (draft.gapSince ?? now) : undefined };
}

function terminalStatus(outcome: AnswerRunOutcome): AnswerDraftStatus {
  return outcome === 'completed' ? 'awaiting_final' : outcome;
}

export function answerDraftReducer(state: AnswerDraftState, action: AnswerDraftAction): AnswerDraftState {
  switch (action.type) {
    case 'fragments': {
      let drafts = [...state.drafts];
      const seenEventIds = new Set(state.seenEventIds);
      let hasNewFragments = false;
      for (const fragment of action.fragments) {
        if (seenEventIds.has(fragment.eventId)) continue;
        const key = answerDraftKey(fragment);
        if (state.sealed.includes(key)) continue;
        seenEventIds.add(fragment.eventId);
        if (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
          const oldest = seenEventIds.values().next().value;
          if (typeof oldest === 'string') seenEventIds.delete(oldest);
        }
        hasNewFragments = true;
        const index = drafts.findIndex((draft) => draft.key === key);
        const existing: AnswerDraft = index >= 0
          ? drafts[index]!
          : {
              key,
              threadId: fragment.threadId,
              runId: fragment.runId,
              messageId: fragment.messageId,
              text: '',
              pending: [],
              status: 'streaming',
            };
        const updated = applyFragment(existing, fragment.textOffset, fragment.delta, action.now);
        if (index >= 0) drafts[index] = updated;
        else drafts.push(updated);
      }
      if (!hasNewFragments) return state;
      if (drafts.length > MAX_DRAFTS) drafts = drafts.slice(drafts.length - MAX_DRAFTS);
      return { ...state, drafts, seenEventIds: [...seenEventIds] };
    }
    case 'tick': {
      let changed = false;
      const drafts = state.drafts.map((draft) => {
        if (draft.status !== 'streaming' || draft.gapSince === undefined) return draft;
        if (action.now - draft.gapSince <= action.gapWaitMs) return draft;
        changed = true;
        // Window exceeded: keep the provable prefix and wait for the authoritative message.
        return { ...draft, status: 'awaiting_final' as const, pending: [], gapSince: undefined };
      });
      return changed ? { ...state, drafts } : state;
    }
    case 'finalized': {
      const finalized = state.drafts.filter((draft) => action.messageIds.includes(draft.messageId));
      if (finalized.length === 0) return state;
      return {
        ...state,
        drafts: state.drafts.filter((draft) => !action.messageIds.includes(draft.messageId)),
        sealed: seal(state.sealed, finalized.map((draft) => draft.key)),
      };
    }
    case 'runEnded': {
      const ended = state.drafts.filter((draft) => draft.runId === action.runId);
      if (ended.length === 0) return state;
      const status = terminalStatus(action.outcome);
      return {
        ...state,
        drafts: state.drafts.map((draft) =>
          draft.runId === action.runId ? { ...draft, status, pending: [], gapSince: undefined } : draft
        ),
        sealed: seal(state.sealed, ended.map((draft) => draft.key)),
      };
    }
    case 'runStarted': {
      // A new run replaces what the previous runs left on screen; their late fragments stay sealed.
      const leftover = state.drafts.filter((draft) => draft.runId !== action.runId);
      if (leftover.length === 0) return state;
      return {
        ...state,
        drafts: state.drafts.filter((draft) => draft.runId === action.runId),
        sealed: seal(state.sealed, leftover.map((draft) => draft.key)),
      };
    }
  }
}

/** Drafts still to show: an authoritative message with the same id always wins in the same render. */
export function selectVisibleDrafts(state: AnswerDraftState, finalMessageIds: ReadonlySet<string>): AnswerDraft[] {
  return state.drafts.filter((draft) => !finalMessageIds.has(draft.messageId));
}

export function hasGapWaitingDraft(state: AnswerDraftState): boolean {
  return state.drafts.some((draft) => draft.status === 'streaming' && draft.gapSince !== undefined);
}
