/**
 * Transport types and runtime validation for the shopping assistant cards
 * (design §8.2) and the tool approval interrupt. The backend Domain Constant
 * `OrderOperationState` is the source; this mirrors it for validation only.
 */

export const PRODUCT_RESULT_CARD_TYPE = 'product_result';
export const ORDER_OPERATION_STATUS_CARD_TYPE = 'order_operation_status';
const PRODUCT_RESULT_VERSION = 'product_result@1';
const ORDER_OPERATION_STATUS_VERSION = 'order_operation_status@1';
const TOOL_CONFIRMATION_TYPE = 'tool_authorization_confirmation';

export const ORDER_OPERATION_STATES = [
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
] as const;
export type OrderOperationState = (typeof ORDER_OPERATION_STATES)[number];

/** `outcome_unknown` is stable for the user but only reconciliation may move it, so it is not terminal. */
export const TERMINAL_ORDER_OPERATION_STATES: ReadonlySet<OrderOperationState> = new Set([
  'confirmed',
  'deduplicated',
  'failed',
  'approval_denied',
  'approval_expired',
  'cancelled_before_effect',
]);

export const ORDER_OPERATION_KINDS = ['refund_request', 'cancel'] as const;
export type OrderOperationKind = (typeof ORDER_OPERATION_KINDS)[number];

export const DEDUP_REASONS = [
  'committed_result_reused',
  'in_flight_duplicate',
  'original_outcome_unknown',
] as const;
export type DedupReason = (typeof DEDUP_REASONS)[number];

/** An unknown state value is kept as unknown and never mapped to a known state. */
export type OperationStateValue =
  | { known: true; value: OrderOperationState }
  | { known: false };

export interface ProductResultCard {
  citationId: string;
  sourceId: string;
  sourceVersion: number;
  title: string;
  snippet: string;
}

export interface OrderOperationStatusCard {
  operationRef: { toolCallId: string; operationId?: string };
  kind: OrderOperationKind;
  orderRef: { orderId: string };
  state: OperationStateValue;
  stateVersion: number;
  externalOperationId?: string;
  dedup?: { reason: DedupReason; of?: string };
  approvalExpiresAt?: string;
  reasonCode?: string;
  reconciliationTaskId?: string;
}

export type UnsupportedCardReason =
  | 'unknown_card_type'
  | 'unknown_schema_version'
  | 'invalid_payload';

export type CommerceCard =
  | { type: 'product_result'; card: ProductResultCard }
  | { type: 'order_operation_status'; card: OrderOperationStatusCard }
  | { type: 'unsupported'; cardType: string; reason: UnsupportedCardReason };

export interface ToolConfirmationRequest {
  schemaVersion: string;
  approvalId: string;
  decisionId: string;
  /** Server-provided approval deadline. */
  expiresAt: string;
}

export type ToolConfirmationDecision = 'approve' | 'deny';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseProductResult(record: Record<string, unknown>): ProductResultCard | undefined {
  const { citationId, sourceId, sourceVersion, title, snippet } = record;
  if (
    !nonEmptyString(citationId) ||
    !nonEmptyString(sourceId) ||
    typeof sourceVersion !== 'number' ||
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1 ||
    typeof title !== 'string' ||
    typeof snippet !== 'string'
  ) {
    return undefined;
  }
  return { citationId, sourceId, sourceVersion, title, snippet };
}

function parseOperationStatus(
  record: Record<string, unknown>
): OrderOperationStatusCard | undefined {
  const operationRef = asRecord(record.operationRef);
  const orderRef = asRecord(record.orderRef);
  const { kind, state, stateVersion } = record;
  if (
    !operationRef ||
    !nonEmptyString(operationRef.toolCallId) ||
    (operationRef.operationId !== undefined && !nonEmptyString(operationRef.operationId)) ||
    !orderRef ||
    !nonEmptyString(orderRef.orderId) ||
    !isOneOf(ORDER_OPERATION_KINDS, kind) ||
    typeof state !== 'string' ||
    typeof stateVersion !== 'number' ||
    !Number.isSafeInteger(stateVersion) ||
    stateVersion < 1
  ) {
    return undefined;
  }

  const optionalStrings = ['externalOperationId', 'reasonCode', 'reconciliationTaskId'] as const;
  if (optionalStrings.some((key) => record[key] !== undefined && !nonEmptyString(record[key]))) {
    return undefined;
  }
  if (record.approvalExpiresAt !== undefined && !isTimestamp(record.approvalExpiresAt)) {
    return undefined;
  }

  let dedup: OrderOperationStatusCard['dedup'];
  if (record.dedup !== undefined) {
    const value = asRecord(record.dedup);
    if (
      !value ||
      !isOneOf(DEDUP_REASONS, value.reason) ||
      (value.of !== undefined && !nonEmptyString(value.of))
    ) {
      return undefined;
    }
    dedup = { reason: value.reason, ...(nonEmptyString(value.of) ? { of: value.of } : {}) };
  }

  return {
    operationRef: {
      toolCallId: operationRef.toolCallId,
      ...(nonEmptyString(operationRef.operationId)
        ? { operationId: operationRef.operationId }
        : {}),
    },
    kind,
    orderRef: { orderId: orderRef.orderId },
    state: isOneOf(ORDER_OPERATION_STATES, state)
      ? { known: true, value: state }
      : { known: false },
    stateVersion,
    ...(nonEmptyString(record.externalOperationId)
      ? { externalOperationId: record.externalOperationId }
      : {}),
    ...(dedup ? { dedup } : {}),
    ...(isTimestamp(record.approvalExpiresAt)
      ? { approvalExpiresAt: record.approvalExpiresAt }
      : {}),
    ...(nonEmptyString(record.reasonCode) ? { reasonCode: record.reasonCode } : {}),
    ...(nonEmptyString(record.reconciliationTaskId)
      ? { reconciliationTaskId: record.reconciliationTaskId }
      : {}),
  };
}

const CARD_PARSERS = {
  [PRODUCT_RESULT_CARD_TYPE]: {
    version: PRODUCT_RESULT_VERSION,
    parse: (record: Record<string, unknown>): CommerceCard | undefined => {
      const card = parseProductResult(record);
      return card ? { type: 'product_result', card } : undefined;
    },
  },
  [ORDER_OPERATION_STATUS_CARD_TYPE]: {
    version: ORDER_OPERATION_STATUS_VERSION,
    parse: (record: Record<string, unknown>): CommerceCard | undefined => {
      const card = parseOperationStatus(record);
      return card ? { type: 'order_operation_status', card } : undefined;
    },
  },
} as const;

function isKnownCardType(cardType: string): cardType is keyof typeof CARD_PARSERS {
  return Object.prototype.hasOwnProperty.call(CARD_PARSERS, cardType);
}

/** Validates one `card.emit` payload; anything not understood degrades without guessing. */
export function parseCommerceCard(cardType: string, payload: unknown): CommerceCard {
  if (!isKnownCardType(cardType)) {
    return { type: 'unsupported', cardType, reason: 'unknown_card_type' };
  }
  const parser = CARD_PARSERS[cardType];
  const record = asRecord(payload);
  if (record && typeof record.schemaVersion === 'string' && record.schemaVersion !== parser.version) {
    return { type: 'unsupported', cardType, reason: 'unknown_schema_version' };
  }
  const parsed = record?.schemaVersion === parser.version ? parser.parse(record) : undefined;
  return parsed ?? { type: 'unsupported', cardType, reason: 'invalid_payload' };
}

/**
 * Reads the operations held in the server thread state, so a reloaded
 * conversation shows the authoritative state. Invalid records are skipped.
 */
export function parseOperationSnapshot(values: unknown): OrderOperationStatusCard[] {
  const operations = asRecord(asRecord(values)?.operations);
  if (!operations) return [];
  return Object.values(operations).flatMap((value) => {
    const record = asRecord(value);
    if (!record) return [];
    const card = parseOperationStatus({
      ...record,
      operationRef: { toolCallId: record.toolCallId, operationId: record.operationId },
      orderRef: { orderId: record.orderId },
    });
    return card ? [card] : [];
  });
}

export function parseToolConfirmationInterrupt(
  value: unknown
): ToolConfirmationRequest | undefined {
  const record = asRecord(value);
  const decisions = asRecord(record?.resumeCompatibility)?.decisions;
  if (
    !record ||
    record.type !== TOOL_CONFIRMATION_TYPE ||
    !nonEmptyString(record.schemaVersion) ||
    !nonEmptyString(record.approvalId) ||
    !nonEmptyString(record.decisionId) ||
    !isTimestamp(record.expiresAt) ||
    !Array.isArray(decisions) ||
    !decisions.includes('approve') ||
    !decisions.includes('deny')
  ) {
    return undefined;
  }
  return {
    schemaVersion: record.schemaVersion,
    approvalId: record.approvalId,
    decisionId: record.decisionId,
    expiresAt: record.expiresAt,
  };
}

export function createToolConfirmationResume(
  request: ToolConfirmationRequest,
  decision: ToolConfirmationDecision
) {
  return {
    type: TOOL_CONFIRMATION_TYPE,
    schemaVersion: request.schemaVersion,
    approvalId: request.approvalId,
    decisionId: request.decisionId,
    decision,
  };
}

export function isTerminalOperationState(state: OperationStateValue): boolean {
  return state.known && TERMINAL_ORDER_OPERATION_STATES.has(state.value);
}
