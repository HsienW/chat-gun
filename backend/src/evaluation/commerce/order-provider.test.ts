import { afterEach, expect, it, vi } from "vitest";

import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { createEvaluationOrderProvider } from "./order-provider.js";

afterEach(() => vi.unstubAllEnvs());

it("ignores production binding environment in the actual evaluation provider factory", async () => {
  vi.stubEnv("SHOPPING_ORDER_BINDING_ENABLED", "true");
  vi.stubEnv("SHOPPING_ORDER_BINDING_SOURCE_TENANT", "public");
  vi.stubEnv("SHOPPING_ORDER_BINDING_SOURCE_PRINCIPAL", "anonymous");
  vi.stubEnv("SHOPPING_ORDER_BINDING_TARGET_TENANT", "synthetic-tenant");
  vi.stubEnv("SHOPPING_ORDER_BINDING_TARGET_OWNER", "synthetic-shopper-a");
  vi.stubEnv("SHOPPING_ORDER_BINDING_EPOCH", "e1");
  const provider = createEvaluationOrderProvider({ fixture: await loadSyntheticOrderFixture(), now: () => new Date("2026-10-24") });
  const requester = { tenantId: "public", principalId: "anonymous" };
  expect(provider.businessEffectEpoch(requester)).toBeUndefined();
  await expect(provider.submitRefund({ requester, businessEffectKey: "unbound", orderId: "ORD-1001", reasonCode: "damaged" })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  await expect(provider.submitRefund({ requester: { tenantId: "synthetic-tenant", principalId: "synthetic-shopper-a" }, businessEffectKey: "fixture-owner", orderId: "ORD-1001", reasonCode: "damaged" })).resolves.toMatchObject({ effect: "committed" });
});
