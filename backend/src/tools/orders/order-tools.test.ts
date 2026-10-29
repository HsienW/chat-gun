import { describe, expect, it, vi } from "vitest";

import { GovernedDispatchError } from "../../platform/tool-governance.js";
import { hashBusinessEffectKey } from "../../runtime/side-effect/identity.js";
import {
  orderCancelInputSchema,
  orderEffectResultSchema,
  orderOperationStatusInputSchema,
  orderRefundRequestInputSchema,
  type OrderOperationStatus,
} from "./order-contracts.js";
import { MockOrderProvider, type MockOrderProviderOptions } from "./mock-order-provider.js";
import {
  createOrderCancelTool,
  createOrderOperationStatusTool,
  createOrderRefundRequestTool,
  createOrderToolSet,
  deriveCancelBusinessEffectKey,
  deriveRefundBusinessEffectKey,
} from "./order-tools.js";
import {
  loadSyntheticOrderFixture,
  parseSyntheticOrderFixture,
  type SyntheticOrderFixture,
} from "./synthetic-orders.js";

const TENANT = "synthetic-tenant";
const SHOPPER_A = "synthetic-shopper-a";
const SHOPPER_B = "synthetic-shopper-b";

function configFor(principalId: string, overrides: { runId?: string; toolCallId?: string; attempt?: number } = {}) {
  return {
    configurable: {
      execution_context: {
        requestId: "request-1",
        threadId: "thread-1",
        runId: overrides.runId ?? "run-1",
        taskId: "task-1",
        stepId: "step-1",
        toolCallId: overrides.toolCallId ?? "tool-call-1",
        attempt: overrides.attempt ?? 1,
        principal: {
          principalId,
          principalType: "user",
          tenantId: TENANT,
          roles: [],
          scopes: [],
          authSource: "development",
          authenticatedAt: "2026-10-24T00:00:00.000Z",
        },
        scope: {
          scopeId: TENANT,
          scopeType: "tenant",
          tenantId: TENANT,
        },
      },
    },
  };
}

function trustedScope(principalId: string) {
  return { tenantId: TENANT, scopeId: TENANT, principalId };
}

let fixture: SyntheticOrderFixture;
async function provider(options: Partial<MockOrderProviderOptions> = {}) {
  fixture ??= await loadSyntheticOrderFixture();
  return new MockOrderProvider({
    fixture,
    now: () => new Date("2026-10-24T12:00:00.000Z"),
    createExternalOperationId: (() => {
      let next = 0;
      return () => `ext-${++next}`;
    })(),
    ...options,
  });
}

async function governedFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(GovernedDispatchError);
  const governed = error as GovernedDispatchError;
  return { outcomeType: governed.outcomeType, errorCode: governed.errorCode };
}

describe("synthetic order fixture", () => {
  it("is marked synthetic and covers refundable, ineligible, foreign and multi-line orders", async () => {
    const loaded = await loadSyntheticOrderFixture();

    expect(loaded.provenance).toMatchObject({ synthetic: true, dataClassification: "commerce:internal-synthetic" });
    expect(loaded.orders.some((order) => order.ownerPrincipalId === SHOPPER_B)).toBe(true);
    expect(loaded.orders.some((order) => order.lineItems.length > 1)).toBe(true);
    expect(loaded.orders.some((order) => Date.parse(order.refundWindowEndsAt) < Date.parse("2026-10-24"))).toBe(true);
  });

  it("rejects a fixture without synthetic provenance", async () => {
    const loaded = await loadSyntheticOrderFixture();

    expect(() =>
      parseSyntheticOrderFixture({ ...loaded, provenance: { ...loaded.provenance, synthetic: false } })
    ).toThrow();
    expect(() => parseSyntheticOrderFixture({ orders: loaded.orders })).toThrow();
  });
});

describe("order tool input schemas", () => {
  it.each([
    ["tenantId", { tenantId: TENANT }],
    ["principalId", { principalId: SHOPPER_B }],
    ["scopeId", { scopeId: TENANT }],
    ["approved", { approved: true }],
    ["approvalId", { approvalId: "approval-1" }],
  ])("rejects a refund input that carries %s", (_field, extra) => {
    expect(
      orderRefundRequestInputSchema.safeParse({ orderId: "ORD-1001", reasonCode: "damaged", ...extra }).success
    ).toBe(false);
    expect(
      orderCancelInputSchema.safeParse({ orderId: "ORD-1004", reasonCode: "other", ...extra }).success
    ).toBe(false);
  });

  it("rejects nested identity fields and duplicate line items", () => {
    expect(
      orderRefundRequestInputSchema.safeParse({
        orderId: "ORD-1002",
        reasonCode: "damaged",
        lineItems: [{ lineItemId: "LI-1002-1", quantity: 1, principalId: SHOPPER_B }],
      }).success
    ).toBe(false);
    expect(
      orderRefundRequestInputSchema.safeParse({
        orderId: "ORD-1002",
        reasonCode: "damaged",
        lineItems: [
          { lineItemId: "LI-1002-1", quantity: 1 },
          { lineItemId: "LI-1002-1", quantity: 2 },
        ],
      }).success
    ).toBe(false);
  });

  it("requires an operation or order identifier for the status lookup", () => {
    expect(orderOperationStatusInputSchema.safeParse({}).success).toBe(false);
    expect(orderOperationStatusInputSchema.safeParse({ orderId: "ORD-1001", tenantId: TENANT }).success).toBe(false);
    expect(orderOperationStatusInputSchema.safeParse({ operationId: "approval-1" }).success).toBe(true);
  });
});

describe("order business effect key", () => {
  const base = { orderId: "ORD-1002", reasonCode: "damaged" as const };

  it("ignores attempt, tool call, run, reason and note", () => {
    const first = deriveRefundBusinessEffectKey(
      { ...base, lineItems: [{ lineItemId: "LI-1002-1", quantity: 2 }] },
      trustedScope(SHOPPER_A)
    );
    const second = deriveRefundBusinessEffectKey(
      { ...base, reasonCode: "other", note: "different text", lineItems: [{ lineItemId: "LI-1002-1", quantity: 2 }] },
      trustedScope(SHOPPER_A)
    );

    expect(second).toBe(first);
    for (const identifier of ["run-1", "tool-call-1", "attempt", "damaged"]) {
      expect(first).not.toContain(identifier);
    }
    expect(deriveCancelBusinessEffectKey({ orderId: "ORD-1004", reasonCode: "other", note: "x" }, trustedScope(SHOPPER_A)))
      .toBe(deriveCancelBusinessEffectKey({ orderId: "ORD-1004", reasonCode: "damaged" }, trustedScope(SHOPPER_A)));
  });

  it("separates requesters, line items and quantities, and normalizes line item order", () => {
    const lines = [
      { lineItemId: "LI-1002-2", quantity: 1 },
      { lineItemId: "LI-1002-1", quantity: 2 },
    ];
    const key = deriveRefundBusinessEffectKey({ ...base, lineItems: lines }, trustedScope(SHOPPER_A));

    expect(deriveRefundBusinessEffectKey({ ...base, lineItems: [...lines].reverse() }, trustedScope(SHOPPER_A))).toBe(key);
    expect(deriveRefundBusinessEffectKey({ ...base, lineItems: lines }, trustedScope(SHOPPER_B))).not.toBe(key);
    expect(
      deriveRefundBusinessEffectKey({ ...base, lineItems: [{ lineItemId: "LI-1002-1", quantity: 2 }] }, trustedScope(SHOPPER_A))
    ).not.toBe(key);
    expect(
      deriveRefundBusinessEffectKey({ ...base, lineItems: [{ lineItemId: "LI-1002-1", quantity: 1 }, lines[0]!] }, trustedScope(SHOPPER_A))
    ).not.toBe(key);
    expect(deriveRefundBusinessEffectKey(base, trustedScope(SHOPPER_A))).not.toBe(key);
  });

  it("gives the provider the same hashed key the ledger derives", async () => {
    const orders = await provider();
    const submitRefund = vi.spyOn(orders, "submitRefund");
    const { descriptors } = createOrderToolSet({ provider: orders, statusReader: { read: async () => null } });
    const input = { orderId: "ORD-1001", reasonCode: "damaged" as const };

    await createOrderRefundRequestTool({ provider: orders }).invoke(
      input,
      configFor(SHOPPER_A, { runId: "run-9", toolCallId: "tool-call-9", attempt: 3 })
    );

    const ledgerKey = hashBusinessEffectKey(
      descriptors[0]!.sideEffect!.deriveBusinessEffectKey(input, trustedScope(SHOPPER_A))
    );
    expect(submitRefund).toHaveBeenCalledWith(expect.objectContaining({ businessEffectKey: ledgerKey }));
  });
});

describe("order mutation tools", () => {
  it("commits a refund and returns effect facts only", async () => {
    const orders = await provider();

    const result = await createOrderRefundRequestTool({ provider: orders }).invoke(
      { orderId: "ORD-1002", reasonCode: "damaged", lineItems: [{ lineItemId: "LI-1002-1", quantity: 2 }] },
      configFor(SHOPPER_A)
    );

    expect(orderEffectResultSchema.parse(result)).toEqual({
      schemaVersion: "order_effect_result@1",
      kind: "refund_request",
      orderId: "ORD-1002",
      effect: "committed",
      externalOperationId: "ext-1",
      providerRecordedAt: "2026-10-24T12:00:00.000Z",
    });
  });

  it("answers another shopper's order exactly like a missing order", async () => {
    const orders = await provider();
    const refund = createOrderRefundRequestTool({ provider: orders });

    const foreign = await governedFailure(
      refund.invoke({ orderId: "ORD-2001", reasonCode: "damaged" }, configFor(SHOPPER_A))
    );
    const missing = await governedFailure(
      refund.invoke({ orderId: "ORD-9999", reasonCode: "damaged" }, configFor(SHOPPER_A))
    );

    expect(foreign).toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_NOT_FOUND" });
    expect(missing).toEqual(foreign);
  });

  it("never turns a provider error into not found", async () => {
    const orders = await provider({ faults: { unavailableBeforeDispatch: true } });

    await expect(
      governedFailure(
        createOrderRefundRequestTool({ provider: orders }).invoke(
          { orderId: "ORD-9999", reasonCode: "damaged" },
          configFor(SHOPPER_A)
        )
      )
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_PROVIDER_UNAVAILABLE" });
  });

  it.each([
    ["an expired refund window", { orderId: "ORD-1003", reasonCode: "damaged" as const }],
    ["more than the purchased quantity", { orderId: "ORD-1002", reasonCode: "damaged" as const, lineItems: [{ lineItemId: "LI-1002-2", quantity: 2 }] }],
    ["a line item outside the order", { orderId: "ORD-1002", reasonCode: "damaged" as const, lineItems: [{ lineItemId: "LI-1001-1", quantity: 1 }] }],
    ["an order that has not been delivered", { orderId: "ORD-1004", reasonCode: "damaged" as const }],
  ])("rejects a refund for %s without committing", async (_case, input) => {
    const orders = await provider();

    await expect(
      governedFailure(createOrderRefundRequestTool({ provider: orders }).invoke(input, configFor(SHOPPER_A)))
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_NOT_ELIGIBLE" });
  });

  it("rejects a second refund of an already refunded line and a repeated logical operation", async () => {
    const orders = await provider();
    const refund = createOrderRefundRequestTool({ provider: orders });
    await refund.invoke({ orderId: "ORD-1001", reasonCode: "damaged" }, configFor(SHOPPER_A));

    await expect(
      governedFailure(refund.invoke({ orderId: "ORD-1001", reasonCode: "other" }, configFor(SHOPPER_A)))
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_OPERATION_ALREADY_EXISTS" });
    await expect(
      governedFailure(
        refund.invoke(
          { orderId: "ORD-1001", reasonCode: "damaged", lineItems: [{ lineItemId: "LI-1001-1", quantity: 1 }] },
          configFor(SHOPPER_A)
        )
      )
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_NOT_ELIGIBLE" });
  });

  it("cancels an order that has not shipped and refuses one that has", async () => {
    const orders = await provider();
    const cancel = createOrderCancelTool({ provider: orders });

    await expect(
      cancel.invoke({ orderId: "ORD-1004", reasonCode: "no_longer_needed" }, configFor(SHOPPER_A))
    ).resolves.toMatchObject({ kind: "cancel", orderId: "ORD-1004", effect: "committed" });
    await expect(
      governedFailure(cancel.invoke({ orderId: "ORD-1001", reasonCode: "other" }, configFor(SHOPPER_A)))
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "ORDER_NOT_ELIGIBLE" });
  });

  it("rejects before any provider call without a trusted execution context", async () => {
    const orders = await provider();

    await expect(
      governedFailure(createOrderRefundRequestTool({ provider: orders }).invoke({ orderId: "ORD-1001", reasonCode: "damaged" }))
    ).resolves.toEqual({ outcomeType: "rejected_before_dispatch", errorCode: "TOOL_EXECUTION_CONTEXT_UNAVAILABLE" });
    expect(orders.submissions).toBe(0);
  });
});

describe("order reconciliation", () => {
  it.each([
    ["response_lost" as const, true, "ORDER_PROVIDER_RESPONSE_LOST", { state: "committed" }],
    ["timeout" as const, false, "ORDER_PROVIDER_TIMEOUT", { state: "not_committed" }],
  ])("reports %s as ambiguous and reconciles by key", async (kind, committed, errorCode, expected) => {
    const orders = await provider({ faults: { afterDispatch: { kind, committed } } });
    const { descriptors } = createOrderToolSet({ provider: orders, statusReader: { read: async () => null } });
    const input = { orderId: "ORD-1001", reasonCode: "damaged" as const };

    await expect(
      governedFailure(createOrderRefundRequestTool({ provider: orders }).invoke(input, configFor(SHOPPER_A)))
    ).resolves.toEqual({ outcomeType: "ambiguous_after_dispatch", errorCode });

    const sideEffect = descriptors[0]!.sideEffect!;
    const reconciled = await sideEffect.reconcile!.reconcile({
      toolExecutionId: "execution-1",
      businessEffectKey: hashBusinessEffectKey(sideEffect.deriveBusinessEffectKey(input, trustedScope(SHOPPER_A))),
    });
    expect(reconciled).toMatchObject(expected);
  });

  it("stays unknown when the provider cannot determine the outcome", async () => {
    const orders = await provider({ faults: { lookupIndeterminate: true } });
    const { descriptors } = createOrderToolSet({ provider: orders, statusReader: { read: async () => null } });

    await expect(
      descriptors[1]!.sideEffect!.reconcile!.reconcile({
        toolExecutionId: "execution-1",
        businessEffectKey: hashBusinessEffectKey("anything"),
      })
    ).resolves.toEqual({ state: "unknown", reason: "ORDER_PROVIDER_LOOKUP_INDETERMINATE" });
  });

  it("stores and resolves the effect result as a reusable reference", async () => {
    const orders = await provider();
    const { descriptors } = createOrderToolSet({ provider: orders, statusReader: { read: async () => null } });
    const policy = descriptors[0]!.sideEffect!.resultReferencePolicy;
    const effect = await createOrderRefundRequestTool({ provider: orders }).invoke(
      { orderId: "ORD-1001", reasonCode: "damaged" },
      configFor(SHOPPER_A)
    );

    const reference = policy.toResultRef(effect);
    expect(reference).toMatchObject({ externalSystemNamespace: "mock-order-provider", externalOperationId: "ext-1" });
    await expect(policy.resolveResultRef(reference.payloadRef)).resolves.toEqual(effect);
    await expect(policy.resolveResultRef("{\"schemaVersion\":\"other\"}")).resolves.toBeNull();
    await expect(policy.resolveResultRef("not json")).resolves.toBeNull();
  });
});

describe("order operation status tool", () => {
  const status: OrderOperationStatus = {
    schemaVersion: "order_operation_status@1",
    operationRef: { toolCallId: "tool-call-1", operationId: "approval-1" },
    kind: "refund_request",
    orderRef: { orderId: "ORD-1001" },
    state: "awaiting_approval",
    stateVersion: 2,
  };

  it("passes only the trusted requester to the reader", async () => {
    const read = vi.fn(async () => status);

    await expect(
      createOrderOperationStatusTool({ reader: { read } }).invoke({ operationId: "approval-1" }, configFor(SHOPPER_A))
    ).resolves.toEqual({ schemaVersion: "order_operation_lookup@1", outcome: "found", status });
    expect(read).toHaveBeenCalledWith({ ...trustedScope(SHOPPER_A), operationId: "approval-1" });
  });

  it("reports a missing operation as a stable not-found result", async () => {
    await expect(
      createOrderOperationStatusTool({ reader: { read: async () => null } }).invoke({ orderId: "ORD-1001" }, configFor(SHOPPER_B))
    ).resolves.toEqual({
      schemaVersion: "order_operation_lookup@1",
      outcome: "not_found",
      errorCode: "ORDER_OPERATION_NOT_FOUND",
    });
  });

  it("never reports an unreadable store as not found", async () => {
    await expect(
      governedFailure(
        createOrderOperationStatusTool({
          reader: { read: async () => { throw new Error("connection refused"); } },
        }).invoke({ orderId: "ORD-1001" }, configFor(SHOPPER_A))
      )
    ).resolves.toEqual({ outcomeType: "failed_not_committed", errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE" });
  });
});
