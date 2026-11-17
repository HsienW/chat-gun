import { useCallback, useEffect, useReducer, useRef } from 'react';

import {
  ANSWER_DRAFT_GAP_WAIT_MS,
  answerDraftReducer,
  checkAnswerOwnership,
  hasGapWaitingDraft,
  initialAnswerDraftState,
  parseAnswerTextEvent,
  type AnswerFragment,
  type AnswerOwnership,
  type AnswerRunOutcome,
} from '@/lib/answer-text-stream';

const MAX_UNOWNED_FRAGMENTS = 64;
const GAP_TICK_MS = 250;

/** Schedules one callback for the next paint and returns its cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

const browserFrames: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
};

export type UseAnswerTextStreamOptions = {
  gapWaitMs?: number;
  frames?: FrameScheduler;
  now?: () => number;
  /** Called once per drawn frame, before the merged fragments are applied. */
  onBeforeFrame?: () => void;
};

/**
 * Wires the SDK custom and metadata callbacks to the answer draft reducer. Fragments arriving
 * between two frames are applied together; every timer and frame is released on unmount.
 */
export function useAnswerTextStream(options: UseAnswerTextStreamOptions = {}) {
  const [state, dispatch] = useReducer(answerDraftReducer, initialAnswerDraftState);
  const gapWaitMs = options.gapWaitMs ?? ANSWER_DRAFT_GAP_WAIT_MS;
  const frames = options.frames ?? browserFrames;
  const now = options.now ?? Date.now;
  const ownerRef = useRef<AnswerOwnership>({});
  const queuedRef = useRef<AnswerFragment[]>([]);
  const unownedRef = useRef<AnswerFragment[]>([]);
  const cancelFrameRef = useRef<(() => void) | undefined>(undefined);
  const mountedRef = useRef(true);
  const onBeforeFrameRef = useRef(options.onBeforeFrame);
  onBeforeFrameRef.current = options.onBeforeFrame;

  const flush = useCallback(() => {
    cancelFrameRef.current = undefined;
    if (!mountedRef.current || queuedRef.current.length === 0) return;
    const fragments = queuedRef.current;
    queuedRef.current = [];
    onBeforeFrameRef.current?.();
    dispatch({ type: 'fragments', fragments, now: now() });
  }, [now]);

  const enqueue = useCallback(
    (fragment: AnswerFragment) => {
      queuedRef.current.push(fragment);
      if (cancelFrameRef.current === undefined) cancelFrameRef.current = frames(flush);
    },
    [flush, frames]
  );

  const accept = useCallback(
    (fragment: AnswerFragment) => {
      const ownership = checkAnswerOwnership(fragment, ownerRef.current);
      if (ownership === 'owned') {
        enqueue(fragment);
        return;
      }
      if (ownership === 'pending') {
        // Bounded hold until the stream's metadata names the run.
        if (unownedRef.current.length < MAX_UNOWNED_FRAGMENTS) unownedRef.current.push(fragment);
        return;
      }
      console.info({ code: 'answer.stream.foreign_ignored', runId: fragment.runId });
    },
    [enqueue]
  );

  const onCustomEvent = useCallback(
    (data: unknown) => {
      const result = parseAnswerTextEvent(data);
      if (result.kind === 'fragment') accept(result.fragment);
      else if (result.kind === 'invalid') console.info({ code: 'answer.stream.invalid', reason: result.reason });
    },
    [accept]
  );

  const onMetadataEvent = useCallback(
    (data: { run_id?: unknown; thread_id?: unknown }) => {
      if (typeof data.run_id !== 'string' || data.run_id.length === 0) return;
      ownerRef.current = {
        runId: data.run_id,
        ...(typeof data.thread_id === 'string' && data.thread_id ? { threadId: data.thread_id } : {}),
      };
      dispatch({ type: 'runStarted', runId: data.run_id });
      const held = unownedRef.current;
      unownedRef.current = [];
      held.forEach(accept);
    },
    [accept]
  );

  /** Seals the current run: no fragment, final or old generation may write into it afterwards. */
  const endRun = useCallback(
    (outcome: AnswerRunOutcome) => {
      const runId = ownerRef.current.runId;
      unownedRef.current = [];
      cancelFrameRef.current?.();
      cancelFrameRef.current = undefined;
      // Fragments already received are applied before the run is sealed.
      if (queuedRef.current.length > 0) {
        const fragments = queuedRef.current;
        queuedRef.current = [];
        dispatch({ type: 'fragments', fragments, now: now() });
      }
      if (runId) dispatch({ type: 'runEnded', runId, outcome });
    },
    [now]
  );

  const finalize = useCallback((messageIds: readonly string[]) => {
    if (messageIds.length > 0) dispatch({ type: 'finalized', messageIds });
  }, []);

  const waitingForGap = hasGapWaitingDraft(state);
  useEffect(() => {
    if (!waitingForGap) return;
    const timer = setInterval(() => dispatch({ type: 'tick', now: now(), gapWaitMs }), GAP_TICK_MS);
    return () => clearInterval(timer);
  }, [gapWaitMs, now, waitingForGap]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelFrameRef.current?.();
      cancelFrameRef.current = undefined;
      queuedRef.current = [];
      unownedRef.current = [];
    };
  }, [frames]);

  return { state, onCustomEvent, onMetadataEvent, endRun, finalize };
}
