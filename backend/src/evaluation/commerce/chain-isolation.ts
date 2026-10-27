import { parseSyntheticOrderFixture, type SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";

/** The synthetic shopper who owns the orders of synthetic-orders-v1 that the cases act on. */
export const FIXTURE_SHOPPER_PRINCIPAL_ID = "synthetic-shopper-a";

/**
 * The one dedicated tenant of a live run (design §20.5 B1). It shares the run's
 * `<evaluationRunId>-` prefix, so the runtime cleanup removes its rows too.
 */
export function liveTenantId(evaluationRunId: string): string {
  return `${evaluationRunId}${LIVE_TENANT_SUFFIX}`;
}

const LIVE_TENANT_SUFFIX = "-live";

/** Only a tenant named by `liveTenantId` may be purged by the live layer. */
export function isLiveTenantId(tenantId: string): boolean {
  return tenantId.endsWith(LIVE_TENANT_SUFFIX) && tenantId.length > LIVE_TENANT_SUFFIX.length;
}

/**
 * A synthetic principal per case: the business effect key holds the principal
 * but not the tenant, so cases sharing the live tenant never share a ledger entry.
 */
export function liveCasePrincipalId(evaluationRunId: string, caseId: string): string {
  return `synthetic-eval-${evaluationRunId}-${caseId}`;
}

/** The fixture placed in `tenantId`, with the fixture shopper's orders owned by `principalId`. */
export function isolatedOrderFixture(fixture: SyntheticOrderFixture, tenantId: string, principalId: string): SyntheticOrderFixture {
  return parseSyntheticOrderFixture({
    ...fixture,
    orders: fixture.orders.map((order) => ({
      ...order,
      tenantId,
      ownerPrincipalId: order.ownerPrincipalId === FIXTURE_SHOPPER_PRINCIPAL_ID ? principalId : order.ownerPrincipalId,
    })),
  });
}
