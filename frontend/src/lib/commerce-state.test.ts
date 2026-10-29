import { describe, expect, it } from 'vitest';

import type { OrderOperationStatusCard, ProductResultCard } from './commerce-cards';
import { commerceReducer, createInitialCommerceState } from './commerce-state';

function operation(
  state: string,
  stateVersion: number,
  extra: Partial<OrderOperationStatusCard> = {}
): OrderOperationStatusCard {
  const known = [
    'requested',
    'awaiting_approval',
    'approved',
    'executing',
    'confirmed',
    'failed',
    'outcome_unknown',
  ].includes(state);
  return {
    operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
    kind: 'refund_request',
    orderRef: { orderId: 'ORD-1001' },
    state: known
      ? { known: true, value: state as 'requested' }
      : { known: false },
    stateVersion,
    ...extra,
  };
}

function receive(
  current: ReturnType<typeof createInitialCommerceState>,
  card: OrderOperationStatusCard,
  runId?: string
) {
  return commerceReducer(current, {
    type: 'cardsReceived',
    cards: [{ card: { type: 'order_operation_status', card }, runId }],
  });
}

function stateOf(current: ReturnType<typeof createInitialCommerceState>) {
  return current.operations['call-1']?.card.state;
}

const product: ProductResultCard = {
  citationId: 'c1',
  sourceId: 'product-hp-1001',
  sourceVersion: 1,
  title: 'Headphones',
  snippet: 'Noise cancelling',
};

describe('commerceReducer operations', () => {
  it('moves forward by state version', () => {
    let current = createInitialCommerceState();
    current = receive(current, operation('awaiting_approval', 2));
    current = receive(current, operation('approved', 3));
    current = receive(current, operation('executing', 4));

    expect(stateOf(current)).toEqual({ known: true, value: 'executing' });
  });

  it('keeps confirmed when a late executing event arrives', () => {
    let current = createInitialCommerceState();
    current = receive(current, operation('confirmed', 5));
    current = receive(current, operation('executing', 4));

    expect(stateOf(current)).toEqual({ known: true, value: 'confirmed' });
  });

  it('ignores a non-terminal event after a terminal one even with a higher version', () => {
    let current = createInitialCommerceState();
    current = receive(current, operation('confirmed', 5));
    current = receive(current, operation('executing', 6));

    expect(stateOf(current)).toEqual({ known: true, value: 'confirmed' });
  });

  it('returns the same state for a duplicate event', () => {
    const first = receive(createInitialCommerceState(), operation('awaiting_approval', 2));
    const second = receive(first, operation('awaiting_approval', 2));

    expect(second).toBe(first);
  });

  it('records the run that is waiting for the approval', () => {
    const current = receive(
      createInitialCommerceState(),
      operation('awaiting_approval', 2),
      'run-waiting'
    );

    expect(current.operations['call-1']?.approvalRunId).toBe('run-waiting');
  });

  it('keeps an unknown state as unknown and still lets a terminal state follow', () => {
    let current = receive(createInitialCommerceState(), operation('partially_refunded', 4));
    expect(stateOf(current)).toEqual({ known: false });

    current = receive(current, operation('confirmed', 5));
    expect(stateOf(current)).toEqual({ known: true, value: 'confirmed' });
  });

  it('applies the server snapshot with the same ordering rules', () => {
    let current = receive(createInitialCommerceState(), operation('confirmed', 5));
    current = commerceReducer(current, {
      type: 'snapshotReceived',
      operations: [operation('executing', 4)],
    });
    expect(stateOf(current)).toEqual({ known: true, value: 'confirmed' });

    const reloaded = commerceReducer(createInitialCommerceState(), {
      type: 'snapshotReceived',
      operations: [operation('awaiting_approval', 2)],
    });
    expect(reloaded.operations['call-1']?.card.state).toEqual({
      known: true,
      value: 'awaiting_approval',
    });
    expect(reloaded.operationOrder).toEqual(['call-1']);
  });

  it('keeps operations apart by tool call', () => {
    let current = receive(createInitialCommerceState(), operation('confirmed', 5));
    current = receive(
      current,
      operation('awaiting_approval', 2, {
        operationRef: { toolCallId: 'call-2', operationId: 'approval-2' },
      })
    );

    expect(current.operationOrder).toEqual(['call-1', 'call-2']);
    expect(current.operations['call-2']?.card.state).toEqual({
      known: true,
      value: 'awaiting_approval',
    });
  });
});

describe('commerceReducer products and unsupported cards', () => {
  it('collects product cards once per source and clears them for a new turn', () => {
    let current = commerceReducer(createInitialCommerceState(), {
      type: 'cardsReceived',
      cards: [
        { card: { type: 'product_result', card: product } },
        { card: { type: 'product_result', card: product } },
      ],
    });
    expect(current.products).toEqual([product]);

    current = commerceReducer(current, { type: 'turnStarted' });
    expect(current.products).toEqual([]);
  });

  it('counts unsupported cards without changing operations', () => {
    const current = commerceReducer(createInitialCommerceState(), {
      type: 'cardsReceived',
      cards: [
        {
          card: { type: 'unsupported', cardType: 'weather_map', reason: 'unknown_card_type' },
        },
      ],
    });

    expect(current.unsupportedCardCount).toBe(1);
    expect(current.operationOrder).toEqual([]);
  });

  it('starts over when the agent changes', () => {
    const current = receive(createInitialCommerceState(), operation('confirmed', 5));

    expect(commerceReducer(current, { type: 'reset' })).toEqual(createInitialCommerceState());
  });
});
