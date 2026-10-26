import { describe, expect, it } from 'vitest';

import {
  createToolConfirmationResume,
  parseCommerceCard,
  parseOperationSnapshot,
  parseToolConfirmationInterrupt,
} from './commerce-cards';

const operationPayload = {
  schemaVersion: 'order_operation_status@1',
  operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
  kind: 'refund_request',
  orderRef: { orderId: 'ORD-1001' },
  state: 'awaiting_approval',
  stateVersion: 2,
  approvalExpiresAt: '2026-10-26T12:15:00.000Z',
};

describe('parseCommerceCard', () => {
  it('accepts a product result card', () => {
    expect(
      parseCommerceCard('product_result', {
        schemaVersion: 'product_result@1',
        citationId: 'c1',
        sourceId: 'product-hp-1001',
        sourceVersion: 1,
        title: 'Headphones',
        snippet: 'Noise cancelling',
      })
    ).toEqual({
      type: 'product_result',
      card: {
        citationId: 'c1',
        sourceId: 'product-hp-1001',
        sourceVersion: 1,
        title: 'Headphones',
        snippet: 'Noise cancelling',
      },
    });
  });

  it('accepts an operation status card and ignores future fields', () => {
    const result = parseCommerceCard('order_operation_status', {
      ...operationPayload,
      futureField: 'ignored',
    });

    expect(result).toEqual({
      type: 'order_operation_status',
      card: {
        operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
        kind: 'refund_request',
        orderRef: { orderId: 'ORD-1001' },
        state: { known: true, value: 'awaiting_approval' },
        stateVersion: 2,
        approvalExpiresAt: '2026-10-26T12:15:00.000Z',
      },
    });
  });

  it('keeps an unknown state value as unknown instead of mapping it', () => {
    const result = parseCommerceCard('order_operation_status', {
      ...operationPayload,
      state: 'partially_refunded',
    });

    expect(result.type).toBe('order_operation_status');
    expect(result.type === 'order_operation_status' && result.card.state).toEqual({
      known: false,
    });
  });

  it('keeps dedup and reconciliation details', () => {
    const result = parseCommerceCard('order_operation_status', {
      ...operationPayload,
      state: 'deduplicated',
      stateVersion: 3,
      dedup: { reason: 'committed_result_reused', of: 'approval-0' },
      reconciliationTaskId: 'task-9',
    });

    expect(result.type === 'order_operation_status' && result.card).toMatchObject({
      dedup: { reason: 'committed_result_reused', of: 'approval-0' },
      reconciliationTaskId: 'task-9',
    });
  });

  it('degrades an unknown card type', () => {
    expect(parseCommerceCard('weather_map', { schemaVersion: 'weather_map@1' })).toEqual({
      type: 'unsupported',
      cardType: 'weather_map',
      reason: 'unknown_card_type',
    });
  });

  it('degrades an unknown schema version', () => {
    expect(
      parseCommerceCard('order_operation_status', {
        ...operationPayload,
        schemaVersion: 'order_operation_status@2',
      })
    ).toEqual({
      type: 'unsupported',
      cardType: 'order_operation_status',
      reason: 'unknown_schema_version',
    });
  });

  it.each([
    ['missing toolCallId', { ...operationPayload, operationRef: {} }],
    ['unknown kind', { ...operationPayload, kind: 'exchange' }],
    ['non-integer version', { ...operationPayload, stateVersion: 1.5 }],
    ['invalid deadline', { ...operationPayload, approvalExpiresAt: 'tomorrow' }],
    ['unknown dedup reason', { ...operationPayload, dedup: { reason: 'maybe' } }],
    ['not an object', 'awaiting_approval'],
  ])('degrades an invalid operation payload: %s', (_name, payload) => {
    expect(parseCommerceCard('order_operation_status', payload)).toEqual({
      type: 'unsupported',
      cardType: 'order_operation_status',
      reason: 'invalid_payload',
    });
  });
});

describe('parseOperationSnapshot', () => {
  it('reads the operations held in the server thread state', () => {
    const snapshot = parseOperationSnapshot({
      operations: {
        'call-1': {
          toolCallId: 'call-1',
          operationId: 'approval-1',
          kind: 'refund_request',
          orderId: 'ORD-1001',
          state: 'awaiting_approval',
          stateVersion: 2,
          approvalExpiresAt: '2026-10-26T12:15:00.000Z',
        },
        'call-2': { toolCallId: 'call-2', state: 'confirmed' },
      },
    });

    expect(snapshot).toEqual([
      {
        operationRef: { toolCallId: 'call-1', operationId: 'approval-1' },
        kind: 'refund_request',
        orderRef: { orderId: 'ORD-1001' },
        state: { known: true, value: 'awaiting_approval' },
        stateVersion: 2,
        approvalExpiresAt: '2026-10-26T12:15:00.000Z',
      },
    ]);
  });

  it('returns nothing when the state has no operations', () => {
    expect(parseOperationSnapshot({ messages: [] })).toEqual([]);
    expect(parseOperationSnapshot(undefined)).toEqual([]);
  });
});

describe('tool confirmation interrupt', () => {
  const interruptValue = {
    type: 'tool_authorization_confirmation',
    schemaVersion: '1.0',
    approvalId: 'approval-1',
    decisionId: 'decision-1',
    expiresAt: '2026-10-26T12:15:00.000Z',
    resumeCompatibility: {
      type: 'tool_authorization_confirmation',
      schemaVersion: '1.0',
      decisions: ['approve', 'deny'],
    },
    summary: { toolName: 'order_refund_request', action: 'refund', resourceType: 'order' },
  };

  it('parses the server approval request', () => {
    expect(parseToolConfirmationInterrupt(interruptValue)).toEqual({
      schemaVersion: '1.0',
      approvalId: 'approval-1',
      decisionId: 'decision-1',
      expiresAt: '2026-10-26T12:15:00.000Z',
    });
  });

  it.each([
    ['another interrupt type', { ...interruptValue, type: 'clarification' }],
    ['missing approvalId', { ...interruptValue, approvalId: '' }],
    [
      'decisions without deny',
      { ...interruptValue, resumeCompatibility: { decisions: ['approve'] } },
    ],
    ['invalid deadline', { ...interruptValue, expiresAt: 'soon' }],
    ['nothing', undefined],
  ])('rejects %s', (_name, value) => {
    expect(parseToolConfirmationInterrupt(value)).toBeUndefined();
  });

  it('builds the resume value for a decision', () => {
    const request = parseToolConfirmationInterrupt(interruptValue)!;

    expect(createToolConfirmationResume(request, 'deny')).toEqual({
      type: 'tool_authorization_confirmation',
      schemaVersion: '1.0',
      approvalId: 'approval-1',
      decisionId: 'decision-1',
      decision: 'deny',
    });
  });
});
