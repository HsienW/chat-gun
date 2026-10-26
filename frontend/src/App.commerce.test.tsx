import type { Message } from '@langchain/langgraph-sdk';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StreamOptions = {
  onError?: (error: unknown) => void;
  onFinish?: (event: unknown) => void;
  onUpdateEvent?: (event: Record<string, unknown>) => void;
};

const mocks = vi.hoisted(() => {
  return {
    options: undefined as StreamOptions | undefined,
    thread: {
      messages: [] as Message[],
      isLoading: false,
      submit: vi.fn(),
      stop: vi.fn(),
      history: [] as { values: Record<string, unknown> }[],
      interrupt: undefined as { value: unknown } | undefined,
    },
  };
});

vi.mock('@langchain/langgraph-sdk/react', () => ({
  useStream: (options: StreamOptions) => {
    mocks.options = options;
    return mocks.thread;
  },
}));

vi.mock('@/components/WelcomeScreen', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

vi.mock('@/components/ChatMessagesView', () => ({
  ChatMessagesView: (props: { commercePanel?: ReactNode }) => (
    <div data-testid="chat-view">{props.commercePanel}</div>
  ),
}));

import App from './App';

const DEADLINE = '2099-10-26T12:15:00.000Z';

const waitingOperation = {
  toolCallId: 'call-1',
  operationId: 'approval-1',
  kind: 'refund_request',
  orderId: 'ORD-1001',
  state: 'awaiting_approval',
  stateVersion: 2,
  approvalExpiresAt: DEADLINE,
};

const interruptValue = {
  type: 'tool_authorization_confirmation',
  schemaVersion: '1.0',
  approvalId: 'approval-1',
  decisionId: 'decision-1',
  expiresAt: DEADLINE,
  resumeCompatibility: {
    type: 'tool_authorization_confirmation',
    schemaVersion: '1.0',
    decisions: ['approve', 'deny'],
  },
};

function cardEnvelope(sequence: number, runId: string, data: Record<string, unknown>) {
  return {
    schemaVersion: '1.0.0',
    eventId: `${runId}:card:${sequence}`,
    sequence,
    type: 'card.emit',
    emittedAt: '2026-10-26T12:00:00.000Z',
    context: {
      requestId: 'request-1',
      threadId: 'thread-1',
      runId,
      taskId: 'task-1',
      stepId: 'step-1',
      attempt: 1,
      principalId: 'synthetic-shopper-a',
      tenantId: 'synthetic-tenant',
      scopeId: 'synthetic-tenant',
      scopeType: 'tenant',
    },
    payload: { cardType: 'order_operation_status', data },
  };
}

function reloadedWaitingThread() {
  mocks.thread.messages = [
    { type: 'human', content: '我要退款', id: 'human-1' } as Message,
    { type: 'ai', content: '請確認退款申請', id: 'ai-1' } as Message,
  ];
  mocks.thread.history = [{ values: { operations: { 'call-1': waitingOperation } } }];
  mocks.thread.interrupt = { value: interruptValue };
}

describe('App commerce approval', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
    mocks.thread.stop.mockReset();
  });

  afterEach(() => {
    mocks.options = undefined;
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
  });

  it('restores a waiting approval from the server thread state after a reload', () => {
    reloadedWaitingThread();

    render(<App />);

    expect(screen.getByTestId('operation-call-1')).toHaveTextContent('等待審批');
    expect(screen.getByRole('button', { name: '核准' })).toBeEnabled();
  });

  it('sends one approval resume with the server approval identifiers', () => {
    reloadedWaitingThread();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    fireEvent.click(screen.getByRole('button', { name: '核准' }));

    expect(mocks.thread.submit).toHaveBeenCalledTimes(1);
    const [input, options] = mocks.thread.submit.mock.calls[0] ?? [];
    expect(input).toBeNull();
    expect(options.command).toEqual({
      resume: {
        type: 'tool_authorization_confirmation',
        schemaVersion: '1.0',
        approvalId: 'approval-1',
        decisionId: 'decision-1',
        decision: 'approve',
      },
    });
    expect(options.config.configurable.clientInteractionMetadata).toMatchObject({
      requestId: expect.any(String),
      idempotencyKey: expect.any(String),
    });
    expect(screen.queryByText('已確認')).toBeNull();
  });

  it('shows a typed error and keeps the approval open when the resume fails', () => {
    reloadedWaitingThread();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    act(() => {
      mocks.options?.onError?.({
        error: {
          source: 'bff',
          stage: 'proxy',
          code: 'upstream_timeout',
          message: 'timeout',
        },
      });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('upstream_timeout');
    expect(screen.getByRole('button', { name: '核准' })).toBeEnabled();
    expect(screen.getByTestId('operation-call-1')).toHaveTextContent('等待審批');
  });

  it('sends the existing cancel input for the waiting run', () => {
    mocks.thread.messages = [{ type: 'ai', content: '請確認', id: 'ai-1' } as Message];
    mocks.thread.interrupt = { value: interruptValue };
    render(<App />);

    act(() => {
      mocks.options?.onUpdateEvent?.({
        order_request: {
          runtimeEvents: [
            cardEnvelope(1, 'run-waiting', {
              schemaVersion: 'order_operation_status@1',
              operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
              kind: 'refund_request',
              orderRef: { orderId: 'ORD-1001' },
              state: 'awaiting_approval',
              stateVersion: 2,
              approvalExpiresAt: DEADLINE,
            }),
          ],
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '取消申請' }));

    expect(mocks.thread.stop).not.toHaveBeenCalled();
    expect(mocks.thread.submit).toHaveBeenCalledTimes(1);
    const [input, options] = mocks.thread.submit.mock.calls[0] ?? [];
    expect(input).toEqual({ kind: 'cancel', targetRunId: 'run-waiting' });
    expect(options.config.configurable.clientInteractionMetadata).toMatchObject({
      inputKind: 'cancel',
    });
  });

  it('keeps a confirmed operation when a late executing card arrives', () => {
    mocks.thread.messages = [{ type: 'ai', content: '處理中', id: 'ai-1' } as Message];
    render(<App />);
    const status = (state: string, stateVersion: number) => ({
      schemaVersion: 'order_operation_status@1',
      operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
      kind: 'refund_request',
      orderRef: { orderId: 'ORD-1001' },
      state,
      stateVersion,
    });

    act(() => {
      mocks.options?.onUpdateEvent?.({
        order_present: {
          runtimeEvents: [
            cardEnvelope(1, 'run-2', status('confirmed', 5)),
            cardEnvelope(2, 'run-2', status('executing', 4)),
          ],
        },
      });
    });

    const card = screen.getByTestId('operation-call-1');
    expect(card).toHaveTextContent('已確認');
    expect(card).not.toHaveTextContent('執行中');
  });
});
