import {
  COMMERCE_LABELS,
  getOperationStateDisplay,
  getSubmitErrorMessage,
} from '../src/lib/commerce-labels';
import type { OrderOperationState } from '../src/lib/commerce-cards';
import {
  ai,
  bffError,
  cardEvent,
  confirmationInterrupt,
  operationCardData,
  operationSnapshot,
} from './support/contract';
import { expect, expectIdle, openEntry, sendMessage, test } from './support/test';
import type { FixtureServer, RunContext } from './support/fixture-server';
import type { Page } from '@playwright/test';

const DEADLINE = '2099-10-26T12:15:00.000Z';
const OPERATION = { toolCallId: 'call-1', operationId: 'approval-1', approvalExpiresAt: DEADLINE };
const INTERRUPT = confirmationInterrupt({
  approvalId: 'approval-1',
  decisionId: 'decision-1',
  expiresAt: DEADLINE,
});

function stateLabel(value: OrderOperationState): string {
  return getOperationStateDisplay({ known: true, value }).label;
}

function operationState(page: Page) {
  return page.getByTestId('operation-call-1').locator('[data-operation-state]');
}

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** Streams the operation card for `state` and commits it as thread state. */
function emitOperation(run: RunContext, state: OrderOperationState, stateVersion: number, reply: string) {
  const card = { ...OPERATION, state, stateVersion };
  run.update({
    order_request: {
      runtimeEvents: [
        cardEvent({
          runId: run.runId,
          sequence: 1,
          cardType: 'order_operation_status',
          data: operationCardData(card),
        }),
      ],
    },
  });
  run.values({
    messages: [...run.thread.messages, ...run.inputMessages, ai(reply, `ai-${run.runId}`)],
    operations: { [card.toolCallId]: operationSnapshot(card) },
  });
}

/** The first run asks for approval and leaves the thread waiting on the interrupt. */
async function openWaitingApproval(page: Page, server: FixtureServer): Promise<void> {
  server.onRun((run) => {
    emitOperation(run, 'awaiting_approval', 2, '請確認退款申請。');
    run.thread.interrupts = [INTERRUPT];
  });
  await openEntry(page, server, 'Gun Shop');
  await sendMessage(page, '我要退款');
  await expect(operationState(page)).toHaveText(stateLabel('awaiting_approval'));
  await expect(button(page, COMMERCE_LABELS.approve)).toBeEnabled();
  await expectIdle(page);
}

function resolvesTo(state: OrderOperationState, stateVersion: number) {
  return (run: RunContext) => {
    run.thread.interrupts = [];
    emitOperation(run, state, stateVersion, '已處理。');
  };
}

test.describe('HITL approval', () => {
  test('approve sends one resume with the decision and follows the server state', async ({ page, server }) => {
    await openWaitingApproval(page, server);
    server.onRun(resolvesTo('confirmed', 3));

    await button(page, COMMERCE_LABELS.approve).click();

    await expect(operationState(page)).toHaveText(stateLabel('confirmed'));
    const resumes = server.runRequests().slice(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.body?.resume).toEqual({
      type: 'tool_authorization_confirmation',
      schemaVersion: '1.0',
      approvalId: 'approval-1',
      decisionId: 'decision-1',
      decision: 'approve',
    });
    await expect(button(page, COMMERCE_LABELS.approve)).toHaveCount(0);
  });

  test('deny sends one resume with the decision and shows denied', async ({ page, server }) => {
    await openWaitingApproval(page, server);
    server.onRun(resolvesTo('approval_denied', 3));

    await button(page, COMMERCE_LABELS.deny).click();

    await expect(operationState(page)).toHaveText(stateLabel('approval_denied'));
    const resumes = server.runRequests().slice(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.body?.resume).toMatchObject({ approvalId: 'approval-1', decision: 'deny' });
  });

  test('withdraw sends one cancel for the waiting run and shows cancelled before effect', async ({ page, server }) => {
    await openWaitingApproval(page, server);
    server.onRun(resolvesTo('cancelled_before_effect', 3));

    await button(page, COMMERCE_LABELS.cancelRequest).click();

    await expect(operationState(page)).toHaveText(stateLabel('cancelled_before_effect'));
    const [waiting, cancel, ...rest] = server.runRequests();
    expect(rest).toHaveLength(0);
    expect(cancel?.body?.kind).toBe('cancel');
    expect(cancel?.body?.targetRunId).toBe(waiting?.runId);
    expect(cancel?.body?.resume).toBeUndefined();
  });

  test('a failed submit keeps the card open with the error and code, and can be retried', async ({ page, server }) => {
    test.fail();
    test.info().annotations.push({ type: 'known-limitation', description: 'KL-2：HITL 決定送出失敗時，審批卡片未顯示結構化錯誤碼。' });
    await openWaitingApproval(page, server);
    server.onRun((run) => {
      run.error(bffError('upstream_stream_error', 'LangGraph stream ended with an error'));
    });

    await button(page, COMMERCE_LABELS.approve).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText(getSubmitErrorMessage({ kind: 'generic' }));
    await expect(alert).toContainText(`${COMMERCE_LABELS.errorCode}：upstream_stream_error`);
    await expect(operationState(page)).toHaveText(stateLabel('awaiting_approval'));
    await expect(button(page, COMMERCE_LABELS.approve)).toBeEnabled();

    server.onRun(resolvesTo('confirmed', 3));
    await button(page, COMMERCE_LABELS.approve).click();
    await expect(operationState(page)).toHaveText(stateLabel('confirmed'));
    expect(server.runRequests().slice(1)).toHaveLength(2);
  });

  test('rapid clicks on the same or different choices send only one request', async ({ page, server }) => {
    await openWaitingApproval(page, server);
    server.onRun(async (run) => {
      await run.gate('decided');
      resolvesTo('confirmed', 3)(run);
    });

    // All clicks land in one task, before React can disable the buttons.
    await page.evaluate(
      ({ approve, deny, cancelRequest }) => {
        const card = document.querySelector('[data-testid="operation-call-1"]');
        const byText = (text: string) =>
          [...(card?.querySelectorAll('button') ?? [])].find((element) => element.textContent === text);
        byText(approve)?.click();
        byText(approve)?.click();
        byText(deny)?.click();
        byText(cancelRequest)?.click();
      },
      {
        approve: COMMERCE_LABELS.approve,
        deny: COMMERCE_LABELS.deny,
        cancelRequest: COMMERCE_LABELS.cancelRequest,
      }
    );

    await server.gateReached('decided');
    expect(server.runRequests().slice(1)).toHaveLength(1);
    expect(server.runRequests()[1]?.body?.resume).toMatchObject({ decision: 'approve' });
    server.release('decided');
    await expect(operationState(page)).toHaveText(stateLabel('confirmed'));
    await expectIdle(page);
    expect(server.runRequests().slice(1)).toHaveLength(1);
  });
});
