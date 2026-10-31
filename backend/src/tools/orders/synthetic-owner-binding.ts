import { z } from "zod";

import type { SyntheticOrderFixture } from "./synthetic-orders.js";

/** Configuration identifiers, never natural-language matching rules. */
export const ORDER_BINDING_IDENTIFIER_MAX_LENGTH = 128;
const identifier = z.string().min(1).max(ORDER_BINDING_IDENTIFIER_MAX_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
export const syntheticOwnerBindingSchema = z.object({
  sourceTenantId: identifier,
  sourcePrincipalId: identifier,
  targetTenantId: identifier,
  targetOwnerPrincipalId: identifier,
  epoch: identifier,
}).strict();
export type SyntheticOwnerBinding = Readonly<z.infer<typeof syntheticOwnerBindingSchema>>;

export class OrderBindingConfigurationError extends Error {
  constructor(readonly code: "ORDER_BINDING_INVALID_ENABLED" | "ORDER_BINDING_INVALID_FIELD" | "ORDER_BINDING_TARGET_NOT_FOUND") {
    super(code);
    this.name = "OrderBindingConfigurationError";
  }
}

export function validateSyntheticOwnerBinding(binding: unknown, fixture: SyntheticOrderFixture): SyntheticOwnerBinding {
  const parsed = syntheticOwnerBindingSchema.safeParse(binding);
  if (!parsed.success) throw new OrderBindingConfigurationError("ORDER_BINDING_INVALID_FIELD");
  if (!fixture.orders.some((order) => order.tenantId === parsed.data.targetTenantId &&
    order.ownerPrincipalId === parsed.data.targetOwnerPrincipalId)) {
    throw new OrderBindingConfigurationError("ORDER_BINDING_TARGET_NOT_FOUND");
  }
  return Object.freeze(parsed.data);
}

export function matchesSyntheticOwnerBinding(
  binding: SyntheticOwnerBinding | undefined,
  requester: { tenantId: string; principalId: string },
): binding is SyntheticOwnerBinding {
  return binding !== undefined && binding.sourceTenantId === requester.tenantId &&
    binding.sourcePrincipalId === requester.principalId;
}
