import { z } from "zod";

import { structuredToolResultEnvelopeSchema } from "../../runtime/tool-dispatch/structured-tool-result.js";
import {
  ORDER_CANCEL_TOOL_NAME,
  ORDER_OPERATION_STATUS_VERSION,
  ORDER_REFUND_REQUEST_TOOL_NAME,
  orderCancelInputSchema,
  orderEffectResultSchema,
  orderOperationStatusSchema,
  orderRefundRequestInputSchema,
  type OrderOperationStatus,
} from "../../tools/orders/order-contracts.js";
import type { CardEmission } from "./card-events.js";
import {
  TERMINAL_ORDER_OPERATION_STATES,
  type OrderOperationKind,
  type OrderOperationRecord,
  type OrderOperationState,
} from "./state.js";

export const ORDER_OPERATION_STATUS_CARD_TYPE = "order_operation_status";

/** Order id shown when the model's arguments carry none that is valid. */
const UNIDENTIFIED_ORDER_ID = "unidentified";

const MUTATION_KINDS: Readonly<Record<string, OrderOperationKind>> = {
  [ORDER_REFUND_REQUEST_TOOL_NAME]: "refund_request",
  [ORDER_CANCEL_TOOL_NAME]: "cancel",
};

const MUTATION_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  [ORDER_REFUND_REQUEST_TOOL_NAME]: orderRefundRequestInputSchema,
  [ORDER_CANCEL_TOOL_NAME]: orderCancelInputSchema,
};

export function orderMutationKind(toolName: string): OrderOperationKind | undefined {
  return MUTATION_KINDS[toolName];
}

export interface OrderToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

/**
 * A model-proposed order change. Invalid arguments end as `failed` with
 * ORDER_INPUT_INVALID before any approval exists (design §9).
 */
export function requestOperation(call: OrderToolCall): { record: OrderOperationRecord; inputValid: boolean } {
  const kind = orderMutationKind(call.toolName);
  if (kind === undefined) throw new Error(`Not an order mutation tool: ${call.toolName}`);
  const parsed = MUTATION_INPUT_SCHEMAS[call.toolName]!.safeParse(call.input);
  const orderId = parsed.success ? (parsed.data as { orderId: string }).orderId : UNIDENTIFIED_ORDER_ID;
  return parsed.success
    ? { inputValid: true, record: { toolCallId: call.toolCallId, kind, orderId, state: "requested", stateVersion: 1 } }
    : {
        inputValid: false,
        record: {
          toolCallId: call.toolCallId,
          kind,
          orderId,
          state: "failed",
          stateVersion: 1,
          reasonCode: "ORDER_INPUT_INVALID",
        },
      };
}

export function advanceOperation(
  record: OrderOperationRecord,
  update: Partial<Omit<OrderOperationRecord, "toolCallId" | "kind" | "orderId" | "stateVersion">> & {
    state: OrderOperationState;
  }
): OrderOperationRecord {
  return { ...record, ...update, stateVersion: record.stateVersion + 1 };
}

export function isTerminalOperation(record: OrderOperationRecord): boolean {
  return TERMINAL_ORDER_OPERATION_STATES.has(record.state);
}

/** What a tool message tells about one order operation; parsed from structured fields only. */
export type OrderToolResult =
  | { kind: "confirmed"; externalOperationId: string }
  | {
      kind: "deduplicated";
      reason: "committed_result_reused" | "in_flight_duplicate" | "original_outcome_unknown";
      originalBusinessEffectId: string;
      externalOperationId?: string;
    }
  | { kind: "failed"; reasonCode: string }
  | { kind: "outcome_unknown"; reasonCode: string }
  | { kind: "cancelled_before_effect"; reasonCode?: string }
  | { kind: "approval_denied" }
  | { kind: "approval_expired" };

const confirmationFailureSchema = z
  .object({
    errorCode: z.string().min(1),
    confirmationOutcome: z.enum(["denied", "expired", "withdrawn"]).optional(),
  })
  .strict();

/** Tool message content and envelope results may arrive as JSON text. */
export function parseToolContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function inputFailureCode(errorCode: string): string {
  return errorCode === "TOOL_INPUT_VALIDATION_FAILED" ? "ORDER_INPUT_INVALID" : errorCode;
}

/** Reads the result of one order tool call; anything unrecognised is an unknown outcome, never success. */
export function readOrderToolResult(content: unknown): OrderToolResult {
  const payload = parseToolContent(content);
  const envelope = structuredToolResultEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    const failure = confirmationFailureSchema.safeParse(payload);
    if (!failure.success) return { kind: "outcome_unknown", reasonCode: "ORDER_TOOL_RESULT_INVALID" };
    switch (failure.data.confirmationOutcome) {
      case "denied":
        return { kind: "approval_denied" };
      case "expired":
        return { kind: "approval_expired" };
      case "withdrawn":
        return { kind: "cancelled_before_effect", reasonCode: failure.data.errorCode };
      default:
        // Nothing was dispatched: authorization or binding failures never committed.
        return { kind: "failed", reasonCode: inputFailureCode(failure.data.errorCode) };
    }
  }
  const outcome = envelope.data.outcome;
  switch (outcome.type) {
    case "succeeded": {
      const effect = orderEffectResultSchema.safeParse(parseToolContent(outcome.result));
      return effect.success
        ? { kind: "confirmed", externalOperationId: effect.data.externalOperationId }
        : { kind: "outcome_unknown", reasonCode: "ORDER_EFFECT_RESULT_INVALID" };
    }
    case "deduplicated": {
      const effect = outcome.result === undefined
        ? undefined
        : orderEffectResultSchema.safeParse(parseToolContent(outcome.result));
      return {
        kind: "deduplicated",
        reason: outcome.reason,
        originalBusinessEffectId: outcome.original.businessEffectId,
        ...(effect?.success ? { externalOperationId: effect.data.externalOperationId } : {}),
      };
    }
    case "rejected_before_dispatch":
    case "denied_by_authorization":
    case "failed_not_committed":
      return { kind: "failed", reasonCode: inputFailureCode(outcome.errorCode) };
    case "ambiguous_after_dispatch":
      return { kind: "outcome_unknown", reasonCode: outcome.errorCode };
    case "cancelled":
      // A cancel after dispatch cannot stop the effect; it is never shown as cancelled.
      return outcome.dispatchState === "before"
        ? { kind: "cancelled_before_effect", reasonCode: "USER_CANCELLED" }
        : { kind: "outcome_unknown", reasonCode: "CANCELLED_AFTER_DISPATCH" };
    case "confirmation_required":
      return { kind: "failed", reasonCode: "REQUIRES_CONFIRMATION" };
  }
}

/** Settles an operation with its tool result; `dedupOf` is the original approval when it could be resolved. */
export function settleOperation(
  record: OrderOperationRecord,
  result: OrderToolResult,
  dedupOf?: string
): OrderOperationRecord {
  switch (result.kind) {
    case "confirmed":
      return advanceOperation(record, { state: "confirmed", externalOperationId: result.externalOperationId });
    case "deduplicated":
      return advanceOperation(record, {
        state: "deduplicated",
        dedup: { reason: result.reason, ...(dedupOf ? { of: dedupOf } : {}) },
        ...(result.externalOperationId ? { externalOperationId: result.externalOperationId } : {}),
      });
    case "failed":
      return advanceOperation(record, { state: "failed", reasonCode: result.reasonCode });
    case "outcome_unknown":
      return advanceOperation(record, { state: "outcome_unknown", reasonCode: result.reasonCode });
    case "cancelled_before_effect":
      return advanceOperation(record, {
        state: "cancelled_before_effect",
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      });
    case "approval_denied":
      return advanceOperation(record, { state: "approval_denied" });
    case "approval_expired":
      return advanceOperation(record, { state: "approval_expired" });
  }
}

/** The card mirrors the record; machine fields only, labels belong to the client (design §8.2). */
export function toOperationStatusCard(record: OrderOperationRecord): OrderOperationStatus {
  return orderOperationStatusSchema.parse({
    schemaVersion: ORDER_OPERATION_STATUS_VERSION,
    operationRef: {
      toolCallId: record.toolCallId,
      ...(record.operationId ? { operationId: record.operationId } : {}),
    },
    kind: record.kind,
    orderRef: { orderId: record.orderId },
    state: record.state,
    stateVersion: record.stateVersion,
    ...(record.externalOperationId ? { externalOperationId: record.externalOperationId } : {}),
    ...(record.dedup ? { dedup: record.dedup } : {}),
    ...(record.approvalExpiresAt ? { approvalExpiresAt: record.approvalExpiresAt } : {}),
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
  });
}

export function toOperationCardEmissions(records: readonly OrderOperationRecord[]): CardEmission[] {
  return records.map((record) => ({
    cardType: ORDER_OPERATION_STATUS_CARD_TYPE,
    data: toOperationStatusCard(record),
  }));
}
