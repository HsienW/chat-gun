import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SubjectRightsPanel } from './SubjectRightsPanel';

function response(type: 'export' | 'deletion' | 'consent', withReceipt = false) {
  return new Response(JSON.stringify({
    schemaVersion: '1.0.0',
    workflowId: 'workflow_01',
    type,
    status: 'completed',
    ...(withReceipt ? {
      receipt: {
        status: 'completed',
        parts: [
          { storeId: 'runtime.tasks', status: 'completed' },
          { storeId: 'runtime.audit', status: 'retained_by_policy' },
        ],
      },
    } : {}),
  }), { status: 202, headers: { 'content-type': 'application/json' } });
}

describe('SubjectRightsPanel', () => {
  it('submits export and renders typed workflow status', async () => {
    const fetchImpl = vi.fn(async () => response('export'));
    render(<SubjectRightsPanel fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出我的資料' }));
    await waitFor(() => expect(screen.getByText('處理狀態：已完成')).toBeInTheDocument());
    expect(fetchImpl).toHaveBeenCalledWith('/api/subject-rights/export', expect.any(Object));
  });

  it('confirms deletion and displays all receipt statuses from typed fields', async () => {
    const fetchImpl = vi.fn(async () => response('deletion', true));
    render(<SubjectRightsPanel fetchImpl={fetchImpl} confirmAction={() => true} />);
    fireEvent.click(screen.getByRole('button', { name: '刪除我的資料' }));
    await waitFor(() => expect(screen.getByText('runtime.tasks：已完成')).toBeInTheDocument());
    expect(screen.getByText('runtime.audit：依政策保留')).toBeInTheDocument();
  });

  it('requires confirmation before withdrawing consent', async () => {
    const fetchImpl = vi.fn(async () => response('consent'));
    const confirmAction = vi.fn(() => false);
    render(<SubjectRightsPanel fetchImpl={fetchImpl} confirmAction={confirmAction} />);
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    expect(confirmAction).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
