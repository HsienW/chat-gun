import { useState } from 'react';
import { ChevronRight, CircleAlert, ShieldCheck } from 'lucide-react';

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

const LABELS = { title: '資料權利' } as const;

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
    <details className="group text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">{LABELS.title}</span>
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
      </summary>
      <div className="mx-3 mb-3 mt-1 rounded-lg border border-border bg-background p-3">
        <div className="flex flex-col items-stretch gap-2">
          <button type="button" className="rounded-md border px-3 py-1 disabled:opacity-50" disabled={pending}
            onClick={() => void submit('export')}>匯出我的資料</button>
          <button type="button" role="switch" aria-checked={consentGranted}
            className="rounded-md border px-3 py-1 disabled:opacity-50" disabled={pending}
            onClick={() => void toggleConsent()}>個人化同意：{consentGranted ? '開啟' : '關閉'}</button>
          <button type="button" className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-1 text-white disabled:opacity-50"
            disabled={pending} onClick={() => {
              if (confirmAction('確定提出資料刪除要求？')) void submit('deletion');
            }}>
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            刪除我的資料
          </button>
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
      </div>
    </details>
  );
}
