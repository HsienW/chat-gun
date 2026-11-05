import {
  COMMERCE_LABELS,
  DEDUP_REASON_LABELS,
  getOperationStateDisplay,
} from '../src/lib/commerce-labels';
import {
  DEDUP_REASONS,
  ORDER_OPERATION_STATES,
  type DedupReason,
  type OrderOperationState,
} from '../src/lib/commerce-cards';
import { ai, cardEvent, operationCardData, type OperationCardData } from './support/contract';
import { expect, expectIdle, openEntry, sendMessage, test } from './support/test';
import type { RunContext } from './support/fixture-server';
import type { Page } from '@playwright/test';

function stateLabel(value: OrderOperationState): string {
  return getOperationStateDisplay({ known: true, value }).label;
}

function operation(page: Page, toolCallId: string) {
  return page.getByTestId(`operation-${toolCallId}`);
}

/** The original operation's state that each dedup reason describes. */
const ORIGINAL_STATE_BY_REASON: Record<DedupReason, OrderOperationState> = {
  committed_result_reused: 'confirmed',
  in_flight_duplicate: 'executing',
  original_outcome_unknown: 'outcome_unknown',
};

function cardsRun(cards: OperationCardData[]) {
  return (run: RunContext) => {
    run.values({ messages: [...run.inputMessages] });
    run.update({
      order_request: {
        runtimeEvents: cards.map((card, index) =>
          cardEvent({
            runId: run.runId,
            sequence: index + 1,
            cardType: 'order_operation_status',
            data: operationCardData(card),
          })
        ),
      },
    });
    run.values({ messages: [...run.inputMessages, ai('已處理退款申請。', 'ai-1')] });
  };
}

test.describe('refund dedup card', () => {
  for (const reason of DEDUP_REASONS) {
    test(`shows the dedup state, reason and original state for ${reason}`, async ({ page, server }) => {
      const originalState = ORIGINAL_STATE_BY_REASON[reason];
      server.onRun(
        cardsRun([
          { toolCallId: 'call-1', operationId: 'op-1', state: originalState, stateVersion: 3 },
          {
            toolCallId: 'call-2',
            operationId: 'op-2',
            state: 'deduplicated',
            stateVersion: 1,
            dedup: { reason, of: 'op-1' },
          },
        ])
      );
      await openEntry(page, server, 'Gun Shop');
      await sendMessage(page, '再退款一次');

      const dedupCard = operation(page, 'call-2');
      await expect(dedupCard.locator('[data-operation-state]')).toHaveText(stateLabel('deduplicated'));
      await expect(dedupCard).toContainText(DEDUP_REASON_LABELS[reason]);
      await expect(dedupCard.getByTestId('original-operation-state')).toHaveText(stateLabel(originalState));
      await expectIdle(page);
    });
  }

  test('says the original state is unavailable when the original is not on the page', async ({ page, server }) => {
    server.onRun(
      cardsRun([
        {
          toolCallId: 'call-2',
          operationId: 'op-2',
          state: 'deduplicated',
          stateVersion: 1,
          dedup: { reason: 'committed_result_reused', of: 'op-elsewhere' },
        },
      ])
    );
    await openEntry(page, server, 'Gun Shop');
    await sendMessage(page, '再退款一次');

    const dedupCard = operation(page, 'call-2');
    await expect(dedupCard.locator('[data-operation-state]')).toHaveText(stateLabel('deduplicated'));
    await expect(dedupCard.getByTestId('original-operation-state')).toHaveText(
      COMMERCE_LABELS.originalOperationUnavailable
    );
    for (const state of ORDER_OPERATION_STATES) {
      await expect(dedupCard.getByTestId('original-operation-state')).not.toHaveText(stateLabel(state));
    }
  });

  test('an unknown operation state degrades without showing a known state', async ({ page, server }) => {
    server.onRun(
      cardsRun([{ toolCallId: 'call-3', operationId: 'op-3', state: 'escalated_to_bank', stateVersion: 1 }])
    );
    await openEntry(page, server, 'Gun Shop');
    await sendMessage(page, '查詢退款');

    const badge = operation(page, 'call-3').locator('[data-operation-state]');
    await expect(badge).toHaveText(getOperationStateDisplay({ known: false }).label);
    for (const state of ORDER_OPERATION_STATES) {
      await expect(badge).not.toHaveText(stateLabel(state));
    }
    await expectIdle(page);

    // The chat keeps working after the unknown state.
    server.onRun((run) => {
      run.values({ messages: [...run.thread.messages, ...run.inputMessages, ai('仍可繼續對話。', 'ai-2')] });
    });
    await sendMessage(page, '還在嗎');
    await expect(page.getByText('仍可繼續對話。')).toBeVisible();
  });
});
