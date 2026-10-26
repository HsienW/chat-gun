import {
  isTerminalOperationState,
  type CommerceCard,
  type OrderOperationStatusCard,
  type ProductResultCard,
} from './commerce-cards';

export interface TrackedOperation {
  card: OrderOperationStatusCard;
  /** The run that waits for the approval, from the card event that reported it. */
  approvalRunId?: string;
}

export interface CommerceState {
  operations: Readonly<Record<string, TrackedOperation>>;
  /** Tool call ids in first-seen order. */
  operationOrder: readonly string[];
  /** Product cards of the current turn only, so citations never leak across turns. */
  products: readonly ProductResultCard[];
  unsupportedCardCount: number;
}

export type CommerceAction =
  | {
      type: 'cardsReceived';
      cards: ReadonlyArray<{ card: CommerceCard; runId?: string }>;
    }
  | { type: 'snapshotReceived'; operations: readonly OrderOperationStatusCard[] }
  | { type: 'turnStarted' }
  | { type: 'reset' };

export function createInitialCommerceState(): CommerceState {
  return { operations: {}, operationOrder: [], products: [], unsupportedCardCount: 0 };
}

/**
 * Moves forward by `(toolCallId, stateVersion)`: an older or repeated version
 * is ignored, and a terminal state never goes back to a non-terminal one.
 */
function shouldApply(existing: TrackedOperation | undefined, incoming: OrderOperationStatusCard) {
  if (!existing) return true;
  if (incoming.stateVersion <= existing.card.stateVersion) return false;
  return !(isTerminalOperationState(existing.card.state) && !isTerminalOperationState(incoming.state));
}

function applyOperations(
  state: CommerceState,
  incoming: ReadonlyArray<{ card: OrderOperationStatusCard; runId?: string }>
): CommerceState {
  let operations: Record<string, TrackedOperation> | undefined;
  let operationOrder: string[] | undefined;
  for (const { card, runId } of incoming) {
    const key = card.operationRef.toolCallId;
    const current = operations ?? state.operations;
    const existing = current[key];
    if (!shouldApply(existing, card)) continue;
    const waiting = card.state.known && card.state.value === 'awaiting_approval';
    const approvalRunId = waiting && runId ? runId : existing?.approvalRunId;
    operations ??= { ...state.operations };
    operations[key] = { card, ...(approvalRunId ? { approvalRunId } : {}) };
    if (!existing) {
      operationOrder ??= [...state.operationOrder];
      operationOrder.push(key);
    }
  }
  if (!operations) return state;
  return { ...state, operations, operationOrder: operationOrder ?? state.operationOrder };
}

function productKey(card: ProductResultCard): string {
  return `${card.sourceId}:${card.sourceVersion}`;
}

export function commerceReducer(state: CommerceState, action: CommerceAction): CommerceState {
  switch (action.type) {
    case 'cardsReceived': {
      const operations = action.cards.flatMap(({ card, runId }) =>
        card.type === 'order_operation_status' ? [{ card: card.card, runId }] : []
      );
      let next = applyOperations(state, operations);

      const seen = new Set(next.products.map(productKey));
      const products = action.cards.flatMap(({ card }) => {
        if (card.type !== 'product_result' || seen.has(productKey(card.card))) return [];
        seen.add(productKey(card.card));
        return [card.card];
      });
      if (products.length > 0) next = { ...next, products: [...next.products, ...products] };

      const unsupported = action.cards.filter(({ card }) => card.type === 'unsupported').length;
      if (unsupported > 0) {
        next = { ...next, unsupportedCardCount: next.unsupportedCardCount + unsupported };
      }
      return next;
    }
    case 'snapshotReceived':
      return applyOperations(
        state,
        action.operations.map((card) => ({ card }))
      );
    case 'turnStarted':
      return state.products.length === 0 && state.unsupportedCardCount === 0
        ? state
        : { ...state, products: [], unsupportedCardCount: 0 };
    case 'reset':
      return createInitialCommerceState();
  }
}
