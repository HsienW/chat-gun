import type { Queryable } from "../../runtime/persistence/rows.js";
import {
  ORDER_OPERATION_STATUS_VERSION,
  orderOperationStatusSchema,
  type OrderOperationStatus,
} from "../../tools/orders/order-contracts.js";
import type {
  OrderOperationStatusQuery,
  OrderOperationStatusReader,
} from "../../tools/orders/order-tools.js";
import type { OriginalOperationResolver } from "./original-operation.js";
import type { OrderOperationState } from "./state.js";

/**
 * Lifecycle rank of a looked-up state (design §5.3). A lookup is its own tool
 * result and is never merged into the conversation's card reducer.
 */
const STATE_RANK: Readonly<Record<OrderOperationState, number>> = {
  requested: 1,
  awaiting_approval: 2,
  approved: 3,
  executing: 4,
  outcome_unknown: 5,
  confirmed: 6,
  deduplicated: 6,
  failed: 6,
  approval_denied: 6,
  approval_expired: 6,
  cancelled_before_effect: 6,
};

interface RequestRow extends Record<string, unknown> {
  approval_id: unknown;
  tool_call_id: unknown;
  kind: unknown;
  order_id: unknown;
  decision_id: unknown;
  approval_status: unknown;
  expires_at: unknown;
  withdrawn_at: unknown;
}

interface ExecutionRow extends Record<string, unknown> {
  execution_status: unknown;
  termination_cause: unknown;
  business_effect_id: unknown;
  commit_state: unknown;
  released_at: unknown;
  external_operation_id: unknown;
  reconciliation_task_id: unknown;
}

type StatusFields = Omit<OrderOperationStatus, "schemaVersion" | "operationRef" | "kind" | "orderRef" | "stateVersion">;

function text(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid order operation column: ${column}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown, column: string): Date {
  const date = value instanceof Date ? value : new Date(text(value, column));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid order operation column: ${column}`);
  return date;
}

export interface PgOrderOperationStatusReaderOptions {
  originalOperationResolver: OriginalOperationResolver;
  now?: () => Date;
}

/**
 * Reads the operation summary, the approval record and the ledger only; never
 * conversation state. Nothing is written: an overdue pending approval is
 * reported as expired and left for `consume` to decide (design §6.1 step 6).
 */
export class PgOrderOperationStatusReader implements OrderOperationStatusReader {
  constructor(
    private readonly db: Queryable,
    private readonly options: PgOrderOperationStatusReaderOptions
  ) {}

  async read(query: OrderOperationStatusQuery): Promise<OrderOperationStatus | null> {
    if (query.operationId === undefined && query.orderId === undefined) return null;
    const requests = await this.db.query<RequestRow>(
      `SELECT r.approval_id, r.tool_call_id, r.kind, r.order_id,
              c.decision_id, c.status AS approval_status, c.expires_at, c.withdrawn_at
         FROM order_operation_requests r
         JOIN authorization_confirmations c ON c.approval_id = r.approval_id
        WHERE r.tenant_id = $1 AND r.scope_id = $2 AND r.principal_id = $3
          AND c.tenant_id = $1 AND c.scope_id = $2 AND $3 = ANY(c.principal_ids)
          AND ($4::text IS NULL OR r.approval_id = $4)
          AND ($5::text IS NULL OR r.order_id = $5)
        ORDER BY r.created_at DESC, r.approval_id DESC
        LIMIT 1`,
      [query.tenantId, query.scopeId, query.principalId, query.operationId ?? null, query.orderId ?? null]
    );
    const request = requests.rows[0];
    if (request === undefined) return null;

    const fields = await this.resolveState(request, query);
    return orderOperationStatusSchema.parse({
      schemaVersion: ORDER_OPERATION_STATUS_VERSION,
      operationRef: { toolCallId: text(request.tool_call_id, "tool_call_id"), operationId: text(request.approval_id, "approval_id") },
      kind: request.kind,
      orderRef: { orderId: text(request.order_id, "order_id") },
      stateVersion: STATE_RANK[fields.state],
      ...fields,
    });
  }

  private async resolveState(request: RequestRow, query: OrderOperationStatusQuery): Promise<StatusFields> {
    const expiresAt = timestamp(request.expires_at, "expires_at");
    switch (request.approval_status) {
      case "pending":
        return expiresAt.getTime() <= (this.options.now?.() ?? new Date()).getTime()
          ? { state: "approval_expired" }
          : { state: "awaiting_approval", approvalExpiresAt: expiresAt.toISOString() };
      case "expired":
        return { state: "approval_expired" };
      case "denied":
        return request.withdrawn_at === null || request.withdrawn_at === undefined
          ? { state: "approval_denied" }
          : { state: "cancelled_before_effect", reasonCode: "CONFIRMATION_CANCELLED" };
      case "approved":
        return this.resolveExecution(text(request.decision_id, "decision_id"), query);
      default:
        throw new Error("Unknown authorization confirmation status");
    }
  }

  private async resolveExecution(decisionId: string, query: OrderOperationStatusQuery): Promise<StatusFields> {
    const executions = await this.db.query<ExecutionRow>(
      `SELECT e.status AS execution_status, e.termination_cause,
              b.business_effect_id, b.commit_state, b.released_at, b.external_operation_id,
              t.reconciliation_task_id
         FROM tool_executions e
         JOIN business_effects b ON b.business_effect_id = e.business_effect_id
         LEFT JOIN reconciliation_tasks t
           ON t.business_effect_id = b.business_effect_id AND t.status = 'open'
        WHERE e.decision_id = $1 AND b.tenant_id = $2 AND b.scope_id = $3
        ORDER BY e.created_at DESC
        LIMIT 1`,
      [decisionId, query.tenantId, query.scopeId]
    );
    const execution = executions.rows[0];
    // Approved but nothing dispatched yet, or rejected before any claim.
    if (execution === undefined) return { state: "approved" };

    const businessEffectId = text(execution.business_effect_id, "business_effect_id");
    const externalOperationId = optionalText(execution.external_operation_id);
    const commitState = execution.commit_state;
    const released = execution.released_at !== null && execution.released_at !== undefined;

    if (execution.termination_cause === "deduplicated") {
      const original = await this.options.originalOperationResolver.resolveApprovalId({
        businessEffectId,
        tenantId: query.tenantId,
        scopeId: query.scopeId,
        principalId: query.principalId,
      });
      // The ledger keeps no reason for a held-off submission; the original's current state decides.
      const reason = execution.execution_status === "committed"
        ? "committed_result_reused"
        : commitState === "unknown"
          ? "original_outcome_unknown"
          : "in_flight_duplicate";
      return {
        state: "deduplicated",
        businessEffectId,
        dedup: { reason, ...(original ? { of: original } : {}) },
        ...(reason === "committed_result_reused" && externalOperationId ? { externalOperationId } : {}),
      };
    }

    const reconciliationTaskId = optionalText(execution.reconciliation_task_id);
    if (commitState === "committed" && execution.execution_status === "committed") {
      return { state: "confirmed", businessEffectId, ...(externalOperationId ? { externalOperationId } : {}) };
    }
    if (reconciliationTaskId !== undefined || commitState === "unknown" || execution.execution_status === "unknown") {
      return {
        state: "outcome_unknown",
        businessEffectId,
        ...(reconciliationTaskId ? { reconciliationTaskId } : {}),
      };
    }
    if (commitState === "prepared" && released && execution.execution_status === "failed") {
      return execution.termination_cause === "cancelled_before_dispatch"
        ? { state: "cancelled_before_effect", businessEffectId, reasonCode: "USER_CANCELLED" }
        : { state: "failed", businessEffectId };
    }
    if (
      commitState === "prepared" &&
      !released &&
      (execution.execution_status === "prepared" || execution.execution_status === "executing")
    ) {
      return { state: "executing", businessEffectId };
    }
    return { state: "outcome_unknown", businessEffectId, reasonCode: "ORDER_OPERATION_STATE_INDETERMINATE" };
  }
}
