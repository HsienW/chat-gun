import type { Message } from '@langchain/langgraph-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRONTEND_ERROR_MESSAGES } from '@/lib/error-messages';

type StreamOptions = {
  onError?: (error: unknown) => void;
  onFinish?: (event: unknown) => void;
  onUpdateEvent?: (event: Record<string, unknown>) => void;
  onCustomEvent?: (data: unknown, options: unknown) => void;
  onMetadataEvent?: (data: { run_id: string; thread_id: string }) => void;
};

const mocks = vi.hoisted(() => ({
  options: undefined as StreamOptions | undefined,
  thread: { messages: [] as Message[], isLoading: true, submit: vi.fn(), stop: vi.fn() },
}));

vi.mock('@langchain/langgraph-sdk/react', () => ({
  useStream: (options: StreamOptions) => {
    mocks.options = options;
    return mocks.thread;
  },
}));

vi.mock('@/components/ChatMessagesView', () => ({
  ChatMessagesView: (props: {
    messages: Message[];
    liveActivityEvents: Array<{ title: string }>;
    answerStreamNotices?: Record<string, string>;
    deepResearch?: { onChange: (enabled: boolean) => void };
    onSubmit: (input: string, effort: string, model: string, attachments: unknown[]) => void;
    regenerableAnswerIds?: ReadonlySet<string>;
    onRegenerateAnswer?: () => void;
  }) => (
    <div data-testid="chat-view">
      <button type="button" onClick={() => props.deepResearch?.onChange(true)}>
        deep-research-on
      </button>
      <button type="button" onClick={() => props.onSubmit('next question', 'standard', 'test-model', [])}>
        submit-next
      </button>
      <div data-testid="live-activity">{props.liveActivityEvents.map((event) => event.title).join('|')}</div>
      {props.messages.map((message, index) => (
        <div key={message.id ?? index} data-testid={`message-${message.id ?? index}`}>
          {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
          {message.id && props.answerStreamNotices?.[message.id] ? (
            <span role="status">{props.answerStreamNotices[message.id]}</span>
          ) : null}
          {message.id && props.regenerableAnswerIds?.has(message.id) ? (
            <button type="button" onClick={props.onRegenerateAnswer}>
              regenerate
            </button>
          ) : null}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/lib/agent-run-config', () => ({ getAgentRunConfig: () => ({}) }));

import App from './App';

const human = { type: 'human', content: 'Question', id: 'human-1' } as Message;

function answerEnvelope(textOffset: number, delta: string, runId = 'run-1') {
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

function runError(code: string, causeCode?: string) {
  return new Error(
    JSON.stringify({
      error: { source: 'backend', stage: 'chat_response', code, message: code, ...(causeCode ? { cause: { code: causeCode } } : {}) },
    })
  );
}

function renderChat() {
  const result = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Gun Chat/ }));
  return result;
}

function startRun(runId = 'run-1') {
  act(() => mocks.options?.onMetadataEvent?.({ run_id: runId, thread_id: 'thread-1' }));
}

function emitAnswer(textOffset: number, delta: string, runId = 'run-1') {
  act(() => mocks.options?.onCustomEvent?.(answerEnvelope(textOffset, delta, runId), {}));
}

describe('App answer text streaming (Task 6)', () => {
  beforeEach(() => {
    mocks.options = undefined;
    mocks.thread.messages = [human];
    mocks.thread.isLoading = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the first fragment, appends to the same bubble and lets the final message replace it', async () => {
    const { rerender } = renderChat();
    startRun();
    emitAnswer(0, '你好');
    expect(await screen.findByText('你好')).toBeTruthy();

    emitAnswer(2, '，世界');
    expect(await screen.findByText('你好，世界')).toBeTruthy();
    expect(screen.getAllByTestId('message-msg-1')).toHaveLength(1);

    mocks.thread.messages = [human, { type: 'ai', content: '你好，世界！', id: 'msg-1' } as Message];
    mocks.thread.isLoading = false;
    rerender(<App />);
    act(() => mocks.options?.onFinish?.({}));

    expect(screen.getAllByTestId('message-msg-1')).toHaveLength(1);
    expect(screen.getByTestId('message-msg-1').textContent).toBe('你好，世界！');
  });

  it('retracts the fragments of a refused answer and shows only the catalog refusal', async () => {
    renderChat();
    startRun();
    emitAnswer(0, 'draft that gets refused');
    expect(await screen.findByText('draft that gets refused')).toBeTruthy();

    act(() => mocks.options?.onError?.(runError('answer_stream_refused')));

    expect(screen.getByTestId('message-msg-1').textContent).toBe(FRONTEND_ERROR_MESSAGES.answerStream.refused);
    expect(screen.queryByText('draft that gets refused')).toBeNull();
    expect(screen.queryByTestId('message-stream-error')).toBeNull();
  });

  it('keeps the fragments of a timed-out answer and marks them with the timeout notice', async () => {
    renderChat();
    startRun();
    emitAnswer(0, 'partial answer');
    expect(await screen.findByText('partial answer')).toBeTruthy();

    act(() => mocks.options?.onError?.(runError('answer_stream_interrupted', 'answer_stream_idle_timeout')));

    expect(screen.getByTestId('message-msg-1').textContent).toContain('partial answer');
    expect(screen.getByRole('status').textContent).toBe(FRONTEND_ERROR_MESSAGES.answerStream.timeout);
    expect(screen.queryByTestId('message-stream-error')).toBeNull();
    // Late fragments after the terminal error never reopen the bubble.
    emitAnswer(14, ' late');
    expect(screen.getByTestId('message-msg-1').textContent).not.toContain('late');
  });

  it('marks an interruption without a timeout cause as interrupted', async () => {
    renderChat();
    startRun();
    emitAnswer(0, 'partial');
    await screen.findByText('partial');

    act(() => mocks.options?.onError?.(runError('answer_stream_interrupted', 'provider_unavailable')));

    expect(screen.getByRole('status').textContent).toBe(FRONTEND_ERROR_MESSAGES.answerStream.interrupted);
  });

  it('shows the catalog copy as the error bubble when the run fails before any text', () => {
    renderChat();
    startRun();
    act(() => mocks.options?.onError?.(runError('answer_stream_refused')));

    expect(screen.getByTestId('message-stream-error').textContent).toBe(FRONTEND_ERROR_MESSAGES.answerStream.refused);
  });

  it('ignores fragments of a run the stream metadata did not name', async () => {
    renderChat();
    startRun('run-2');
    emitAnswer(0, 'stale run text', 'run-1');
    emitAnswer(0, 'current', 'run-2');
    expect(await screen.findByText('current')).toBeTruthy();
    expect(screen.queryByText('stale run text')).toBeNull();
  });

  it('offers a user-triggered regeneration for an interrupted draft that resends the last question as a new run', async () => {
    renderChat();
    startRun();
    emitAnswer(0, 'partial');
    await screen.findByText('partial');
    act(() => mocks.options?.onError?.(new TypeError('network connection lost')));
    mocks.thread.isLoading = false;
    mocks.thread.submit.mockClear();

    expect(screen.getByRole('status').textContent).toBe(FRONTEND_ERROR_MESSAGES.answerStream.interrupted);
    fireEvent.click(screen.getByText('regenerate'));

    expect(mocks.thread.submit).toHaveBeenCalledTimes(1);
    expect(mocks.thread.submit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'prompt',
      messages: [expect.objectContaining({ type: 'human', content: 'Question' })],
    });
  });

  it('offers no regeneration for a refused answer', async () => {
    renderChat();
    startRun();
    emitAnswer(0, 'refused draft');
    await screen.findByText('refused draft');
    act(() => mocks.options?.onError?.(runError('answer_stream_refused')));
    expect(screen.queryByText('regenerate')).toBeNull();
  });

  it('offers no regeneration when the last question carries attachments', async () => {
    mocks.thread.messages = [
      { type: 'human', id: 'human-1', content: [{ type: 'text', text: 'Q' }, { type: 'image_url', image_url: { url: 'data:,' } }] } as Message,
    ];
    renderChat();
    startRun();
    emitAnswer(0, 'partial');
    await screen.findByText('partial');
    act(() => mocks.options?.onError?.(runError('answer_stream_interrupted', 'provider_unavailable')));
    expect(screen.queryByText('regenerate')).toBeNull();
  });

  it('keeps answer text out of the activity timeline for timeline agents', () => {
    renderChat();
    fireEvent.click(screen.getByText('deep-research-on'));
    fireEvent.click(screen.getByText('submit-next'));
    act(() => mocks.options?.onUpdateEvent?.({ runtimeEvents: [answerEnvelope(0, 'answer in updates')] }));
    expect(screen.getByTestId('live-activity').textContent).toBe('');

    // Control: the same envelope without answer_text is ordinary activity and still shows,
    // and the skipped answer event did not consume its sequence in the activity buffer.
    const activity = answerEnvelope(0, 'activity delta');
    act(() =>
      mocks.options?.onUpdateEvent?.({
        runtimeEvents: [{ ...activity, eventId: 'activity-1', payload: { delta: 'activity delta' } }],
      })
    );
    expect(screen.getByTestId('live-activity').textContent).not.toBe('');
  });
});
