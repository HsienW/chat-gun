import { describe, expect, it } from "vitest";

import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { FIXTURE_SHOPPER_PRINCIPAL_ID, isolatedOrderFixture, liveCasePrincipalId, liveTenantId } from "./chain-isolation.js";

describe("live chain evaluation isolation (design §20.5 B1)", () => {
  it("derives one dedicated tenant per evaluation run under the run's cleanup prefix", () => {
    expect(liveTenantId("chain-eval-abc")).toBe("chain-eval-abc-live");
    expect(liveTenantId("chain-eval-abc").startsWith("chain-eval-abc-")).toBe(true);
    expect(liveTenantId("chain-eval-abc")).not.toBe(liveTenantId("chain-eval-xyz"));
  });

  it("gives every case its own synthetic principal, stable within a run", () => {
    const first = liveCasePrincipalId("run-1", "chain-eval-v1-refund-01");
    const second = liveCasePrincipalId("run-1", "chain-eval-v1-cancel-01");

    expect(first).toBe(liveCasePrincipalId("run-1", "chain-eval-v1-refund-01"));
    expect(first).not.toBe(second);
    expect(first).not.toBe(liveCasePrincipalId("run-2", "chain-eval-v1-refund-01"));
    expect(first).not.toBe(FIXTURE_SHOPPER_PRINCIPAL_ID);
  });

  it("moves the fixture shopper's orders to the case principal and keeps other owners", async () => {
    const fixture = await loadSyntheticOrderFixture();
    const principalId = liveCasePrincipalId("run-1", "case-1");

    const isolated = isolatedOrderFixture(fixture, "run-1-live", principalId);

    expect(isolated.orders).toHaveLength(fixture.orders.length);
    for (const [index, order] of isolated.orders.entries()) {
      const original = fixture.orders[index]!;
      expect(order.tenantId).toBe("run-1-live");
      expect(order.orderId).toBe(original.orderId);
      expect(order.ownerPrincipalId).toBe(
        original.ownerPrincipalId === FIXTURE_SHOPPER_PRINCIPAL_ID ? principalId : original.ownerPrincipalId
      );
    }
    expect(isolated.orders.some((order) => order.ownerPrincipalId !== principalId)).toBe(true);
  });

  it("leaves the fixture unchanged apart from the tenant when the principal is the fixture shopper", async () => {
    const fixture = await loadSyntheticOrderFixture();

    const isolated = isolatedOrderFixture(fixture, "tenant-x", FIXTURE_SHOPPER_PRINCIPAL_ID);

    expect(isolated.orders.map((order) => order.ownerPrincipalId)).toEqual(fixture.orders.map((order) => order.ownerPrincipalId));
  });
});
