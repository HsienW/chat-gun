import { describe, expect, it, vi } from "vitest";

import { createOrderOperationRequestRecorder, toOrderOperationRequest } from "./operation-requests.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  attempt: 1,
  principal: {
    principalId: "synthetic-shopper-a",
    principalType: "user" as const,
    tenantId: "synthetic-tenant",
    roles: [],
    scopes: [],
    authSource: "trusted_gateway" as const,
    authenticatedAt: "2026-10-25T00:00:00.000Z",
  },
  scope: { scopeId: "synthetic-tenant", scopeType: "tenant" as const, tenantId: "synthetic-tenant" },
};

const descriptor = {
  approvalId: "approval-1",
  toolCallId: "call-1",
  scope: { tenantId: "synthetic-tenant", scopeId: "synthetic-tenant" },
};

const cancel = { toolName: "order_cancel", toolCallId: "call-1", input: { orderId: "ORD-1001", reasonCode: "other" } };

describe("order operation request summary", () => {
  it("keeps identifiers only for a cancel", () => {
    expect(
      toOrderOperationRequest({
        descriptor,
        call: { ...cancel, input: { ...cancel.input, note: "free text" } },
        executionContext,
      })
    ).toEqual({
      approvalId: "approval-1",
      tenantId: "synthetic-tenant",
      scopeId: "synthetic-tenant",
      principalId: "synthetic-shopper-a",
      toolCallId: "call-1",
      kind: "cancel",
      orderId: "ORD-1001",
    });
  });

  it("leaves out line items for a whole-order refund", () => {
    const request = toOrderOperationRequest({
      descriptor,
      call: { toolName: "order_refund_request", toolCallId: "call-1", input: { orderId: "ORD-1001", reasonCode: "damaged" } },
      executionContext,
    });

    expect(request).toMatchObject({ kind: "refund_request", orderId: "ORD-1001" });
    expect(request).not.toHaveProperty("lineItemIds");
  });

  it("records nothing for a tool that is not an order change", () => {
    expect(
      toOrderOperationRequest({
        descriptor,
        call: { toolName: "order_operation_status", toolCallId: "call-1", input: { orderId: "ORD-1001" } },
        executionContext,
      })
    ).toBeNull();
  });

  it.each([
    ["another tool call", { ...descriptor, toolCallId: "call-2" }],
    ["another tenant", { ...descriptor, scope: { tenantId: "other", scopeId: "synthetic-tenant" } }],
    ["another scope", { ...descriptor, scope: { tenantId: "synthetic-tenant", scopeId: "other" } }],
  ])("refuses an approval descriptor bound to %s", (_label, mismatched) => {
    expect(() => toOrderOperationRequest({ descriptor: mismatched, call: cancel, executionContext })).toThrow();
  });

  it("refuses invalid order arguments", () => {
    expect(() =>
      toOrderOperationRequest({
        descriptor,
        call: { ...cancel, input: { orderId: "../x", reasonCode: "other" } },
        executionContext,
      })
    ).toThrow();
  });

  it("audits and rethrows when the store fails, and passes other tools through", async () => {
    const audit = vi.fn(async () => undefined);
    const record = vi.fn(async () => {
      throw new Error("down");
    });
    const recorder = createOrderOperationRequestRecorder({ store: { record }, audit });

    await expect(recorder.record({ descriptor: descriptor as never, call: cancel, executionContext })).rejects.toThrow("down");
    expect(audit).toHaveBeenCalledWith(
      "shopping.order.request_not_recorded",
      { graphId: "shopping_assistant", toolName: "order_cancel" },
      executionContext
    );

    await recorder.record({
      descriptor: descriptor as never,
      call: { toolName: "kb_search", toolCallId: "call-1", input: {} },
      executionContext,
    });
    expect(record).toHaveBeenCalledOnce();
    expect(recorder.unavailableErrorCode).toBe("ORDER_DISPATCH_NOT_READY");
  });
});
