import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@langchain/langgraph-sdk';
import { AdmissionNotice } from './AdmissionNotice';
import { ADMISSION_MESSAGES, createAdmissionTransport, parseAdmissionFailure } from '@/lib/admission-error';

const stream = vi.hoisted(() => ({ options: undefined as { onError?: (error: unknown) => void } | undefined, submit: vi.fn(), messages: [] }));
vi.mock('@langchain/langgraph-sdk/react', () => ({ useStream: (options: typeof stream.options) => {
  stream.options = options; return { messages: stream.messages, isLoading: false, submit: stream.submit, stop: vi.fn(), history: [] };
} }));
import App from '@/App';

const envelope = (code: string, scope = 'site') => ({ error: { source: 'bff', stage: 'run_admission', code, message: 'Provider text is not used', details: { budgetScope: scope, retryAfter: 60 } } });

describe('admission degradation', () => {
  beforeEach(() => { stream.submit.mockReset(); });
  it.each(Object.entries(ADMISSION_MESSAGES))('renders %s outside assistant messages with reset time', (code, message) => {
    render(<AdmissionNotice failure={parseAdmissionFailure(envelope(code), 1000)!} />);
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.getByRole('status').querySelector('time')?.dateTime).toBe('1970-01-01T00:01:01.000Z');
  });
  it('safely renders unknown codes and never infers status from message text', () => {
    render(<AdmissionNotice failure={parseAdmissionFailure(envelope('future_code'))!} />);
    expect(screen.getByRole('status')).toHaveTextContent('目前無法送出請求');
    expect(parseAdmissionFailure({ error: { ...envelope('future').error, stage: 'other', message: 'usage_budget_exhausted' } })).toBeUndefined();
  });
  it('preserves rejected text and keeps browsing existing UI without creating an assistant reply', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: /Gun Chat/ }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '保留這段輸入' } });
    fireEvent.click(screen.getByTestId('chat-submit'));
    expect(stream.submit).toHaveBeenCalledTimes(1);
    act(() => stream.options?.onError?.(envelope('usage_budget_exhausted')));
    expect(screen.getByRole('textbox')).toHaveValue('保留這段輸入');
    expect(screen.getByRole('status')).toHaveTextContent('今日使用額度已用完');
    expect(screen.queryByText('Provider text is not used')).not.toBeInTheDocument();
    expect(stream.submit).toHaveBeenCalledTimes(1);
  });
  it('switches off only deep research, permitting a normal chat with the preserved text', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: /Gun Chat/ }));
    fireEvent.click(screen.getByRole('switch', { name: '深度研究' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '研究問題' } });
    fireEvent.click(screen.getByTestId('chat-submit'));
    act(() => stream.options?.onError?.(envelope('usage_budget_exhausted', 'deep_research')));
    expect(screen.getByRole('switch', { name: '深度研究' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: '深度研究' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('一般對話仍可使用');
    expect(screen.getByTestId('chat-submit')).toBeEnabled();
    fireEvent.click(screen.getByTestId('chat-submit')); expect(stream.submit).toHaveBeenCalledTimes(2);
  });
  it('stops actual installed SDK retries for admission responses', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(envelope('run_concurrency_limited')), { status: 429 }));
    const client = new Client({ apiUrl: 'https://runtime.example.test', callerOptions: createAdmissionTransport(customFetch) });
    await expect(client.runs.wait('thread-fixture', 'chatbot')).rejects.toThrow('run_concurrency_limited');
    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
