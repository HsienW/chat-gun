import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAnswerTextStream, type FrameScheduler } from '@/lib/use-answer-text-stream';

function envelope(textOffset: number, delta: string, runId = 'run-1') {
  return {
    schemaVersion: '1.0.0',
    eventId: `${runId}:${textOffset}`,
    sequence: textOffset + 1,
    type: 'model.stream',
    emittedAt: '2026-11-15T00:00:00.000Z',
    context: {
      requestId: 'request-1',
      threadId: 'thread-1',
      runId,
      taskId: 'task-1',
      attempt: 1,
      principalId: 'principal-1',
      tenantId: 'tenant-1',
      scopeId: 'tenant-1',
      scopeType: 'tenant',
    },
    payload: { delta, messageId: 'msg-1', outputKind: 'answer_text', textOffset },
  };
}

/** A frame scheduler the test drives by hand. */
function manualFrames() {
  const queue: Array<() => void> = [];
  const cancelled = vi.fn();
  const frames: FrameScheduler = (callback) => {
    queue.push(callback);
    return () => {
      cancelled();
      queue.splice(queue.indexOf(callback), 1);
    };
  };
  const paint = () => act(() => queue.splice(0).forEach((callback) => callback()));
  return { frames, paint, pending: () => queue.length, cancelled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useAnswerTextStream', () => {
  it('merges fragments received between two frames into one draw', () => {
    const { frames, paint, pending } = manualFrames();
    const onBeforeFrame = vi.fn();
    const { result } = renderHook(() => useAnswerTextStream({ frames, onBeforeFrame }));

    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
      result.current.onCustomEvent(envelope(0, '你'));
      result.current.onCustomEvent(envelope(1, '好'));
    });
    expect(pending()).toBe(1);
    expect(result.current.state.drafts).toEqual([]);

    paint();
    expect(onBeforeFrame).toHaveBeenCalledTimes(1);
    expect(result.current.state.drafts[0]?.text).toBe('你好');
  });

  it.each(['one frame', 'separate frames'])('ignores a repeated eventId with a different offset across %s', (delivery) => {
    const { frames, paint } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames }));
    const first = envelope(0, 'A');
    const replay = { ...envelope(1, 'B'), eventId: first.eventId };

    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
      result.current.onCustomEvent(first);
    });
    if (delivery === 'separate frames') paint();
    act(() => result.current.onCustomEvent(replay));
    paint();

    expect(result.current.state.drafts[0]?.text).toBe('A');
  });

  it('deduplicates repeated eventIds held before ownership metadata arrives', () => {
    const { frames, paint } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames }));
    const first = envelope(0, 'A');

    act(() => {
      result.current.onCustomEvent(first);
      result.current.onCustomEvent({ ...envelope(1, 'B'), eventId: first.eventId });
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
    });
    paint();

    expect(result.current.state.drafts[0]?.text).toBe('A');
  });

  it('holds fragments that arrive before the run metadata, then applies them', () => {
    const { frames, paint } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames }));

    act(() => result.current.onCustomEvent(envelope(0, 'early')));
    paint();
    expect(result.current.state.drafts).toEqual([]);

    act(() => result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' }));
    paint();
    expect(result.current.state.drafts[0]?.text).toBe('early');
  });

  it('ignores fragments of another run', () => {
    const { frames, paint } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames }));

    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-2', thread_id: 'thread-1' });
      result.current.onCustomEvent(envelope(0, 'stale', 'run-1'));
    });
    paint();
    expect(result.current.state.drafts).toEqual([]);
  });

  it('applies queued fragments before sealing the run on endRun', () => {
    const { frames, pending, cancelled } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames }));

    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
      result.current.onCustomEvent(envelope(0, 'part'));
      result.current.endRun('interrupted');
    });

    expect(cancelled).toHaveBeenCalled();
    expect(pending()).toBe(0);
    expect(result.current.state.drafts[0]).toMatchObject({ text: 'part', status: 'interrupted' });
    act(() => result.current.onCustomEvent(envelope(4, ' late')));
    expect(result.current.state.drafts[0]?.text).toBe('part');
  });

  it('expires a gap after the bounded wait and stops ticking afterwards', () => {
    vi.useFakeTimers();
    let clock = 0;
    const { frames, paint } = manualFrames();
    const { result } = renderHook(() => useAnswerTextStream({ frames, gapWaitMs: 1_000, now: () => clock }));

    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
      result.current.onCustomEvent(envelope(0, 'ab'));
      result.current.onCustomEvent(envelope(5, 'late'));
    });
    paint();
    expect(result.current.state.drafts[0]?.gapSince).toBe(0);

    clock = 1_200;
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.drafts[0]).toMatchObject({ status: 'awaiting_final', text: 'ab' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a scheduled frame on unmount', () => {
    const { frames, cancelled } = manualFrames();
    const { result, unmount } = renderHook(() => useAnswerTextStream({ frames }));
    act(() => {
      result.current.onMetadataEvent({ run_id: 'run-1', thread_id: 'thread-1' });
      result.current.onCustomEvent(envelope(0, 'x'));
    });
    unmount();
    expect(cancelled).toHaveBeenCalled();
  });
});
