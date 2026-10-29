import type { AuditPayload } from "../../platform/observability.js";
import type { ConfirmationRequestRecorder } from "../../runtime/authorization/confirmation-graph.js";
import type { ExecutionContext } from "../../runtime/execution-context/execution-context.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import {
  ORDER_REFUND_REQUEST_TOOL_NAME,
  orderCancelInputSchema,
  orderRefundRequestInputSchema,
} from "../../tools/orders/order-contracts.js";
import { orderMutationKind } from "./order-operations.js";
import type { OrderOperationKind } from "./state.js";

/**
 * Identifiers of one order change, stored with its approval so the status
 * lookup can name the order (design §6.7). No note, reason or quantity.
 */
export interface OrderOperationRequest {
  approvalId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
  toolCallId: string;
  kind: OrderOperationKind;
  orderId: string;
  /** Sorted line item ids of a partial refund; absent for a whole order. */
  lineItemIds?: string[];
}

export interface OrderOperationRequestStore {
  record(request: OrderOperationRequest): Promise<void>;
}

/** Without a runtime database no approval may be created for an order change. */
export const unavailableOrderOperationRequestStore: OrderOperationRequestStore = {
  record: async () => {
    throw new Error("Order operation request store is unavailable");
  },
};

/** Insert-only; a summary is never updated, state always comes from approvals and the ledger. */
export class PgOrderOperationRequestStore implements OrderOperationRequestStore {
  constructor(private readonly db: Queryable) {}

  async record(request: OrderOperationRequest): Promise<void> {
    await this.db.query(
      `INSERT INTO order_operation_requests (
         approval_id, tenant_id, scope_id, principal_id, tool_call_id,
         kind, order_id, line_item_ids
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (approval_id) DO NOTHING`,
      [
        request.approvalId,
        request.tenantId,
        request.scopeId,
        request.principalId,
        request.toolCallId,
        request.kind,
        request.orderId,
        request.lineItemIds ?? null,
      ]
    );
  }
}

/**
 * Builds the summary from the server-side descriptor and execution context;
 * any mismatch between them is an error, so no approval is created.
 */
export function toOrderOperationRequest(input: {
  descriptor: { approvalId: string; toolCallId?: string; scope: { tenantId: string; scopeId: string } };
  call: { toolName: string; toolCallId: string; input: unknown };
  executionContext: ExecutionContext;
}): OrderOperationRequest | null {
  const kind = orderMutationKind(input.call.toolName);
  if (kind === undefined) return null;
  const { descriptor, call, executionContext } = input;
  if (
    descriptor.toolCallId !== call.toolCallId ||
    descriptor.scope.tenantId !== executionContext.scope.tenantId ||
    descriptor.scope.scopeId !== executionContext.scope.scopeId
  ) {
    throw new Error("Approval descriptor does not match the order tool call");
  }
  const base = {
    approvalId: descriptor.approvalId,
    tenantId: executionContext.scope.tenantId,
    scopeId: executionContext.scope.scopeId,
    principalId: executionContext.principal.principalId,
    toolCallId: call.toolCallId,
    kind,
  };
  if (call.toolName === ORDER_REFUND_REQUEST_TOOL_NAME) {
    const refund = orderRefundRequestInputSchema.parse(call.input);
    return {
      ...base,
      orderId: refund.orderId,
      ...(refund.lineItems !== undefined
        ? { lineItemIds: refund.lineItems.map((item) => item.lineItemId).sort() }
        : {}),
    };
  }
  return { ...base, orderId: orderCancelInputSchema.parse(call.input).orderId };
}

/** Records order changes before their approval exists; other tools pass through (design §6.7). */
export function createOrderOperationRequestRecorder(dependencies: {
  store: OrderOperationRequestStore;
  audit: (eventName: string, payload: AuditPayload, context?: ExecutionContext) => Promise<void>;
}): ConfirmationRequestRecorder {
  return {
    unavailableErrorCode: "ORDER_DISPATCH_NOT_READY",
    async record(input) {
      try {
        const request = toOrderOperationRequest(input);
        if (request !== null) await dependencies.store.record(request);
      } catch (error) {
        await dependencies
          .audit(
            "shopping.order.request_not_recorded",
            { graphId: "shopping_assistant", toolName: input.call.toolName },
            input.executionContext
          )
          .catch(() => undefined);
        throw error;
      }
    },
  };
}
