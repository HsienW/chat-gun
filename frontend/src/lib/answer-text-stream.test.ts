import { describe, expect, it } from 'vitest';

import {
  answerDraftKey,
  answerDraftReducer,
  checkAnswerOwnership,
  initialAnswerDraftState,
  parseAnswerTextEvent,
  selectVisibleDrafts,
  type AnswerDraftState,
  type AnswerFragment,
} from '@/lib/answer-text-stream';

function envelope(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    eventId: `run-1:${String(payload.messageId)}:${String(payload.textOffset)}`,
    sequence: 1,
    type: 'model.stream',
    emittedAt: '2026-11-15T00:00:00.000Z',
    context: {
      requestId: 'request-1',
      threadId: 'thread-1',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      principalId: 'principal-1',
      tenantId: 'tenant-1',
      scopeId: 'tenant-1',
      scopeType: 'tenant',
    },
    payload,
    ...overrides,
  };
}

function fragment(textOffset: number, delta: string, overrides: Partial<AnswerFragment> = {}): AnswerFragment {
  return {
    eventId: `${overrides.runId ?? 'run-1'}:${overrides.messageId ?? 'msg-1'}:${textOffset}`,
    threadId: 'thread-1', runId: 'run-1', requestId: 'request-1', messageId: 'msg-1', textOffset, delta, ...overrides,
  };
}

function apply(state: AnswerDraftState, fragments: AnswerFragment[], now = 0): AnswerDraftState {
  return answerDraftReducer(state, { type: 'fragments', fragments, now });
}

const text = (state: AnswerDraftState) => state.drafts.map((draft) => draft.text);

describe('parseAnswerTextEvent', () => {
  it('accepts a versioned answer_text model.stream envelope and tolerates unknown fields', () => {
    const result = parseAnswerTextEvent({
      ...envelope({ delta: ' 你好\n', messageId: 'msg-1', outputKind: 'answer_text', textOffset: 0 }),
      futureField: true,
    });
    expect(result).toEqual({ kind: 'fragment', fragment: fragment(0, ' 你好\n') });
  });

  it('treats delta-only model.stream, other types and foreign custom data as not answer text', () => {
    expect(parseAnswerTextEvent(envelope({ delta: 'activity' }))).toEqual({ kind: 'not_answer' });
    expect(parseAnswerTextEvent(envelope({ finishReason: 'stop' }, { type: 'model.done' }))).toEqual({ kind: 'not_answer' });
    expect(parseAnswerTextEvent({ gate: 'before-return' })).toEqual({ kind: 'not_answer' });
  });

  it.each([
    [{ delta: 'x', outputKind: 'answer_text', textOffset: 0 }],
    [{ delta: 'x', messageId: '', outputKind: 'answer_text', textOffset: 0 }],
    [{ delta: 'x', messageId: 'msg-1', outputKind: 'answer_text', textOffset: -1 }],
    [{ delta: 'x', messageId: 'msg-1', outputKind: 'answer_text', textOffset: 1.5 }],
    [{ delta: 3, messageId: 'msg-1', outputKind: 'answer_text', textOffset: 0 }],
  ])('rejects an invalid answer payload %j', (payload) => {
    expect(parseAnswerTextEvent(envelope(payload))).toEqual({ kind: 'invalid', reason: 'invalid_payload' });
  });

  it('rejects an envelope that claims answer text but breaks the envelope contract', () => {
    expect(
      parseAnswerTextEvent(envelope({ delta: 'x', messageId: 'm', outputKind: 'answer_text', textOffset: 0 }, { schemaVersion: '2.0.0' }))
    ).toEqual({ kind: 'invalid', reason: 'invalid_envelope' });
  });
});

describe('checkAnswerOwnership', () => {
  it('holds fragments until the run is known and rejects other threads or runs', () => {
    expect(checkAnswerOwnership(fragment(0, 'a'), {})).toBe('pending');
    expect(checkAnswerOwnership(fragment(0, 'a'), { threadId: 'thread-1', runId: 'run-1' })).toBe('owned');
    expect(checkAnswerOwnership(fragment(0, 'a'), { runId: 'run-2' })).toBe('foreign');
    expect(checkAnswerOwnership(fragment(0, 'a'), { threadId: 'thread-2', runId: 'run-1' })).toBe('foreign');
  });
});

describe('answerDraftReducer', () => {
  it('shows the first fragment at once and keeps whitespace and newlines', () => {
    const state = apply(initialAnswerDraftState, [fragment(0, '  第一段\n\n')]);
    expect(text(state)).toEqual(['  第一段\n\n']);
    expect(state.drafts[0]).toMatchObject({ status: 'streaming', messageId: 'msg-1' });
  });

  it('applies duplicates once, including partial overlaps', () => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'abc'), fragment(0, 'abc'), fragment(1, 'bc')]);
    expect(text(state)).toEqual(['abc']);
    state = apply(state, [fragment(2, 'cde')]);
    expect(text(state)).toEqual(['abcde']);
  });

  it.each(['one batch', 'separate batches'])('ignores a repeated eventId with a different offset in %s', (delivery) => {
    const first = fragment(0, 'A', { eventId: 'same-event-id' });
    const replay = fragment(1, 'B', { eventId: 'same-event-id' });
    const state = delivery === 'one batch'
      ? apply(initialAnswerDraftState, [first, replay])
      : apply(apply(initialAnswerDraftState, [first]), [replay]);

    expect(text(state)).toEqual(['A']);
  });

  it('still deduplicates identical content at the same offset with different eventIds', () => {
    const state = apply(initialAnswerDraftState, [
      fragment(0, 'A', { eventId: 'first-delivery' }),
      fragment(0, 'A', { eventId: 'replayed-content' }),
    ]);

    expect(text(state)).toEqual(['A']);
  });

  it('bounds eventId memory to 2048 entries and evicts in FIFO order without refreshing duplicates', () => {
    const maxSeenEventIds = 2_048;
    const first = fragment(0, 'A', { eventId: 'event-0' });
    let state = apply(initialAnswerDraftState, [first]);
    state = apply(state, Array.from({ length: maxSeenEventIds - 1 }, (_, index) =>
      fragment(1, '', { eventId: `event-${index + 1}` })
    ));
    expect(state.seenEventIds).toHaveLength(maxSeenEventIds);

    const beforeReplay = state;
    state = apply(state, [fragment(1, 'ignored', { eventId: first.eventId })]);
    expect(state).toBe(beforeReplay);
    expect(text(state)).toEqual(['A']);

    state = apply(state, [fragment(1, '', { eventId: 'overflow' })]);
    expect(state.seenEventIds).toHaveLength(maxSeenEventIds);
    expect(state.seenEventIds).not.toContain(first.eventId);
    expect(state.seenEventIds[0]).toBe('event-1');
    expect(beforeReplay.seenEventIds[0]).toBe(first.eventId);

    // The retained second id is still rejected; only the evicted first id may be accepted again.
    state = apply(state, [fragment(1, 'ignored', { eventId: 'event-1' })]);
    expect(text(state)).toEqual(['A']);
    state = apply(state, [fragment(1, 'B', { eventId: first.eventId })]);
    expect(text(state)).toEqual(['AB']);
    expect(state.seenEventIds).toHaveLength(maxSeenEventIds);
  });

  it('holds an out-of-order fragment and fills the gap when the missing one arrives', () => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'ab'), fragment(4, 'ef')], 10);
    expect(text(state)).toEqual(['ab']);
    expect(state.drafts[0]?.gapSince).toBe(10);
    state = apply(state, [fragment(2, 'cd')], 20);
    expect(text(state)).toEqual(['abcdef']);
    expect(state.drafts[0]?.gapSince).toBeUndefined();
  });

  it('keeps the provable prefix and waits for the final message when the gap window passes', () => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'ab'), fragment(4, 'ef')], 0);
    state = answerDraftReducer(state, { type: 'tick', now: 2_999, gapWaitMs: 3_000 });
    expect(state.drafts[0]?.status).toBe('streaming');
    state = answerDraftReducer(state, { type: 'tick', now: 3_001, gapWaitMs: 3_000 });
    expect(state.drafts[0]).toMatchObject({ status: 'awaiting_final', text: 'ab', pending: [] });
    state = apply(state, [fragment(2, 'cd')]);
    expect(text(state)).toEqual(['ab']);
  });

  it('stops at the provable prefix on conflicting content', () => {
    const state = apply(initialAnswerDraftState, [fragment(0, 'abc'), fragment(1, 'XY')]);
    expect(state.drafts[0]).toMatchObject({ text: 'abc', status: 'awaiting_final' });
  });

  it('lets the final message win and seals late fragments of the same id', () => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'draft')]);
    state = answerDraftReducer(state, { type: 'finalized', messageIds: ['msg-1'] });
    expect(state.drafts).toEqual([]);
    state = apply(state, [fragment(5, ' late')]);
    expect(state.drafts).toEqual([]);
    expect(state.sealed).toContain(answerDraftKey(fragment(0, '')));
  });

  it('retains eventId dedup when the final message arrives before the last fragment', () => {
    const first = fragment(0, 'draft');
    let state = apply(initialAnswerDraftState, [first]);
    state = answerDraftReducer(state, { type: 'finalized', messageIds: ['msg-1'] });
    state = apply(state, [
      fragment(5, ' late', { eventId: 'late-fragment' }),
      fragment(0, 'replayed', { messageId: 'msg-2', eventId: first.eventId }),
    ]);

    expect(state.drafts).toEqual([]);
    expect(state.sealed).toContain(answerDraftKey(first));
    expect(state.seenEventIds).toContain(first.eventId);
  });

  it('hides a draft in the same render once the final message id is present', () => {
    const state = apply(initialAnswerDraftState, [fragment(0, 'draft'), fragment(0, 'other', { messageId: 'msg-2' })]);
    expect(selectVisibleDrafts(state, new Set(['msg-1'])).map((draft) => draft.messageId)).toEqual(['msg-2']);
  });

  it.each([
    ['interrupted', 'interrupted'],
    ['timeout', 'timeout'],
    ['refused', 'refused'],
    ['cancelled', 'cancelled'],
    ['completed', 'awaiting_final'],
  ] as const)('ends the run as %s and drops later fragments', (outcome, status) => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'part')]);
    state = answerDraftReducer(state, { type: 'runEnded', runId: 'run-1', outcome });
    expect(state.drafts[0]).toMatchObject({ status, text: 'part' });
    state = apply(state, [fragment(4, 'late')]);
    expect(text(state)).toEqual(['part']);
  });

  it('replaces drafts of an older run when a new run starts, keeping their late fragments out', () => {
    let state = apply(initialAnswerDraftState, [fragment(0, 'old')]);
    state = answerDraftReducer(state, { type: 'runStarted', runId: 'run-2' });
    expect(state.drafts).toEqual([]);
    state = apply(state, [fragment(3, ' late'), fragment(0, 'new', { runId: 'run-2', messageId: 'msg-2' })]);
    expect(text(state)).toEqual(['new']);
  });

  it('retains eventId dedup and sealed drafts when another run replaces the current run', () => {
    const old = fragment(0, 'old', { eventId: 'old-event' });
    let state = apply(initialAnswerDraftState, [old]);
    state = answerDraftReducer(state, { type: 'runStarted', runId: 'run-2' });
    state = apply(state, [
      fragment(3, ' late', { eventId: 'late-old-event' }),
      fragment(0, 'replayed', { runId: 'run-2', messageId: 'msg-2', eventId: old.eventId }),
      fragment(0, 'new', { runId: 'run-2', messageId: 'msg-2', eventId: 'new-event' }),
    ]);

    expect(text(state)).toEqual(['new']);
    expect(state.sealed).toContain(answerDraftKey(old));
    expect(state.seenEventIds).toContain(old.eventId);
  });

  it('ignores a runEnded for another run', () => {
    const state = apply(initialAnswerDraftState, [fragment(0, 'part')]);
    expect(answerDraftReducer(state, { type: 'runEnded', runId: 'run-9', outcome: 'refused' })).toBe(state);
  });
});
