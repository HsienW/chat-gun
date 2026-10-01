import { useState, type FormEvent } from 'react';

import {
  classifyIdentityFailure,
  migrateAnonymousIdentity,
  type IdentityFailure,
} from '@/lib/identity-lifecycle';

type AccountStatus =
  | 'pending_verification'
  | 'active'
  | 'recovery_restricted'
  | 'suspended'
  | 'deletion_pending'
  | 'deleted';
type SessionStatus = 'active' | 'expired' | 'revoked' | 'compromised';

const ACCOUNT_LABELS: Readonly<Record<AccountStatus, string>> = {
  pending_verification: '待驗證',
  active: '使用中',
  recovery_restricted: '復原受限',
  suspended: '已停權',
  deletion_pending: '等待刪除',
  deleted: '已刪除',
};

const SESSION_LABELS: Readonly<Record<SessionStatus, string>> = {
  active: '使用中',
  expired: '已過期',
  revoked: '已撤銷',
  compromised: '可能遭入侵',
};

export function IdentityLifecyclePanel({
  accountStatus,
  sessionStatus,
  identityFailure,
  onMigrate,
}: {
  accountStatus?: AccountStatus;
  sessionStatus?: SessionStatus;
  identityFailure?: IdentityFailure;
  onMigrate?: () => Promise<void>;
}) {
  const [migrationState, setMigrationState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [migrationFormOpen, setMigrationFormOpen] = useState(false);
  const recoveryAction = classifyIdentityFailure(identityFailure);

  const handleMigration = async () => {
    if (!onMigrate || migrationState === 'pending') return;
    setMigrationState('pending');
    try {
      await onMigrate();
      setMigrationState('success');
    } catch {
      setMigrationState('error');
    }
  };

  const handleMigrationSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (migrationState === 'pending') return;
    const form = new FormData(event.currentTarget);
    setMigrationState('pending');
    try {
      const result = await migrateAnonymousIdentity({
        schemaVersion: '1.0.0',
        anonymousId: String(form.get('anonymousId') ?? ''),
        anonymousSessionId: String(form.get('anonymousSessionId') ?? ''),
        anonymousDeviceId: String(form.get('anonymousDeviceId') ?? ''),
        anonymousCredential: String(form.get('anonymousCredential') ?? ''),
        idempotencyKey: `migration-${crypto.randomUUID()}`,
      });
      if (result.result === 'conflict') throw new Error('IDENTITY_MIGRATION_CONFLICT');
      event.currentTarget.reset();
      setMigrationFormOpen(false);
      setMigrationState('success');
    } catch {
      setMigrationState('error');
    }
  };

  return (
    <section className="mx-4 mt-3 rounded-lg border border-border bg-card px-4 py-3 text-sm" aria-label="身份與帳號狀態">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {accountStatus && <span>帳號狀態：{ACCOUNT_LABELS[accountStatus]}</span>}
        {sessionStatus && <span>Session 狀態：{SESSION_LABELS[sessionStatus]}</span>}
        <button
          type="button"
          className="rounded-md border px-3 py-1 disabled:opacity-50"
          disabled={migrationState === 'pending'}
          onClick={() => onMigrate
            ? void handleMigration()
            : setMigrationFormOpen((open) => !open)}
        >
          {migrationState === 'pending' ? '遷移中…' : '連結匿名資料'}
        </button>
      </div>
      {migrationFormOpen && !onMigrate && (
        <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={(event) => void handleMigrationSubmit(event)}>
          <label className="grid gap-1">匿名 ID<input name="anonymousId" required className="rounded border px-2 py-1" /></label>
          <label className="grid gap-1">匿名 Session ID<input name="anonymousSessionId" required className="rounded border px-2 py-1" /></label>
          <label className="grid gap-1">匿名 Device ID<input name="anonymousDeviceId" required className="rounded border px-2 py-1" /></label>
          <label className="grid gap-1">匿名 Credential<input name="anonymousCredential" type="password" required autoComplete="off" className="rounded border px-2 py-1" /></label>
          <button type="submit" className="rounded-md border px-3 py-1 sm:col-span-2">確認連結</button>
        </form>
      )}
      {recoveryAction === 'reauth' && <p className="mt-2 text-amber-700">請重新登入以繼續。</p>}
      {recoveryAction === 'safe_degrade' && <p className="mt-2 text-amber-700">目前帳號無法執行受保護操作。</p>}
      {migrationState === 'success' && <p className="mt-2 text-green-700">匿名資料已連結</p>}
      {migrationState === 'error' && <p className="mt-2 text-red-700">匿名資料連結失敗，請稍後再試。</p>}
    </section>
  );
}
