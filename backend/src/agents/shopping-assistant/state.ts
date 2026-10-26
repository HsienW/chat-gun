import { Annotation, MessagesAnnotation, StateGraph } from "@langchain/langgraph";

import type {
  AuthorizationGraphState,
  ConfirmationOutcomeRecord,
} from "../../runtime/authorization/confirmation-graph.js";

/** Single source for the order operation lifecycle (design §7). */
export const ORDER_OPERATION_STATES = [
  "requested",
  "awaiting_approval",
  "approved",
  "executing",
  "confirmed",
  "deduplicated",
  "failed",
  "approval_denied",
  "approval_expired",
  "cancelled_before_effect",
  "outcome_unknown",
] as const;
export type OrderOperationState = (typeof ORDER_OPERATION_STATES)[number];

/**
 * Terminal for this submission. `outcome_unknown` is stable for the user but
 * not terminal: only reconciliation may move it forward.
 */
export const TERMINAL_ORDER_OPERATION_STATES: ReadonlySet<OrderOperationState> = new Set([
  "confirmed",
  "deduplicated",
  "failed",
  "approval_denied",
  "approval_expired",
  "cancelled_before_effect",
]);

export type OrderOperationKind = "refund_request" | "cancel";

export interface OrderOperationRecord {
  /** The submission's own tool call; the reducer key. */
  toolCallId: string;
  /** approvalId once the approval descriptor exists (design §6.7). */
  operationId?: string;
  kind: OrderOperationKind;
  orderId: string;
  state: OrderOperationState;
  /** Strictly increasing per toolCallId. */
  stateVersion: number;
  reasonCode?: string;
  dedup?: {
    of?: string;
    reason: "committed_result_reused" | "in_flight_duplicate" | "original_outcome_unknown";
  };
  /** Server-provided approval deadline while awaiting approval. */
  approvalExpiresAt?: string;
  /** From the effect result, including a reused one. */
  externalOperationId?: string;
}

export type OrderOperations = Readonly<Record<string, OrderOperationRecord>>;

/**
 * Merges by toolCallId. An update is accepted only with a larger stateVersion,
 * and a terminal operation ignores any non-terminal update. Different tool
 * calls never affect each other.
 */
export function reduceOrderOperations(
  current: OrderOperations,
  update: OrderOperations
): OrderOperations {
  let next: Record<string, OrderOperationRecord> | undefined;
  for (const [toolCallId, incoming] of Object.entries(update)) {
    const existing = current[toolCallId];
    if (existing !== undefined) {
      if (incoming.stateVersion <= existing.stateVersion) continue;
      if (
        TERMINAL_ORDER_OPERATION_STATES.has(existing.state) &&
        !TERMINAL_ORDER_OPERATION_STATES.has(incoming.state)
      ) {
        continue;
      }
    }
    next ??= { ...current };
    next[toolCallId] = incoming;
  }
  return next ?? current;
}

export const SHOPPING_INTENTS = [
  "product_lookup",
  "policy_question",
  "order_operation",
  "clarify",
  "unsupported",
] as const;
export type ShoppingIntent = (typeof SHOPPING_INTENTS)[number];

/** Closed rationale codes; only for evaluation and trace, never a branch condition. */
export const SHOPPING_INTENT_RATIONALE_CODES = [
  "asks_product_info",
  "asks_policy",
  "requests_order_change",
  "asks_order_status",
  "ambiguous",
  "multiple_requests",
  "out_of_scope",
] as const;
export type ShoppingIntentRationaleCode = (typeof SHOPPING_INTENT_RATIONALE_CODES)[number];

export const SHOPPING_ROUTE_FAILURE_CODES = [
  "INTENT_ROUTING_SCHEMA_INVALID",
  "INTENT_ROUTING_PROVIDER_ERROR",
  "INTENT_ROUTING_CANCELLED",
] as const;
export type ShoppingRouteFailureCode = (typeof SHOPPING_ROUTE_FAILURE_CODES)[number];

export interface ShoppingTurn {
  turnId: string;
  routedIntent: ShoppingIntent | null;
  routeStatus: "pending" | "routed" | "schema_invalid" | "provider_error" | "cancelled";
  rationaleCode?: ShoppingIntentRationaleCode;
  failureCode?: ShoppingRouteFailureCode;
}

export interface ShoppingTurnEvidence {
  citations: readonly { citationId: string; chunkId: string; sourceId: string }[];
}

export interface RuntimeEventCursor {
  runId: string;
  nextSequence: number;
}

/**
 * The only channels a run input may write (design §6.13). Everything else in
 * the state is written by graph nodes from server-side data.
 */
const shoppingInputChannels = {
  ...MessagesAnnotation.spec,
  kind: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  targetRunId: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
};

export const SHOPPING_ASSISTANT_INPUT_CHANNELS = Object.keys(shoppingInputChannels);

export const ShoppingAssistantInputAnnotation = Annotation.Root(shoppingInputChannels);

export const ShoppingAssistantStateAnnotation = Annotation.Root({
  ...shoppingInputChannels,
  toolQueue: Annotation<AuthorizationGraphState["toolQueue"]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  activeToolCall: Annotation<AuthorizationGraphState["activeToolCall"]>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  pendingAuthorization: Annotation<AuthorizationGraphState["pendingAuthorization"]>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  confirmationOutcome: Annotation<ConfirmationOutcomeRecord | null | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  /** Task admitted at the graph entry; a resume reattaches to it (design §6.15). */
  executionTaskId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  turn: Annotation<ShoppingTurn | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  turnEvidence: Annotation<ShoppingTurnEvidence | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  operations: Annotation<OrderOperations>({
    reducer: reduceOrderOperations,
    default: () => ({}),
  }),
  /** Replaced on every update so the checkpoint never accumulates events. */
  runtimeEvents: Annotation<readonly unknown[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  runtimeEventCursor: Annotation<RuntimeEventCursor | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type ShoppingAssistantState = typeof ShoppingAssistantStateAnnotation.State;

/** The shopping graph builder; run input is limited to the declared input channels. */
export function createShoppingAssistantStateGraph() {
  return new StateGraph({
    stateSchema: ShoppingAssistantStateAnnotation,
    input: ShoppingAssistantInputAnnotation,
  });
}
