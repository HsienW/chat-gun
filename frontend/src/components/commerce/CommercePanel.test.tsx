import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  OrderOperationState,
  OrderOperationStatusCard,
  ToolConfirmationDecision,
  ToolConfirmationRequest,
} from '@/lib/commerce-cards';
import {
  commerceReducer,
  createInitialCommerceState,
  type CommerceState,
  type TrackedOperation,
} from '@/lib/commerce-state';
import { CommercePanel, type ConfirmationSubmission } from './CommercePanel';

const ALL_STATES: OrderOperationState[] = [
  'requested',
  'awaiting_approval',
  'approved',
  'executing',
  'confirmed',
  'deduplicated',
  'failed',
  'approval_denied',
  'approval_expired',
  'cancelled_before_effect',
  'outcome_unknown',
];

const DEADLINE = '2026-10-26T12:15:00.000Z';
const BEFORE_DEADLINE = Date.parse('2026-10-26T12:00:00.000Z');
const AFTER_DEADLINE = Date.parse('2026-10-26T12:20:00.000Z');

function operation(
  toolCallId: string,
  state: OrderOperationState | 'unknown',
  extra: Partial<OrderOperationStatusCard> = {}
): OrderOperationStatusCard {
  return {
    operationRef: { toolCallId, operationId: `approval-${toolCallId}` },
    kind: 'refund_request',
    orderRef: { orderId: 'ORD-1001' },
    state: state === 'unknown' ? { known: false } : { known: true, value: state },
    stateVersion: 2,
    ...extra,
  };
}

function stateWith(operations: OrderOperationStatusCard[]): CommerceState {
  return commerceReducer(createInitialCommerceState(), {
    type: 'snapshotReceived',
    operations,
  });
}

const request: ToolConfirmationRequest = {
  schemaVersion: '1.0',
  approvalId: 'approval-call-1',
  decisionId: 'decision-1',
  expiresAt: DEADLINE,
};

function renderApproval(
  options: {
    submission?: ConfirmationSubmission;
    now?: number;
    onDecision?: Mock<(request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => void>;
    onCancelRequest?: Mock<(operation: TrackedOperation) => void>;
  } = {}
) {
  const onDecision =
    options.onDecision ??
    vi.fn<(request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => void>();
  const onCancelRequest =
    options.onCancelRequest ?? vi.fn<(operation: TrackedOperation) => void>();
  const view = render(
    <CommercePanel
      state={stateWith([
        operation('call-1', 'awaiting_approval', { approvalExpiresAt: DEADLINE }),
      ])}
      confirmationRequest={request}
      submission={options.submission}
      onDecision={onDecision}
      onCancelRequest={onCancelRequest}
      now={() => options.now ?? BEFORE_DEADLINE}
    />
  );
  return { ...view, onDecision, onCancelRequest };
}

describe('CommercePanel operation states', () => {
  it('shows every lifecycle state with its own label', () => {
    render(
      <CommercePanel
        state={stateWith(ALL_STATES.map((state) => operation(`call-${state}`, state)))}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    const labels = ALL_STATES.map(
      (state) =>
        screen.getByTestId(`operation-call-${state}`).querySelector('[data-operation-state]')
          ?.textContent
    );
    expect(new Set(labels).size).toBe(ALL_STATES.length);
  });

  it.each(['requested', 'approved', 'executing'] as const)(
    'does not show %s as confirmed',
    (state) => {
      render(
        <CommercePanel
          state={stateWith([operation('call-1', state)])}
          onDecision={vi.fn()}
          onCancelRequest={vi.fn()}
        />
      );

      expect(screen.queryByText('已確認')).toBeNull();
    }
  );

  it('explains an unknown outcome without calling it success or failure', () => {
    render(
      <CommercePanel
        state={stateWith([
          operation('call-1', 'outcome_unknown', { reconciliationTaskId: 'task-9' }),
        ])}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    const card = screen.getByTestId('operation-call-1');
    expect(card).toHaveTextContent('結果待確認，已建立核對工作，請勿重複申請');
    expect(card).not.toHaveTextContent('已確認');
    expect(card).not.toHaveTextContent('失敗');
  });

  it('explains a deduplicated submission and shows the original operation state', () => {
    render(
      <CommercePanel
        state={stateWith([
          operation('call-0', 'confirmed', {
            operationRef: { toolCallId: 'call-0', operationId: 'approval-0' },
          }),
          operation('call-1', 'deduplicated', {
            dedup: { reason: 'committed_result_reused', of: 'approval-0' },
          }),
        ])}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    const card = screen.getByTestId('operation-call-1');
    expect(card).toHaveTextContent('與既有申請相同，未重複執行');
    expect(within(card).getByTestId('original-operation-state')).toHaveTextContent('已確認');
    expect(card).not.toHaveTextContent('失敗');
  });

  it('shows an unknown state value as a generic unknown state', () => {
    render(
      <CommercePanel
        state={stateWith([operation('call-1', 'unknown')])}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    expect(screen.getByTestId('operation-call-1')).toHaveTextContent('狀態未知');
  });

  it.each(['confirmed', 'executing'] as const)(
    'offers no undo, revert or cancel control when %s',
    (state) => {
      render(
        <CommercePanel
          state={stateWith([operation('call-1', state)])}
          confirmationRequest={request}
          onDecision={vi.fn()}
          onCancelRequest={vi.fn()}
        />
      );

      expect(within(screen.getByTestId('operation-call-1')).queryAllByRole('button')).toEqual(
        []
      );
    }
  );

  it('marks the operations as simulated', () => {
    render(
      <CommercePanel
        state={stateWith([operation('call-1', 'confirmed')])}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    expect(screen.getByText('模擬訂單操作（mock）')).toBeInTheDocument();
  });
});

describe('CommercePanel approval card', () => {
  it('shows the summary, server deadline and three choices', () => {
    renderApproval();

    const card = screen.getByTestId('operation-call-1');
    expect(card).toHaveTextContent('退款申請');
    expect(card).toHaveTextContent('ORD-1001');
    expect(within(card).getByTestId('approval-deadline')).toHaveAttribute('dateTime', DEADLINE);
    expect(within(card).getByRole('button', { name: '核准' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: '拒絕' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: '取消申請' })).toBeEnabled();
  });

  it('sends one decision for a double click', () => {
    const { onDecision } = renderApproval();

    const approve = screen.getByRole('button', { name: '核准' });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(request, 'approve');
  });

  it('sends a deny decision', () => {
    const { onDecision } = renderApproval();

    fireEvent.click(screen.getByRole('button', { name: '拒絕' }));

    expect(onDecision).toHaveBeenCalledWith(request, 'deny');
  });

  it('sends a cancel request for the waiting operation', () => {
    const { onCancelRequest } = renderApproval();

    fireEvent.click(screen.getByRole('button', { name: '取消申請' }));

    expect(onCancelRequest).toHaveBeenCalledTimes(1);
    expect(onCancelRequest.mock.calls[0]?.[0]).toMatchObject({
      card: { operationRef: { toolCallId: 'call-1' } },
    });
  });

  it('disables every choice while a decision is being sent', () => {
    renderApproval({ submission: { approvalId: request.approvalId, status: 'submitting' } });

    for (const name of ['核准', '拒絕', '取消申請']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.queryByText('已確認')).toBeNull();
  });

  it('shows a typed error and lets the user decide again after a failed resume', () => {
    renderApproval({
      submission: {
        approvalId: request.approvalId,
        status: 'failed',
        error: { kind: 'timeout', code: 'upstream_timeout' },
      },
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('逾時');
    expect(alert).toHaveTextContent('upstream_timeout');
    expect(screen.getByRole('button', { name: '核准' })).toBeEnabled();
    expect(screen.getByTestId('operation-call-1').querySelector('[data-operation-state]'))
      .toHaveTextContent('等待審批');
  });

  it('lets the user decide again once a new failure arrives after a click', () => {
    const onDecision =
      vi.fn<(request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => void>();
    const { rerender } = renderApproval({ onDecision });
    fireEvent.click(screen.getByRole('button', { name: '核准' }));

    rerender(
      <CommercePanel
        state={stateWith([
          operation('call-1', 'awaiting_approval', { approvalExpiresAt: DEADLINE }),
        ])}
        confirmationRequest={request}
        submission={{
          approvalId: request.approvalId,
          status: 'failed',
          error: { kind: 'generic' },
        }}
        onDecision={onDecision}
        onCancelRequest={vi.fn()}
        now={() => BEFORE_DEADLINE}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '核准' }));

    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it('only hints at a passed deadline and keeps the waiting state and choices', () => {
    renderApproval({ now: AFTER_DEADLINE });

    const card = screen.getByTestId('operation-call-1');
    expect(card).toHaveTextContent('已超過審批期限，系統確認中');
    expect(card.querySelector('[data-operation-state]')).toHaveTextContent('等待審批');
    expect(card).not.toHaveTextContent('審批逾期');
    expect(within(card).getByRole('button', { name: '核准' })).toBeEnabled();
  });

  it('offers no choices when the waiting operation has no matching server request', () => {
    render(
      <CommercePanel
        state={stateWith([operation('call-1', 'awaiting_approval')])}
        confirmationRequest={{ ...request, approvalId: 'another-approval' }}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    expect(within(screen.getByTestId('operation-call-1')).queryAllByRole('button')).toEqual([]);
  });
});

describe('CommercePanel products and unknown cards', () => {
  it('shows product cards with their citation', () => {
    const state = commerceReducer(createInitialCommerceState(), {
      type: 'cardsReceived',
      cards: [
        {
          card: {
            type: 'product_result',
            card: {
              citationId: 'c1',
              sourceId: 'product-hp-1001',
              sourceVersion: 1,
              title: 'Tonic Earbuds 2',
              snippet: 'Up to 30 hours of battery.',
            },
          },
        },
      ],
    });

    render(<CommercePanel state={state} onDecision={vi.fn()} onCancelRequest={vi.fn()} />);

    const card = screen.getByTestId('product-product-hp-1001');
    expect(card).toHaveTextContent('Tonic Earbuds 2');
    expect(card).toHaveTextContent('Up to 30 hours of battery.');
    expect(card).toHaveTextContent('[c1]');
  });

  it('shows a generic notice for cards it cannot read', () => {
    const state = commerceReducer(createInitialCommerceState(), {
      type: 'cardsReceived',
      cards: [
        { card: { type: 'unsupported', cardType: 'weather_map', reason: 'unknown_card_type' } },
      ],
    });

    render(<CommercePanel state={state} onDecision={vi.fn()} onCancelRequest={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('有 1 張卡片無法顯示');
  });

  it('renders nothing without commerce content', () => {
    const { container } = render(
      <CommercePanel
        state={createInitialCommerceState()}
        onDecision={vi.fn()}
        onCancelRequest={vi.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
