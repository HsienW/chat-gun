import type { Message } from '@langchain/langgraph-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    thread: {
      messages: [] as Message[],
      isLoading: false,
      submit: vi.fn(),
      stop: vi.fn(),
    },
  };
});

vi.mock('@langchain/langgraph-sdk/react', () => ({
  useStream: () => mocks.thread,
}));

vi.mock('@/components/WelcomeScreen', () => ({
  WelcomeScreen: (props: {
    handleSubmit: (
      input: string,
      effort: string,
      model: string,
      agentId: string,
      attachments: unknown[]
    ) => void;
    isLoading: boolean;
    onCancel: () => void;
  }) => (
    <div data-testid="welcome-screen">
      <div data-testid="welcome-loading">{props.isLoading ? 'loading' : 'idle'}</div>
      <button type="button" onClick={props.onCancel}>
        cancel
      </button>
      <button
        type="button"
        onClick={() =>
          props.handleSubmit('next question', 'standard', 'test-model', 'deep_researcher', [])
        }
      >
        submit
      </button>
    </div>
  ),
}));

vi.mock('@/components/ChatMessagesView', () => ({
  ChatMessagesView: (props: {
    messages: Message[];
    isLoading: boolean;
    onCancel: () => void;
    onSubmit: (
      input: string,
      effort: string,
      model: string,
      agentId: string,
      attachments: unknown[]
    ) => void;
  }) => (
    <div data-testid="chat-view">
      <div data-testid="activity-bubble">{props.isLoading ? 'loading' : 'idle'}</div>
      {props.messages.map((message, index) => (
        <div key={message.id ?? index} data-testid={`message-${index}`}>
          {typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content)}
        </div>
      ))}
      <button type="button" onClick={props.onCancel}>
        cancel
      </button>
      <button
        type="button"
        onClick={() =>
          props.onSubmit('next question', 'standard', 'test-model', 'deep_researcher', [])
        }
      >
        submit-next
      </button>
    </div>
  ),
}));

vi.mock('@/lib/agent-runtime-events', () => ({
  extractAgentRuntimeEvents: () => [],
  runtimeEventToProcessedEvent: (event: unknown) => event,
}));

vi.mock('@/lib/agent-run-config', () => ({
  getAgentRunConfig: () => ({}),
}));

import App from './App';

describe('App cancel handling', () => {
  beforeEach(() => {
    mocks.thread.messages = [];
    mocks.thread.isLoading = false;
    mocks.thread.submit.mockClear();
    mocks.thread.stop.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a terminal assistant bubble after cancelling a loading response', () => {
    mocks.thread.messages = [
      { type: 'human', content: 'Tokyo weather now', id: 'human-1' } as Message,
    ];
    mocks.thread.isLoading = true;

    const { rerender } = render(<App />);

    expect(screen.getByTestId('activity-bubble')).toHaveTextContent('loading');

    fireEvent.click(screen.getByText('cancel'));
    expect(mocks.thread.stop).toHaveBeenCalledTimes(1);
    expect(mocks.thread.submit).toHaveBeenCalledWith(
      { kind: 'cancel' },
      expect.objectContaining({
        config: {
          configurable: {
            clientInteractionMetadata: expect.objectContaining({
              inputKind: 'cancel',
            }),
          },
        },
      })
    );

    mocks.thread.isLoading = false;
    rerender(<App />);

    expect(screen.getByTestId('activity-bubble')).toHaveTextContent('idle');
    expect(screen.getByText('已取消本次回覆。')).toBeInTheDocument();
  });

  it('clears the live cancel placeholder on the next submit', () => {
    mocks.thread.messages = [
      { type: 'human', content: 'Tokyo weather now', id: 'human-1' } as Message,
    ];
    mocks.thread.isLoading = true;

    const { rerender } = render(<App />);

    fireEvent.click(screen.getByText('cancel'));
    mocks.thread.isLoading = false;
    rerender(<App />);

    expect(screen.getByText('已取消本次回覆。')).toBeInTheDocument();

    fireEvent.click(screen.getByText('submit-next'));

    expect(screen.queryByText('已取消本次回覆。')).not.toBeInTheDocument();
    expect(mocks.thread.submit).toHaveBeenCalledTimes(2);
  });
});
