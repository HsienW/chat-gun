import type { PrincipalContext } from "./identity.js";

export type IdentityAccessDenialReason = "CROSS_TENANT_DENIED";

export type IdentityAccessAudit = {
  principalId: string;
  accountId?: string;
  tenantId: string;
  resourceAccountId: string;
  resourceTenantId: string;
  reasonCode: IdentityAccessDenialReason;
};

export async function authorizeIdentityResourceAccess<T>(input: {
  principal: PrincipalContext;
  resource: { accountId: string; tenantId: string };
  downstream: () => Promise<T>;
  audit: (event: IdentityAccessAudit) => void | Promise<void>;
}): Promise<
  | { allowed: false; reasonCode: IdentityAccessDenialReason }
  | { allowed: true; value: T }
> {
  if (
    input.principal.accountId !== input.resource.accountId ||
    input.principal.tenantId !== input.resource.tenantId
  ) {
    const reasonCode = "CROSS_TENANT_DENIED" as const;
    await input.audit({
      principalId: input.principal.principalId,
      ...(input.principal.accountId ? { accountId: input.principal.accountId } : {}),
      tenantId: input.principal.tenantId,
      resourceAccountId: input.resource.accountId,
      resourceTenantId: input.resource.tenantId,
      reasonCode,
    });
    return { allowed: false, reasonCode };
  }
  return { allowed: true, value: await input.downstream() };
}
