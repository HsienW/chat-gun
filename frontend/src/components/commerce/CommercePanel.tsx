import type { ToolConfirmationDecision, ToolConfirmationRequest } from '@/lib/commerce-cards';
import { COMMERCE_LABELS, type ConfirmationSubmission } from '@/lib/commerce-labels';
import type { CommerceState, TrackedOperation } from '@/lib/commerce-state';

import { OperationApprovalCard } from './OperationApprovalCard';
import { OperationStatusCard } from './OperationStatusCard';
import { ProductResultCard } from './ProductResultCard';

export type { ConfirmationSubmission } from '@/lib/commerce-labels';

interface CommercePanelProps {
  state: CommerceState;
  /** The approval the server thread is waiting for, if any. */
  confirmationRequest?: ToolConfirmationRequest;
  submission?: ConfirmationSubmission;
  onDecision: (request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => void;
  onCancelRequest: (operation: TrackedOperation) => void;
  now?: () => number;
}

export function CommercePanel({
  state,
  confirmationRequest,
  submission,
  onDecision,
  onCancelRequest,
  now,
}: CommercePanelProps) {
  const operations = state.operationOrder.flatMap((key) => {
    const operation = state.operations[key];
    return operation ? [operation] : [];
  });
  if (
    operations.length === 0 &&
    state.products.length === 0 &&
    state.unsupportedCardCount === 0
  ) {
    return null;
  }

  const findByOperationId = (operationId: string | undefined) =>
    operationId === undefined
      ? undefined
      : operations.find(({ card }) => card.operationRef.operationId === operationId)?.card;

  return (
    <section className="space-y-2" aria-label={COMMERCE_LABELS.mockNotice}>
      {state.products.map((card) => (
        <ProductResultCard key={`${card.sourceId}:${card.sourceVersion}`} card={card} />
      ))}
      {operations.length > 0 && (
        <p className="text-xs text-muted-foreground">{COMMERCE_LABELS.mockNotice}</p>
      )}
      {operations.map((operation) => {
        const { card } = operation;
        const waitingForThis =
          card.state.known &&
          card.state.value === 'awaiting_approval' &&
          confirmationRequest !== undefined &&
          card.operationRef.operationId === confirmationRequest.approvalId;
        return (
          <OperationStatusCard
            key={card.operationRef.toolCallId}
            card={card}
            originalOperation={findByOperationId(card.dedup?.of)}
            approval={
              waitingForThis ? (
                <OperationApprovalCard
                  request={confirmationRequest}
                  expiresAt={card.approvalExpiresAt ?? confirmationRequest.expiresAt}
                  submission={submission}
                  onDecision={onDecision}
                  onCancelRequest={() => onCancelRequest(operation)}
                  now={now}
                />
              ) : undefined
            }
          />
        );
      })}
      {state.unsupportedCardCount > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {COMMERCE_LABELS.unsupportedCards(state.unsupportedCardCount)}
        </p>
      )}
    </section>
  );
}
