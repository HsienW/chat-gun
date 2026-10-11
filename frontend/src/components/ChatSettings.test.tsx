import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSettings } from './ChatSettings';

afterEach(() => vi.unstubAllGlobals());

describe('ChatSettings', () => {
  it('keeps data controls inside the popup and expands their submenus', () => {
    render(<ChatSettings />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '連結匿名資料' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Setting' }));
    expect(screen.getByRole('dialog', { name: 'Setting' })).toBeVisible();
    const migration = screen.getByRole('button', { name: '連結匿名資料' });
    expect(migration).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(migration);
    expect(screen.getByLabelText('匿名 Credential')).toBeVisible();
    fireEvent.click(migration);
    expect(screen.queryByLabelText('匿名 Credential')).not.toBeInTheDocument();
    expect(screen.getByText('匯出我的資料')).not.toBeVisible();
    fireEvent.click(screen.getByText('資料權利'));
    expect(screen.getByRole('button', { name: '匯出我的資料' })).toBeVisible();
    fireEvent.click(screen.getByText('資料權利'));
    expect(screen.getByText('匯出我的資料')).not.toBeVisible();
  });

  it('supports Escape, close, trigger toggle, and outside interaction', () => {
    render(<><ChatSettings /><button>聊天輸入</button></>);
    const trigger = screen.getByRole('button', { name: 'Setting' });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: '關閉設定' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '關閉設定' }));
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: '聊天輸入' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    act(() => screen.getByRole('button', { name: '聊天輸入' }).focus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retains an in-flight data request and its result across closing and reopening', async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetchImpl);
    render(<ChatSettings />);
    const trigger = screen.getByRole('button', { name: 'Setting' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByText('資料權利'));
    fireEvent.click(screen.getByRole('button', { name: '匯出我的資料' }));
    fireEvent.click(trigger);
    resolveResponse(new Response(JSON.stringify({
      schemaVersion: '1.0.0', workflowId: 'export-01', type: 'export', status: 'completed',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(screen.getByText('處理狀態：已完成')).toBeInTheDocument());
    fireEvent.click(trigger);
    expect(screen.getByText('處理狀態：已完成')).toBeVisible();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
