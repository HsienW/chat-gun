import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { ToolConfirmationDecision, ToolConfirmationRequest } from '@/lib/commerce-cards';
import {
  COMMERCE_LABELS,
  getSubmitErrorMessage,
  type ConfirmationSubmission,
} from '@/lib/commerce-labels';

/** Longest single wait before the deadline is checked again. */
const DEADLINE_RECHECK_MS = 60_000;

interface OperationApprovalCardProps {
  request: ToolConfirmationRequest;
  /** Server deadline from the operation card, falling back to the approval request. */
  expiresAt: string;
  submission?: ConfirmationSubmission;
  onDecision: (request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => void;
  onCancelRequest: () => void;
  now?: () => number;
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

/**
 * Re-renders once the server deadline passes. Only a hint is shown then: the
 * state stays as the server reported it until the server says it expired.
 */
function useDeadlinePassed(expiresAt: string, now: () => number): boolean {
  const deadline = Date.parse(expiresAt);
  const [passed, setPassed] = useState(() => now() >= deadline);

  useEffect(() => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      setPassed(true);
      return;
    }
    setPassed(false);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        const left = deadline - now();
        if (left <= 0) setPassed(true);
        else schedule(Math.min(left, DEADLINE_RECHECK_MS));
      }, delay);
    };
    schedule(Math.min(remaining, DEADLINE_RECHECK_MS));
    return () => clearTimeout(timer);
  }, [deadline, now]);

  return passed;
}

const defaultNow = () => Date.now();

export function OperationApprovalCard({
  request,
  expiresAt,
  submission,
  onDecision,
  onCancelRequest,
  now = defaultNow,
}: OperationApprovalCardProps) {
  const deadlinePassed = useDeadlinePassed(expiresAt, now);
  // A click locks the choices until the parent reports a new submission state.
  const [lockedAt, setLockedAt] = useState<{ submission?: ConfirmationSubmission } | null>(
    null
  );
  const locked = lockedAt !== null && lockedAt.submission === submission;
  const ownSubmission = submission?.approvalId === request.approvalId ? submission : undefined;
  const busy = locked || ownSubmission?.status === 'submitting';

  const choose = (action: () => void) => {
    if (busy) return;
    setLockedAt({ submission });
    action();
  };

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <p className="text-xs text-muted-foreground">
        {COMMERCE_LABELS.deadline}：
        <time dateTime={expiresAt} data-testid="approval-deadline">
          {formatDeadline(expiresAt)}
        </time>
      </p>
      {deadlinePassed && (
        <p className="text-xs text-amber-400">{COMMERCE_LABELS.deadlinePassed}</p>
      )}
      {ownSubmission?.status === 'failed' && (
        <div role="alert" className="text-xs text-red-400 space-y-0.5">
          <p>{getSubmitErrorMessage(ownSubmission.error)}</p>
          {ownSubmission.error.code && (
            <p>
              {COMMERCE_LABELS.errorCode}：{ownSubmission.error.code}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => choose(() => onDecision(request, 'approve'))}
        >
          {COMMERCE_LABELS.approve}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => choose(() => onDecision(request, 'deny'))}
        >
          {COMMERCE_LABELS.deny}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => choose(onCancelRequest)}
        >
          {COMMERCE_LABELS.cancelRequest}
        </Button>
      </div>
    </div>
  );
}
