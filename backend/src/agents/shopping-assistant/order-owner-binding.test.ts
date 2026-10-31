import { describe, expect, it, vi } from "vitest";

import { MockOrderProvider } from "../../tools/orders/mock-order-provider.js";
import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { createConfiguredSyntheticOrderProvider, readOrderOwnerBinding } from "./order-owner-binding.js";
import { createOrderCancelTool, createOrderRefundRequestTool, createOrderToolSet, deriveCancelBusinessEffectKey, deriveRefundBusinessEffectKey } from "../../tools/orders/order-tools.js";
import { hashBusinessEffectKey } from "../../runtime/side-effect/identity.js";

const fixture = await loadSyntheticOrderFixture();
const enabled = {
  SHOPPING_ORDER_BINDING_ENABLED: "true",
  SHOPPING_ORDER_BINDING_SOURCE_TENANT: "public",
  SHOPPING_ORDER_BINDING_SOURCE_PRINCIPAL: "anonymous",
  SHOPPING_ORDER_BINDING_TARGET_TENANT: "synthetic-tenant",
  SHOPPING_ORDER_BINDING_TARGET_OWNER: "synthetic-shopper-a",
  SHOPPING_ORDER_BINDING_EPOCH: "e1",
};

describe("synthetic order owner binding configuration", () => {
  it("audits validated startup metadata without copying other environment values", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    await createConfiguredSyntheticOrderProvider({ env: { ...enabled, UNRELATED_VALUE: "must-not-log" }, fixture, audit });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith("order.owner_binding.configured", {
      isEnabled: true, ...readOrderOwnerBinding(enabled, fixture),
      datasetId: fixture.provenance.datasetId, datasetVersion: fixture.provenance.datasetVersion,
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("must-not-log");
  });

  it("audits disabled startup without an applied binding marker", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    await createConfiguredSyntheticOrderProvider({ env: {}, fixture, audit });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith("order.owner_binding.configured", {
      isEnabled: false, datasetId: fixture.provenance.datasetId, datasetVersion: fixture.provenance.datasetVersion,
    });
  });

  it("records only a stable reason on invalid startup", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    await expect(createConfiguredSyntheticOrderProvider({ env: { ...enabled, SHOPPING_ORDER_BINDING_EPOCH: "bad/epoch" }, fixture, audit })).rejects.toThrow("ORDER_BINDING_INVALID_FIELD");
    expect(audit.record).toHaveBeenCalledExactlyOnceWith("order.owner_binding.invalid", { reasonCode: "ORDER_BINDING_INVALID_FIELD" });
  });
  it("reproduces the unbound demo request returning ORDER_NOT_FOUND", async () => {
    const provider = new MockOrderProvider({ fixture });
    await expect(provider.submitRefund({
      requester: { tenantId: "public", principalId: "anonymous" },
      businessEffectKey: "baseline", orderId: "ORD-1001", reasonCode: "damaged",
    })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it.each([{}, { ...enabled, SHOPPING_ORDER_BINDING_ENABLED: "false" }])("defaults to disabled and ignores inactive fields", (env) => {
    expect(readOrderOwnerBinding(env, fixture)).toBeUndefined();
  });

  it("reads an explicit complete binding", () => {
    expect(readOrderOwnerBinding(enabled, fixture)).toEqual({
      sourceTenantId: "public", sourcePrincipalId: "anonymous",
      targetTenantId: "synthetic-tenant", targetOwnerPrincipalId: "synthetic-shopper-a", epoch: "e1",
    });
  });

  it.each(["", "yes", "1", "TRUE", " false "])("rejects invalid enabled flag %j", (flag) => {
    expect(() => readOrderOwnerBinding({ ...enabled, SHOPPING_ORDER_BINDING_ENABLED: flag }, fixture))
      .toThrow("ORDER_BINDING_INVALID_ENABLED");
  });

  for (const field of Object.keys(enabled).filter((key) => key !== "SHOPPING_ORDER_BINDING_ENABLED")) {
    it.each([undefined, "", " ", "x\ny", "x/y", "x".repeat(129)])(`rejects invalid ${field}: %j`, (value) => {
      expect(() => readOrderOwnerBinding({ ...enabled, [field]: value }, fixture))
        .toThrow("ORDER_BINDING_INVALID_FIELD");
    });
  }

  it("rejects a target pair absent from the fixture", () => {
    expect(() => readOrderOwnerBinding({ ...enabled, SHOPPING_ORDER_BINDING_TARGET_TENANT: "other" }, fixture))
      .toThrow("ORDER_BINDING_TARGET_NOT_FOUND");
  });
});

const scope = { tenantId: "public", principalId: "anonymous", scopeId: "demo-scope" };
const refund = { orderId: "ORD-1001", reasonCode: "damaged" as const };
const config = { configurable: { execution_context: {
  requestId: "request-demo", threadId: "thread-demo", runId: "run-demo", taskId: "task-demo", attempt: 1,
  principal: { principalId: scope.principalId, tenantId: scope.tenantId, principalType: "user", principalKind: "anonymous", roles: [], scopes: [], authSource: "development", authenticatedAt: "2026-10-24T00:00:00Z" },
  scope: { tenantId: scope.tenantId, scopeId: scope.scopeId, scopeType: "principal", ownerPrincipalId: scope.principalId },
} } };

describe("bound synthetic order operations", () => {
  const boundProvider = (epoch = "e1") => new MockOrderProvider({
    fixture, ownerBinding: readOrderOwnerBinding({ ...enabled, SHOPPING_ORDER_BINDING_EPOCH: epoch }, fixture),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });

  it("uses the same epoch key for the tool, ledger and reconciliation, retaining trusted identity", async () => {
    const provider = boundProvider();
    const submit = vi.spyOn(provider, "submitRefund");
    const audit = { record: vi.fn(async () => undefined) };
    const tool = createOrderRefundRequestTool({ provider, audit });
    const tools = createOrderToolSet({ provider, statusReader: { read: async () => null } });
    const descriptor = tools.descriptors.find((entry) => entry.toolName === "order_refund_request")!.sideEffect!;
    const key = hashBusinessEffectKey(descriptor.deriveBusinessEffectKey(refund, scope));
    const effect = await tool.invoke(refund, config);
    expect(effect).toMatchObject({ effect: "committed", orderId: "ORD-1001" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ businessEffectKey: key, requester: { tenantId: "public", principalId: "anonymous" } }));
    await expect(descriptor.reconcile!.reconcile({ businessEffectKey: key, toolExecutionId: "exec" })).resolves.toMatchObject({ state: "committed" });
    expect(audit.record).toHaveBeenCalledWith("order.owner_binding.applied", expect.objectContaining({ isOwnerBindingApplied: true, epoch: "e1", businessEffectKey: key }), config.configurable.execution_context);
  });

  it.each([
    [{ tenantId: "public", principalId: "other" }, "ORD-1001", "ORDER_NOT_FOUND"],
    [{ tenantId: "other", principalId: "anonymous" }, "ORD-1001", "ORDER_NOT_FOUND"],
    [scope, "ORD-2001", "ORDER_NOT_FOUND"],
    [scope, "missing", "ORDER_NOT_FOUND"],
    [scope, "ORD-1003", "ORDER_NOT_ELIGIBLE"],
  ])("preserves ownership and eligibility for %j / %s", async (requester, orderId, code) => {
    await expect(boundProvider().submitRefund({ requester, businessEffectKey: "test", orderId, reasonCode: "damaged" })).rejects.toMatchObject({ code });
  });

  it("keeps the exact legacy derivation when no epoch applies", () => {
    expect(deriveRefundBusinessEffectKey(refund, scope)).toBe('["order_refund_request@1","anonymous","ORD-1001","all"]');
    expect(deriveCancelBusinessEffectKey(refund, scope)).toBe('["order_cancel@1","anonymous","ORD-1001"]');
    const tools = createOrderToolSet({ provider: boundProvider(), statusReader: { read: async () => null } });
    expect(tools.descriptors[0]!.sideEffect!.deriveBusinessEffectKey(refund, { ...scope, tenantId: "other" }))
      .toBe('["order_refund_request@1","anonymous","ORD-1001","all"]');
  });

  it("uses the cancel descriptor's epoch key and audits the trusted requester", async () => {
    const provider = boundProvider();
    const audit = { record: vi.fn(async () => undefined) };
    const tools = createOrderToolSet({ provider, statusReader: { read: async () => null } });
    const cancel = { orderId: "ORD-1004", reasonCode: "no_longer_needed" as const };
    const descriptor = tools.descriptors[1]!.sideEffect!;
    const submit = vi.spyOn(provider, "submitCancel");
    await expect(createOrderCancelTool({ provider, audit }).invoke(cancel, config)).resolves.toMatchObject({ effect: "committed", kind: "cancel" });
    const key = hashBusinessEffectKey(descriptor.deriveBusinessEffectKey(cancel, scope));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ businessEffectKey: key }));
    expect(audit.record).toHaveBeenCalledWith("order.owner_binding.applied", expect.objectContaining({ tenantId: "public", principalId: "anonymous", runId: "run-demo", epoch: "e1" }), config.configurable.execution_context);
  });

  it("rejects non-synthetic provenance even at an untyped construction boundary", () => {
    expect(() => new MockOrderProvider({
      fixture: { ...fixture, provenance: { ...fixture.provenance,
        // @ts-expect-error Non-synthetic provenance is not accepted by the composition contract.
        synthetic: false,
      } }, ownerBinding: readOrderOwnerBinding(enabled, fixture),
    })).toThrow();
  });

  it("appends the epoch and changes only bound logical operations", () => {
    const key = (epoch: string) => createOrderToolSet({ provider: boundProvider(epoch), statusReader: { read: async () => null } }).descriptors[0]!.sideEffect!.deriveBusinessEffectKey(refund, scope);
    expect(key("e1")).toBe('["order_refund_request@1","anonymous","ORD-1001","all","e1"]');
    expect(key("e1")).toBe(key("e1"));
    expect(key("e2")).not.toBe(key("e1"));
  });

  it.each(["epoch", "ownerBinding", "sourcePrincipalId", "principalKind"])("rejects %s in model tool input", async (field) => {
    const provider = boundProvider();
    await expect(createOrderRefundRequestTool({ provider }).invoke({ ...refund, [field]: "e2" }, config)).rejects.toThrow();
    expect(provider.submissions).toBe(0);
  });

  it("does not emit applied-binding audit when the source does not match", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    await expect(createOrderRefundRequestTool({ provider: new MockOrderProvider({ fixture }), audit }).invoke(refund, config)).rejects.toThrow("ORDER_NOT_FOUND");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [{ unavailableBeforeDispatch: true }, "ORDER_PROVIDER_UNAVAILABLE", "failed_not_committed"],
    [{ afterDispatch: { kind: "timeout" as const, committed: true } }, "ORDER_PROVIDER_TIMEOUT", "ambiguous_after_dispatch"],
  ])("retains typed provider failure %s", async (faults, errorCode, outcomeType) => {
    const provider = new MockOrderProvider({ fixture, ownerBinding: readOrderOwnerBinding(enabled, fixture), faults, now: () => new Date("2026-10-24") });
    const audit = { record: vi.fn(async () => undefined) };
    await expect(createOrderRefundRequestTool({ provider, audit }).invoke(refund, config)).rejects.toMatchObject({ errorCode, outcomeType });
    if (outcomeType === "ambiguous_after_dispatch") {
      const descriptor = createOrderToolSet({ provider, statusReader: { read: async () => null } }).descriptors[0]!.sideEffect!;
      await expect(descriptor.reconcile!.reconcile({ toolExecutionId: "exec", businessEffectKey: hashBusinessEffectKey(descriptor.deriveBusinessEffectKey(refund, scope)) }))
        .resolves.toMatchObject({ state: "committed" });
    }
  });
});
