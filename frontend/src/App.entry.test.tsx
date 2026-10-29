import type { Message } from '@langchain/langgraph-sdk';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StreamOptions = {
  assistantId: string;
  onError?: (error: unknown) => void;
  onFinish?: (event: unknown) => void;
  onUpdateEvent?: (event: Record<string, unknown>) => void;
};

type DeepResearchProp = {
  enabled: boolean;
  locked: boolean;
  onChange: (enabled: boolean) => void;
};

const mocks = vi.hoisted(() => {
  return {
    options: undefined as StreamOptions | undefined,
    /** Each workspace mount owns one stream instance, and with it one SDK thread. */
    streamInstance: 0,
    nextInstance: 0,
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
    const [instance] = useState(() => ++mocks.nextInstance);
    mocks.streamInstance = instance;
    mocks.options = options;
    return mocks.thread;
  },
}));

function WorkspaceControls(props: {
  onSubmit: (input: string, effort: string, model: string, attachments: unknown[]) => void;
  deepResearch?: DeepResearchProp;
  onCancel: () => void;
}) {
  return (
    <>
      <button type="button" onClick={() => props.onSubmit('hello', 'medium', 'qwen-plus', [])}>
        send
      </button>
      <button
        type="button"
        onClick={() => props.onSubmit('請深入研究並比較退款政策', 'medium', 'qwen-plus', [])}
      >
        send-research-words
      </button>
      <button type="button" onClick={props.onCancel}>
        stop
      </button>
      {props.deepResearch && (
        <button
          type="button"
          role="switch"
          aria-checked={props.deepResearch.enabled}
          disabled={props.deepResearch.locked}
          onClick={() => props.deepResearch?.onChange(!props.deepResearch.enabled)}
        >
          深度研究
        </button>
      )}
    </>
  );
}

vi.mock('@/components/WelcomeScreen', () => ({
  WelcomeScreen: (props: {
    entry: { name: string };
    handleSubmit: (input: string, effort: string, model: string, attachments: unknown[]) => void;
    deepResearch?: DeepResearchProp;
    onCancel: () => void;
  }) => (
    <div data-testid="welcome-screen">
      <h2>{props.entry.name}</h2>
      <WorkspaceControls
        onSubmit={props.handleSubmit}
        deepResearch={props.deepResearch}
        onCancel={props.onCancel}
      />
    </div>
  ),
}));

vi.mock('@/components/ChatMessagesView', () => ({
  ChatMessagesView: (props: {
    messages: Message[];
    onSubmit: (input: string, effort: string, model: string, attachments: unknown[]) => void;
    onCancel: () => void;
    deepResearch?: DeepResearchProp;
    historicalActivities: Record<string, Array<{ title: string }>>;
    commercePanel?: ReactNode;
  }) => (
    <div data-testid="chat-view">
      {props.messages.map((message, index) => (
        <div key={message.id ?? index} data-testid="message">
          {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
        </div>
      ))}
      <div data-testid="historical-activity">
        {Object.entries(props.historicalActivities)
          .map(([id, events]) => `${id}:${events.map((event) => event.title).join('|')}`)
          .join(';')}
      </div>
      <WorkspaceControls
        onSubmit={props.onSubmit}
        deepResearch={props.deepResearch}
        onCancel={props.onCancel}
      />
      {props.commercePanel}
    </div>
  ),
}));

vi.mock('@/lib/agent-run-config', () => ({
  getAgentRunConfig: () => ({ max_research_loops: 1, initial_search_query_count: 1 }),
}));

import App from './App';

const DEADLINE = '2099-10-26T12:15:00.000Z';

function waitingApprovalThread() {
  mocks.thread.messages = [
    { type: 'human', content: '我要退款', id: 'human-1' } as Message,
    { type: 'ai', content: '請確認退款申請', id: 'ai-1' } as Message,
  ];
  mocks.thread.history = [
    {
      values: {
        operations: {
          'call-1': {
            toolCallId: 'call-1',
            operationId: 'approval-1',
            kind: 'refund_request',
            orderId: 'ORD-1001',
            state: 'awaiting_approval',
            stateVersion: 2,
            approvalExpiresAt: DEADLINE,
          },
        },
      },
    },
  ];
  mocks.thread.interrupt = {
    value: {
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
    },
  };
}

function enter(name: 'Gun Chat' | 'Gun Shop') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
}

function lastSubmission() {
  return mocks.thread.submit.mock.calls.at(-1);
}

function modeTrigger() {
  return screen.getByRole('button', { name: /切換模式/ });
}

function chooseMode(name: 'Gun Chat' | 'Gun Shop') {
  fireEvent.click(modeTrigger());
  fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(name) }));
}

describe('homepage', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
    mocks.options = undefined;
  });

  afterEach(() => {
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
    mocks.thread.isLoading = false;
  });

  it('shows the product title and two entries without starting a stream', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Chat Gun AI Agent' })).toBeInTheDocument();
    expect(screen.queryByText('ChatGun AI Agent')).not.toBeInTheDocument();
    expect(screen.getByText('Where would you like to begin?')).toBeInTheDocument();
    expect(screen.getByText('Try Chatting with It to Get an Answer')).toBeInTheDocument();
    // public/ files are served under the Vite base, never under a relative public/ path.
    const logoSrc = screen.getByRole('img', { name: 'Chat Logo' }).getAttribute('src');
    expect(logoSrc).toBe(`${import.meta.env.BASE_URL}logo-icon.svg`);
    expect(logoSrc).toMatch(/^\//);
    expect(logoSrc).not.toContain('public/');
    expect(screen.getByRole('button', { name: 'Gun Chat Generative AI Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gun Shop Shop AI Assistant' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /切換模式/ })).not.toBeInTheDocument();
    expect(mocks.options).toBeUndefined();
  });

  it('never stores the entry or the toggle in browser storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));
    chooseMode('Gun Shop');

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('returns to the homepage from the workspace', () => {
    render(<App />);
    enter('Gun Shop');
    fireEvent.click(screen.getByRole('button', { name: '回首頁' }));

    expect(screen.getByRole('heading', { name: 'Chat Gun AI Agent' })).toBeInTheDocument();
  });
});

describe('target assistant', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
  });

  afterEach(() => {
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
    mocks.thread.isLoading = false;
  });

  it('sends Gun Chat to chatbot by default, without deep research fields', () => {
    render(<App />);
    enter('Gun Chat');

    expect(mocks.options?.assistantId).toBe('chatbot');
    expect(screen.getByRole('switch', { name: '深度研究' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    const [input] = lastSubmission() ?? [];
    expect(input).toEqual({ kind: 'prompt', messages: [expect.objectContaining({ type: 'human' })] });
  });

  it('sends the next message to deep_researcher while the toggle is on', () => {
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));

    expect(mocks.options?.assistantId).toBe('deep_researcher');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    const [input] = lastSubmission() ?? [];
    expect(input).toMatchObject({ kind: 'prompt', reasoning_model: 'qwen-plus' });
  });

  it('ignores the wording of the message when choosing the target', () => {
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('button', { name: 'send-research-words' }));

    expect(mocks.options?.assistantId).toBe('chatbot');
    const [input] = lastSubmission() ?? [];
    expect(input).not.toHaveProperty('reasoning_model');
  });

  it('goes back to chatbot when the toggle is turned off again', () => {
    render(<App />);
    enter('Gun Chat');
    const toggle = screen.getByRole('switch', { name: '深度研究' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(mocks.options?.assistantId).toBe('chatbot');
  });

  it('sends Gun Shop to shopping_assistant and offers no toggle', () => {
    render(<App />);
    enter('Gun Shop');

    expect(mocks.options?.assistantId).toBe('shopping_assistant');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('deep research toggle in a conversation', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
  });

  afterEach(() => {
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
    mocks.thread.isLoading = false;
  });

  it('is locked while a run is active', () => {
    mocks.thread.messages = [{ type: 'human', content: 'Q', id: 'human-1' } as Message];
    mocks.thread.isLoading = true;
    render(<App />);
    enter('Gun Chat');

    expect(screen.getByRole('switch', { name: '深度研究' })).toBeDisabled();
    expect(modeTrigger()).toBeDisabled();
    expect(screen.getByRole('button', { name: '回首頁' })).toBeDisabled();
  });

  it('unlocks after the run finishes and keeps the thread and archived activity', () => {
    const { rerender } = render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));
    const instance = mocks.streamInstance;

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    act(() => {
      mocks.options?.onUpdateEvent?.({
        runtimeEvents: [{ type: 'agent.plan.start', title: 'Plan', ts: 1 }],
      });
    });
    mocks.thread.messages = [
      { type: 'human', content: 'Q', id: 'human-1' } as Message,
      { type: 'ai', content: 'A', id: 'ai-1' } as Message,
    ];
    rerender(<App />);
    act(() => {
      mocks.options?.onFinish?.({});
    });
    rerender(<App />);
    expect(screen.getByTestId('historical-activity')).toHaveTextContent('ai-1:Plan');

    const toggle = screen.getByRole('switch', { name: '深度研究' });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(mocks.options?.assistantId).toBe('chatbot');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(mocks.streamInstance).toBe(instance);
    expect(screen.getAllByTestId('message').map((node) => node.textContent)).toEqual(['Q', 'A']);
    expect(screen.getByTestId('historical-activity')).toHaveTextContent('ai-1:Plan');
  });

  it('is locked while a clarification reply is awaited', () => {
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    act(() => {
      mocks.options?.onUpdateEvent?.({
        __interrupt__: [
          {
            value: {
              type: 'weather_clarification',
              eventType: 'clarification_requested',
              interruptId: 'clarification:' + 'b'.repeat(64),
              weatherCapability: 'current',
              weatherExecution: {
                status: 'needs_clarification',
                result: {
                  schemaVersion: '1.0',
                  tool: 'current_weather',
                  status: 'needs_clarification',
                  requestedLocation: { raw: 'Springfield', location: 'Springfield' },
                  candidates: [
                    {
                      name: 'Springfield',
                      displayName: 'Springfield, Illinois, United States',
                      latitude: 39.78,
                      longitude: -89.65,
                    },
                  ],
                  message: 'Location is ambiguous.',
                  summary: 'Choose a location.',
                },
              },
            },
          },
        ],
      });
    });

    expect(screen.getByRole('switch', { name: '深度研究' })).toBeDisabled();
    // Leaving drops the clarification, so the mode switcher stays available.
    expect(modeTrigger()).toBeEnabled();
  });

  it('unlocks after the user cancels and stays unlocked when late events arrive', () => {
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(screen.getByRole('switch', { name: '深度研究' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(mocks.thread.stop).toHaveBeenCalled();
    expect(lastSubmission()?.[0]).toMatchObject({ kind: 'cancel' });
    act(() => {
      mocks.options?.onUpdateEvent?.({
        runtimeEvents: [{ type: 'agent.plan.start', title: 'Late', ts: 2 }],
      });
    });
    expect(screen.getByRole('switch', { name: '深度研究' })).toBeEnabled();
  });

  it('unlocks after an error ends the run', () => {
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(screen.getByRole('switch', { name: '深度研究' })).toBeDisabled();

    act(() => {
      mocks.options?.onError?.(new Error('boom'));
    });
    expect(screen.getByRole('switch', { name: '深度研究' })).toBeEnabled();
  });
});

describe('mode switcher', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
  });

  afterEach(() => {
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
    mocks.thread.isLoading = false;
  });

  it('shows the current mode and a menu of exactly the two entries', () => {
    render(<App />);
    enter('Gun Chat');

    expect(modeTrigger()).toHaveAccessibleName(/目前為 Gun Chat/);
    fireEvent.click(modeTrigger());
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      'Gun ChatGenerative AI Agent',
      'Gun ShopShop AI Assistant',
    ]);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(items[1]).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/math_agent|mcp_agent|Math Solver|MCP Agent/)).not.toBeInTheDocument();
  });

  it('closes with Escape and returns focus to the trigger', () => {
    render(<App />);
    enter('Gun Shop');
    fireEvent.click(modeTrigger());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(modeTrigger()).toHaveFocus();
  });

  it('starts a new session when another mode is chosen', () => {
    mocks.thread.messages = [
      { type: 'human', content: 'Q', id: 'human-1' } as Message,
      { type: 'ai', content: 'A', id: 'ai-1' } as Message,
    ];
    render(<App />);
    enter('Gun Chat');
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));
    const firstInstance = mocks.streamInstance;

    chooseMode('Gun Shop');
    expect(mocks.streamInstance).not.toBe(firstInstance);
    expect(mocks.options?.assistantId).toBe('shopping_assistant');

    const shopInstance = mocks.streamInstance;
    chooseMode('Gun Chat');
    expect(mocks.streamInstance).not.toBe(shopInstance);
    expect(screen.getByRole('switch', { name: '深度研究' })).toHaveAttribute('aria-checked', 'false');
    expect(mocks.options?.assistantId).toBe('chatbot');
  });

  it('keeps the session when the current mode is chosen', () => {
    render(<App />);
    enter('Gun Shop');
    const instance = mocks.streamInstance;

    chooseMode('Gun Shop');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mocks.streamInstance).toBe(instance);
  });

  it('keeps the rate limit countdown across modes', () => {
    render(<App />);
    enter('Gun Chat');
    act(() => {
      mocks.options?.onError?.({ error: 'rate_limited', retryAfter: 30 });
    });

    chooseMode('Gun Shop');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(mocks.thread.submit).not.toHaveBeenCalled();
  });
});

describe('leaving with a pending approval', () => {
  beforeEach(() => {
    mocks.thread.submit.mockReset();
  });

  afterEach(() => {
    mocks.thread.messages = [];
    mocks.thread.history = [];
    mocks.thread.interrupt = undefined;
    mocks.thread.isLoading = false;
  });

  it('asks first and stays with the card unchanged when the user cancels', () => {
    waitingApprovalThread();
    render(<App />);
    enter('Gun Shop');
    const instance = mocks.streamInstance;

    chooseMode('Gun Chat');
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('待審批的操作不會帶到新對話');
    fireEvent.click(within(dialog).getByRole('button', { name: '留在這裡' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.streamInstance).toBe(instance);
    expect(screen.getByTestId('operation-call-1')).toHaveTextContent('等待審批');
    expect(screen.getByRole('button', { name: '核准' })).toBeEnabled();
    expect(mocks.thread.submit).not.toHaveBeenCalled();
  });

  it('leaves without sending any decision once the user confirms', () => {
    waitingApprovalThread();
    render(<App />);
    enter('Gun Shop');

    fireEvent.click(screen.getByRole('button', { name: '回首頁' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: '確認離開' })
    );

    expect(screen.getByRole('heading', { name: 'Chat Gun AI Agent' })).toBeInTheDocument();
    expect(mocks.thread.submit).not.toHaveBeenCalled();
  });

  it('cannot leave while an approval decision is being sent', () => {
    waitingApprovalThread();
    render(<App />);
    enter('Gun Shop');

    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    expect(screen.getByRole('button', { name: '回首頁' })).toBeDisabled();
    expect(modeTrigger()).toBeDisabled();
  });
});
