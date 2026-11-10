import { ADMISSION_MESSAGES, type AdmissionFailure } from '@/lib/admission-error';

export function AdmissionNotice({ failure }: { failure: AdmissionFailure }) {
  const message = Object.entries(ADMISSION_MESSAGES).find(([code]) => code === failure.code)?.[1]
    ?? '目前無法送出請求，請稍後手動重試。';
  return <div role="status" className="mx-auto mt-16 max-w-3xl rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground">
    <p>{failure.code === 'usage_budget_exhausted' && failure.budgetScope === 'deep_research' ? '深度研究暫停，一般對話仍可使用。' : message}</p>
    {failure.retryAt !== undefined && <p className="mt-1 text-muted-foreground">可重試時間：<time dateTime={new Date(failure.retryAt).toISOString()}>{new Date(failure.retryAt).toLocaleString('zh-TW')}</time></p>}
  </div>;
}
