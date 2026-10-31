import type { SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { OrderBindingConfigurationError, validateSyntheticOwnerBinding, type SyntheticOwnerBinding } from "../../tools/orders/synthetic-owner-binding.js";
import type { AuditLogger } from "../../platform/observability.js";
import { MockOrderProvider } from "../../tools/orders/mock-order-provider.js";

export function readOrderOwnerBinding(
  env: Readonly<Record<string, string | undefined>>,
  fixture: SyntheticOrderFixture,
): SyntheticOwnerBinding | undefined {
  const enabled = env.SHOPPING_ORDER_BINDING_ENABLED;
  if (enabled === undefined || enabled === "false") return undefined;
  if (enabled !== "true") throw new OrderBindingConfigurationError("ORDER_BINDING_INVALID_ENABLED");
  return validateSyntheticOwnerBinding({
    sourceTenantId: env.SHOPPING_ORDER_BINDING_SOURCE_TENANT,
    sourcePrincipalId: env.SHOPPING_ORDER_BINDING_SOURCE_PRINCIPAL,
    targetTenantId: env.SHOPPING_ORDER_BINDING_TARGET_TENANT,
    targetOwnerPrincipalId: env.SHOPPING_ORDER_BINDING_TARGET_OWNER,
    epoch: env.SHOPPING_ORDER_BINDING_EPOCH,
  }, fixture);
}

/** Only production composition reads configuration; evaluation constructs its provider directly. */
export async function createConfiguredSyntheticOrderProvider(input: {
  env: Readonly<Record<string, string | undefined>>;
  fixture: SyntheticOrderFixture;
  audit: AuditLogger;
}): Promise<MockOrderProvider> {
  let ownerBinding: SyntheticOwnerBinding | undefined;
  try {
    ownerBinding = readOrderOwnerBinding(input.env, input.fixture);
  } catch (error) {
    if (error instanceof OrderBindingConfigurationError) {
      await input.audit.record("order.owner_binding.invalid", { reasonCode: error.code });
    }
    throw error;
  }
  const provider = new MockOrderProvider({ fixture: input.fixture, ownerBinding });
  await input.audit.record("order.owner_binding.configured", {
    isEnabled: ownerBinding !== undefined,
    ...(ownerBinding ?? {}),
    datasetId: input.fixture.provenance.datasetId,
    datasetVersion: input.fixture.provenance.datasetVersion,
  });
  return provider;
}
