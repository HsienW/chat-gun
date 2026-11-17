import type { Message } from '@langchain/langgraph-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChatMessagesView } from '@/components/ChatMessagesView';
import { FRONTEND_ERROR_MESSAGES } from '@/lib/error-messages';
import { AgentId } from '@/types/agents';

function renderView(
  messages: Message[],
  answerStreamNotices?: Record<string, string>,
  regeneration?: { ids: ReadonlySet<string>; onRegenerate: () => void; isLoading?: boolean }
) {
  return render(
    <ChatMessagesView
      messages={messages}
      isLoading={regeneration?.isLoading ?? true}
      regenerableAnswerIds={regeneration?.ids}
      onRegenerateAnswer={regeneration?.onRegenerate}
      scrollAreaRef={createRef<HTMLDivElement>()}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      liveActivityEvents={[]}
      historicalActivities={{}}
      targetAgentId={AgentId.CHATBOT}
      onNewConversation={vi.fn()}
      newConversationDisabled
      answerStreamNotices={answerStreamNotices}
    />
  );
}

const human = { type: 'human', content: 'Question', id: 'human-1' } as Message;

describe('ChatMessagesView answer draft rendering', () => {
  it('renders a draft through the same Markdown renderer, including an unclosed code fence', () => {
    renderView([human, { type: 'ai', id: 'msg-1', content: '**粗體** 與程式碼：\n\n```ts\nconst a = 1;' } as Message]);

    expect(screen.getByText('粗體').tagName).toBe('STRONG');
    expect(screen.getByText('const a = 1;')).toBeTruthy();
  });

  it('shows the catalog notice of an ended draft as a status under its own bubble', () => {
    renderView([human, { type: 'ai', id: 'msg-1', content: 'partial' } as Message], { 'msg-1': '回答已中斷' });

    expect(screen.getByRole('status').textContent).toBe('回答已中斷');
    expect(screen.getByText('partial')).toBeTruthy();
  });

  it('offers regeneration only for listed drafts and disables it while a run is loading', () => {
    const onRegenerate = vi.fn();
    const messages = [human, { type: 'ai', id: 'msg-1', content: 'partial' } as Message];
    const { unmount } = renderView(messages, { 'msg-1': '回答已中斷' }, { ids: new Set(['msg-1']), onRegenerate, isLoading: false });

    const button = screen.getByRole('button', { name: FRONTEND_ERROR_MESSAGES.answerStream.regenerate });
    fireEvent.click(button);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    unmount();

    renderView(messages, { 'msg-1': '回答已中斷' }, { ids: new Set(['msg-1']), onRegenerate, isLoading: true });
    expect(
      (screen.getByRole('button', { name: FRONTEND_ERROR_MESSAGES.answerStream.regenerate }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('shows no regeneration for drafts that are not listed', () => {
    renderView([human, { type: 'ai', id: 'msg-1', content: 'partial' } as Message], undefined, {
      ids: new Set(['other']),
      onRegenerate: vi.fn(),
      isLoading: false,
    });
    expect(screen.queryByRole('button', { name: FRONTEND_ERROR_MESSAGES.answerStream.regenerate })).toBeNull();
  });

  it('shows no status for a message without a notice', () => {
    renderView([human, { type: 'ai', id: 'msg-1', content: 'done' } as Message], { 'other-id': 'x' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
