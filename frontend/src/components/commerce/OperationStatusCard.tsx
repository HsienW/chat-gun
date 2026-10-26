import type { ReactNode } from 'react';

import type { OrderOperationStatusCard } from '@/lib/commerce-cards';
import {
  COMMERCE_LABELS,
  DEDUP_REASON_LABELS,
  OPERATION_KIND_LABELS,
  getOperationStateDisplay,
  type OperationStateDisplay,
} from '@/lib/commerce-labels';

const TONE_CLASSES: Record<OperationStateDisplay['tone'], string> = {
  pending: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  progress: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  success: 'bg-green-500/15 text-green-400 border-green-500/30',
  neutral: 'bg-neutral-500/15 text-neutral-300 border-neutral-500/30',
  warning: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  danger: 'bg-red-500/15 text-red-400 border-red-500/30',
};

interface OperationStatusCardProps {
  card: OrderOperationStatusCard;
  /** The operation a deduplicated submission points to, when it is known here. */
  originalOperation?: OrderOperationStatusCard;
  /** Approval choices; only given while the server waits for this approval. */
  approval?: ReactNode;
}

export function OperationStatusCard({ card, originalOperation, approval }: OperationStatusCardProps) {
  const display = getOperationStateDisplay(card.state);
  const isDeduplicated = card.state.known && card.state.value === 'deduplicated';

  return (
    <article
      data-testid={`operation-${card.operationRef.toolCallId}`}
      className="border border-border bg-card/70 rounded-lg px-4 py-3 space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          {OPERATION_KIND_LABELS[card.kind]}
        </span>
        <span className="text-xs text-muted-foreground">
          {COMMERCE_LABELS.order} {card.orderRef.orderId}
        </span>
        <span
          data-operation-state
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${TONE_CLASSES[display.tone]}`}
        >
          {display.label}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{display.description}</p>
      {isDeduplicated && card.dedup && (
        <p className="text-xs text-muted-foreground">
          {DEDUP_REASON_LABELS[card.dedup.reason]}；{COMMERCE_LABELS.originalOperation}：
          <span data-testid="original-operation-state">
            {originalOperation
              ? getOperationStateDisplay(originalOperation.state).label
              : COMMERCE_LABELS.originalOperationUnavailable}
          </span>
        </p>
      )}
      {card.reconciliationTaskId && (
        <p className="text-xs text-muted-foreground">
          {COMMERCE_LABELS.reconciliationTask}：{card.reconciliationTaskId}
        </p>
      )}
      {card.externalOperationId && (
        <p className="text-xs text-muted-foreground">
          {COMMERCE_LABELS.externalOperation}：{card.externalOperationId}
        </p>
      )}
      {card.reasonCode && (
        <p className="text-xs text-muted-foreground">
          {COMMERCE_LABELS.reasonCode}：{card.reasonCode}
        </p>
      )}
      {approval}
    </article>
  );
}
