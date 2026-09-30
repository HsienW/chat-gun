import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IdentityLifecyclePanel } from './IdentityLifecyclePanel';

describe('IdentityLifecyclePanel', () => {
  it('renders account/session status and migration interaction', async () => {
    let resolveMigration!: () => void;
    const onMigrate = vi.fn(() => new Promise<void>((resolve) => { resolveMigration = resolve; }));
    render(
      <IdentityLifecyclePanel
        accountStatus="active"
        sessionStatus="active"
        onMigrate={onMigrate}
      />,
    );
    expect(screen.getByText('帳號狀態：使用中')).toBeInTheDocument();
    expect(screen.getByText('Session 狀態：使用中')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '連結匿名資料' }));
    expect(screen.getByRole('button', { name: '遷移中…' })).toBeDisabled();
    resolveMigration();
    await waitFor(() => expect(screen.getByText('匿名資料已連結')).toBeInTheDocument());
  });

  it('shows typed recovery action', () => {
    render(
      <IdentityLifecyclePanel
        identityFailure={{ code: 'IDENTITY_SESSION_EXPIRED', message: 'Session expired' }}
      />,
    );
    expect(screen.getByText('請重新登入以繼續。')).toBeInTheDocument();
  });

  it('offers an anonymous migration form without persisting the credential', () => {
    render(<IdentityLifecyclePanel />);
    fireEvent.click(screen.getByRole('button', { name: '連結匿名資料' }));
    expect(screen.getByLabelText('匿名 ID')).toBeInTheDocument();
    expect(screen.getByLabelText('匿名 Session ID')).toBeInTheDocument();
    expect(screen.getByLabelText('匿名 Device ID')).toBeInTheDocument();
    expect(screen.getByLabelText('匿名 Credential')).toHaveAttribute('type', 'password');
  });
});
