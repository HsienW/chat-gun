export const KNOWN_RESOURCE_TYPES = [
  "image_asset",
  "task",
  "step",
  "tool_execution",
  "product",
  "offer",
  "recommendation_card",
  "memory",
  "credential_ref",
] as const;

export type KnownResourceType = (typeof KNOWN_RESOURCE_TYPES)[number];

export interface ResourceRef {
  resourceType: string;
  resourceId: string;
  tenantId: string;
  accountId?: string;
  ownerScopeId?: string;
}

export function isKnownResourceType(
  resourceType: string
): resourceType is KnownResourceType {
  return (KNOWN_RESOURCE_TYPES as readonly string[]).includes(resourceType);
}

export function resourceTenantMatches(
  resource: ResourceRef,
  tenantId: string
): boolean {
  const resourceTenant = resource.tenantId.trim();
  const normalizedTenant = tenantId.trim();
  return (
    resourceTenant.length > 0 &&
    normalizedTenant.length > 0 &&
    resourceTenant === normalizedTenant
  );
}

export function resourceOwnerMatches(
  resource: ResourceRef,
  scopeId: string
): boolean {
  if (resource.ownerScopeId === undefined) return true;
  const ownerScopeId = resource.ownerScopeId.trim();
  const normalizedScopeId = scopeId.trim();
  return (
    ownerScopeId.length > 0 &&
    normalizedScopeId.length > 0 &&
    ownerScopeId === normalizedScopeId
  );
}
