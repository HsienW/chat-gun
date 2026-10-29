import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InputForm } from '@/components/InputForm';
import { AgentId } from '@/types/agents';
import { DEFAULT_MODEL } from '@/types/models';

function renderForm(overrides: Partial<React.ComponentProps<typeof InputForm>> = {}) {
  const props: React.ComponentProps<typeof InputForm> = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    isLoading: false,
    hasHistory: false,
    targetAgentId: AgentId.DEEP_RESEARCHER,
    onNewConversation: vi.fn(),
    newConversationDisabled: false,
    ...overrides,
  };
  render(<InputForm {...props} />);
  return props;
}

describe('InputForm model selection', () => {
  it('submits the Qwen default model for a new Deep Research prompt', () => {
    const { onSubmit } = renderForm();

    const input = screen.getByPlaceholderText('輸入你的問題...');
    fireEvent.change(input, { target: { value: '幫我查台北今天的天氣' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledWith('幫我查台北今天的天氣', 'medium', DEFAULT_MODEL, []);
    expect(DEFAULT_MODEL).toMatch(/^qwen-/);
  });
});

describe('InputForm entry controls', () => {
  it('offers no agent selector', () => {
    renderForm({ targetAgentId: AgentId.CHATBOT });

    expect(screen.queryByText('Agent')).not.toBeInTheDocument();
    expect(screen.queryByText(/Math Solver|MCP Agent/)).not.toBeInTheDocument();
  });

  it('shows the deep research switch only when the entry offers it', () => {
    const onChange = vi.fn();
    renderForm({
      targetAgentId: AgentId.CHATBOT,
      deepResearch: { enabled: false, locked: false, onChange },
    });

    const toggle = screen.getByRole('switch', { name: /深度研究/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('locks the deep research switch with an accessible explanation', () => {
    const onChange = vi.fn();
    renderForm({
      targetAgentId: AgentId.DEEP_RESEARCHER,
      deepResearch: { enabled: true, locked: true, onChange },
    });

    const toggle = screen.getByRole('switch', { name: /深度研究/ });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAccessibleDescription('回覆進行中或等待澄清時無法切換深度研究');
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no deep research switch without the entry option', () => {
    renderForm({ targetAgentId: AgentId.SHOPPING_ASSISTANT });

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('starts a new conversation through the entry instead of reloading the page', () => {
    const { onNewConversation } = renderForm({
      hasHistory: true,
      targetAgentId: AgentId.CHATBOT,
    });

    fireEvent.click(screen.getByRole('button', { name: /新對話/ }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });
});
