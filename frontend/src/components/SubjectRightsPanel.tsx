import { useState } from 'react';

import {
  requestSubjectRight,
  type ReceiptPartStatus,
  type SubjectRightWorkflow,
} from '@/lib/subject-rights';

const STATUS_LABELS: Readonly<Record<SubjectRightWorkflow['status'], string>> = {
  requested: '已提出',
  in_progress: '處理中',
  completed: '已完成',
  failed: '部分失敗',
  expired: '已過期',
};

const PART_LABELS: Readonly<Record<ReceiptPartStatus, string>> = {
  completed: '已完成',
  skipped: '已略過',
  retained_by_policy: '依政策保留',
  failed: '失敗',
};

export function SubjectRightsPanel({
  fetchImpl = fetch,
  confirmAction = (message: string) => window.confirm(message),
}: {
  fetchImpl?: typeof fetch;
  confirmAction?: (message: string) => boolean;
}) {
  const [workflow, setWorkflow] = useState<SubjectRightWorkflow>();
  const [consentGranted, setConsentGranted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (
    kind: 'export' | 'deletion' | 'consent',
    extra: Record<string, unknown> = {},
  ) => {
    setPending(true);
    setError(false);
    try {
      const workflowId = `${kind}-${crypto.randomUUID()}`;
      setWorkflow(await requestSubjectRight(kind, {
        workflowId,
        idempotencyKey: workflowId,
        ...extra,
      }, fetchImpl));
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  const toggleConsent = async () => {
    const nextGranted = !consentGranted;
    if (!nextGranted && !confirmAction('確定撤回個人化同意？撤回後只影響未來處理。')) return;
    await submit('consent', {
      policyVersion: 1,
      status: nextGranted ? 'granted' : 'withdrawn',
      scope: 'personalization',
    });
    setConsentGranted(nextGranted);
  };

  return (
    <section className="mx-4 mt-3 rounded-lg border border-border bg-card px-4 py-3 text-sm" aria-label="資料權利">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">資料權利</h2>
        <button type="button" className="rounded-md border px-3 py-1 disabled:opacity-50" disabled={pending}
          onClick={() => void submit('export')}>匯出我的資料</button>
        <button type="button" className="rounded-md border border-red-300 px-3 py-1 text-red-700 disabled:opacity-50"
          disabled={pending} onClick={() => {
            if (confirmAction('確定提出資料刪除要求？')) void submit('deletion');
          }}>刪除我的資料</button>
        <button type="button" role="switch" aria-checked={consentGranted}
          className="rounded-md border px-3 py-1 disabled:opacity-50" disabled={pending}
          onClick={() => void toggleConsent()}>個人化同意：{consentGranted ? '開啟' : '關閉'}</button>
      </div>
      {pending && <p className="mt-2" role="status">正在送出要求…</p>}
      {error && <p className="mt-2 text-red-700" role="alert">目前無法處理資料權利要求，請稍後再試。</p>}
      {workflow && (
        <div className="mt-3" aria-live="polite">
          <p>處理狀態：{STATUS_LABELS[workflow.status]}</p>
          {workflow.receipt && (
            <ul className="mt-2 space-y-1">
              {workflow.receipt.parts.map((part) => (
                <li key={part.storeId}>{part.storeId}：{PART_LABELS[part.status]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
