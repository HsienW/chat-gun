import { z } from "zod";

import { ORDER_OPERATION_STATES } from "../../agents/shopping-assistant/state.js";

export const ORDER_REFUND_REQUEST_TOOL_NAME = "order_refund_request";
export const ORDER_CANCEL_TOOL_NAME = "order_cancel";
export const ORDER_OPERATION_STATUS_TOOL_NAME = "order_operation_status";
export const ORDER_TOOL_VERSION = "1.0.0";

/** Synthetic order data and the mock provider carry no subject personal data (design §10). */
export const COMMERCE_DATA_CLASSIFICATION = "commerce:internal-synthetic";

export const ORDER_EFFECT_RESULT_VERSION = "order_effect_result@1";
export const ORDER_OPERATION_STATUS_VERSION = "order_operation_status@1";
export const ORDER_OPERATION_LOOKUP_VERSION = "order_operation_lookup@1";

/** Stable typed failures of the order tool and mock provider boundary (design §9). */
export const ORDER_FAILURE_CODES = [
  "ORDER_NOT_FOUND",
  "ORDER_NOT_ELIGIBLE",
  "ORDER_OPERATION_ALREADY_EXISTS",
  "ORDER_PROVIDER_UNAVAILABLE",
  "ORDER_PROVIDER_TIMEOUT",
  "ORDER_PROVIDER_RESPONSE_LOST",
] as const;
export type OrderFailureCode = (typeof ORDER_FAILURE_CODES)[number];

/** Failures raised before anything was committed; the claim is released. */
export const ORDER_NOT_COMMITTED_FAILURE_CODES: ReadonlySet<OrderFailureCode> = new Set([
  "ORDER_NOT_FOUND",
  "ORDER_NOT_ELIGIBLE",
  "ORDER_OPERATION_ALREADY_EXISTS",
  "ORDER_PROVIDER_UNAVAILABLE",
]);

export const ORDER_REASON_CODES = [
  "damaged",
  "wrong_item",
  "not_as_described",
  "no_longer_needed",
  "other",
] as const;

const orderIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const lineItemIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/**
 * Identity, tenant, scope and approval never come from model output: every
 * object is strict, so such fields are a schema error.
 */
export const orderRefundRequestInputSchema = z
  .object({
    orderId: orderIdSchema.describe("The order to refund."),
    lineItems: z
      .array(
        z
          .object({
            lineItemId: lineItemIdSchema,
            quantity: z.number().int().min(1),
          })
          .strict()
      )
      .min(1)
      .max(50)
      .refine(
        (items) => new Set(items.map((item) => item.lineItemId)).size === items.length,
        { message: "lineItemId must be unique" }
      )
      .optional()
      .describe("Line items to refund; omit to refund the whole order."),
    reasonCode: z.enum(ORDER_REASON_CODES),
    note: z.string().max(500).optional().describe("Optional note for the order system."),
  })
  .strict();
export type OrderRefundRequestInput = z.infer<typeof orderRefundRequestInputSchema>;

export const orderCancelInputSchema = z
  .object({
    orderId: orderIdSchema.describe("The order to cancel."),
    reasonCode: z.enum(ORDER_REASON_CODES),
    note: z.string().max(500).optional().describe("Optional note for the order system."),
  })
  .strict();
export type OrderCancelInput = z.infer<typeof orderCancelInputSchema>;

export const orderOperationStatusInputSchema = z
  .object({
    operationId: z.string().min(1).max(128).optional(),
    orderId: orderIdSchema.optional(),
  })
  .strict()
  .refine((input) => input.operationId !== undefined || input.orderId !== undefined, {
    message: "operationId or orderId is required",
  });
export type OrderOperationStatusInput = z.infer<typeof orderOperationStatusInputSchema>;

/**
 * Effect facts only: the ledger may hand this payload back for a later
 * submission, so it holds no operation identity or state (design §5.5).
 */
export const orderEffectResultSchema = z
  .object({
    schemaVersion: z.literal(ORDER_EFFECT_RESULT_VERSION),
    kind: z.enum(["refund_request", "cancel"]),
    orderId: orderIdSchema,
    effect: z.literal("committed"),
    externalOperationId: z.string().min(1),
    providerRecordedAt: z.string().datetime(),
  })
  .strict();
export type OrderEffectResult = z.infer<typeof orderEffectResultSchema>;

const dedupReasonSchema = z.enum([
  "committed_result_reused",
  "in_flight_duplicate",
  "original_outcome_unknown",
]);

export const orderOperationStatusSchema = z
  .object({
    schemaVersion: z.literal(ORDER_OPERATION_STATUS_VERSION),
    operationRef: z
      .object({ toolCallId: z.string().min(1), operationId: z.string().min(1).optional() })
      .strict(),
    kind: z.enum(["refund_request", "cancel"]),
    orderRef: z.object({ orderId: orderIdSchema }).strict(),
    state: z.enum(ORDER_OPERATION_STATES),
    stateVersion: z.number().int().min(1),
    businessEffectId: z.string().min(1).optional(),
    externalOperationId: z.string().min(1).optional(),
    dedup: z
      .object({ of: z.string().min(1).optional(), reason: dedupReasonSchema })
      .strict()
      .optional(),
    approvalExpiresAt: z.string().datetime().optional(),
    reasonCode: z.string().min(1).optional(),
    reconciliationTaskId: z.string().min(1).optional(),
  })
  .strict();
export type OrderOperationStatus = z.infer<typeof orderOperationStatusSchema>;

/** A lookup that finds nothing is a stable result, not a tool failure. */
export const orderOperationLookupResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(ORDER_OPERATION_LOOKUP_VERSION),
      outcome: z.literal("found"),
      status: orderOperationStatusSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ORDER_OPERATION_LOOKUP_VERSION),
      outcome: z.literal("not_found"),
      errorCode: z.literal("ORDER_OPERATION_NOT_FOUND"),
    })
    .strict(),
]);
export type OrderOperationLookupResult = z.infer<typeof orderOperationLookupResultSchema>;
