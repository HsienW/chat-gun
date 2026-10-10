import { randomUUID } from "node:crypto";

import {
  AUTHORIZATION_EFFECTS,
  AUTHORIZATION_REASON_CODES,
  type AuthorizationDecision,
  type AuthorizationEffect,
  type AuthorizationPolicy,
  type AuthorizationReasonCode,
  type AuthorizationRequest,
  type PolicyEffect,
  type ScopeAccess,
} from "@gun-ai/harness-contracts";

import type { GrantStore, StoredPermissionGrant } from "./grant-store.js";
import type { PrincipalContext } from "./principal.js";
import type { ResourceRef } from "./resource-ref.js";
import { isActiveScopePresent } from "./scope.js";
import type { RuntimeScope } from "./scope.js";

export { AUTHORIZATION_EFFECTS, AUTHORIZATION_REASON_CODES } from "@gun-ai/harness-contracts";
export type {
  AuthorizationDecision,
  AuthorizationEffect,
  AuthorizationPolicy,
  AuthorizationReasonCode,
  AuthorizationRequest,
  PolicyEffect,
  ScopeAccess,
} from "@gun-ai/harness-contracts";

export interface AuthorizationEvaluationInput {
  policy: AuthorizationPolicy | null;
  scopeAccess: ScopeAccess;
  matchedGrant: StoredPermissionGrant | null;
  toolRiskEffect: PolicyEffect;
  decisionId: string;
  createdAt: string;
}

export interface AuthorizationEngineDependencies {
  grantStore: GrantStore;
  resolvePolicy: (
    request: Readonly<AuthorizationRequest>
  ) => AuthorizationPolicy | null;
  resolveScopeAccess: (
    principal: Readonly<PrincipalContext>,
    scope: Readonly<RuntimeScope>
  ) => ScopeAccess;
  evaluateToolRisk?: (
    request: Readonly<AuthorizationRequest>
  ) => PolicyEffect;
  createDecisionId?: () => string;
  now?: () => Date;
}

function hasIntersection(
  actual: readonly string[],
  allowed: readonly string[] | undefined
): boolean {
  return allowed !== undefined && allowed.some((value) => actual.includes(value));
}

function hasPolicyAuthority(
  principal: PrincipalContext,
  policy: AuthorizationPolicy
): boolean {
  const hasConfiguredAuthority =
    (policy.allowedRoles?.length ?? 0) > 0 ||
    (policy.allowedPrincipalScopes?.length ?? 0) > 0;
  if (!hasConfiguredAuthority) return true;

  return (
    hasIntersection(principal.roles, policy.allowedRoles) ||
    hasIntersection(principal.scopes, policy.allowedPrincipalScopes)
  );
}

function isSameResource(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.resourceType === right.resourceType &&
    left.resourceId === right.resourceId &&
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.ownerScopeId === right.ownerScopeId
  );
}

function isGrantCurrentlyValid(
  grant: StoredPermissionGrant,
  evaluatedAt: string
): boolean {
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt === undefined) return true;

  const expiresAtEpochMs = Date.parse(grant.expiresAt);
  const evaluatedAtEpochMs = Date.parse(evaluatedAt);
  return (
    Number.isFinite(expiresAtEpochMs) &&
    Number.isFinite(evaluatedAtEpochMs) &&
    expiresAtEpochMs > evaluatedAtEpochMs
  );
}

function isMatchingGrant(
  grant: StoredPermissionGrant | null,
  request: AuthorizationRequest,
  evaluatedAt: string
): grant is StoredPermissionGrant {
  return (
    grant !== null &&
    isGrantCurrentlyValid(grant, evaluatedAt) &&
    isSameResource(grant.resource, request.resource) &&
    grant.granteeScopeId === request.scope.scopeId &&
    grant.granteeTenantId === request.scope.tenantId &&
    grant.actions.includes(request.action)
  );
}

function boundaryDenialReason(
  request: AuthorizationRequest,
  policy: AuthorizationPolicy | null,
  scopeAccess: ScopeAccess
): AuthorizationReasonCode | null {
  if (
    (request.resource.accountId !== undefined &&
      request.principal.accountId !== request.resource.accountId) ||
    request.principal.tenantId !== request.resource.tenantId ||
    request.scope.tenantId !== request.resource.tenantId
  ) {
    return "CROSS_TENANT_DENIED";
  }

  if (!isActiveScopePresent(request.scope)) {
    return "MISSING_ACTIVE_SCOPE";
  }

  if (policy?.access === "write" && scopeAccess !== "writable") {
    return "SCOPE_NOT_WRITABLE";
  }

  if (policy?.access === "read" && scopeAccess === "none") {
    return "SCOPE_NOT_VISIBLE";
  }

  if (policy === null || !policy.actions.includes(request.action)) {
    return "ACTION_NOT_ALLOWED";
  }

  return null;
}

function createDecision(
  input: AuthorizationEvaluationInput,
  effect: AuthorizationEffect,
  reasonCode: AuthorizationReasonCode,
  options: { matchedPolicy?: string; matchedGrantId?: string } = {}
): AuthorizationDecision {
  return {
    decisionId: input.decisionId,
    effect,
    reasonCode,
    ...(options.matchedPolicy === undefined
      ? {}
      : { matchedPolicy: options.matchedPolicy }),
    ...(options.matchedGrantId === undefined
      ? {}
      : { matchedGrantId: options.matchedGrantId }),
    createdAt: input.createdAt,
  };
}

export function evaluateAuthorization(
  request: AuthorizationRequest,
  input: AuthorizationEvaluationInput
): AuthorizationDecision {
  const boundaryReason = boundaryDenialReason(
    request,
    input.policy,
    input.scopeAccess
  );
  if (boundaryReason !== null) {
    return createDecision(input, "deny", boundaryReason);
  }

  const policy = input.policy;
  if (policy === null) {
    return createDecision(input, "deny", "ACTION_NOT_ALLOWED");
  }

  const matchedGrant = isMatchingGrant(
    input.matchedGrant,
    request,
    input.createdAt
  )
    ? input.matchedGrant
    : null;
  const policyAuthority = hasPolicyAuthority(request.principal, policy);
  if (!policyAuthority && matchedGrant === null) {
    return createDecision(input, "deny", "MISSING_ROLE_SCOPE_GRANT", {
      matchedPolicy: policy.policyId,
    });
  }

  const ownsResource =
    request.resource.ownerScopeId === undefined ||
    request.resource.ownerScopeId === request.scope.scopeId;
  if (!ownsResource && matchedGrant === null) {
    return createDecision(input, "deny", "RESOURCE_OWNERSHIP_MISMATCH", {
      matchedPolicy: policy.policyId,
    });
  }

  const contextEffect = policy.evaluateContext?.(request.context) ?? "allow";
  if (contextEffect === "deny") {
    return createDecision(input, "deny", "CONTEXT_LIMIT_EXCEEDED", {
      matchedPolicy: policy.policyId,
      ...(matchedGrant === null ? {} : { matchedGrantId: matchedGrant.grantId }),
    });
  }
  if (contextEffect === "require_confirmation") {
    return createDecision(input, "require_confirmation", "REQUIRES_CONFIRMATION", {
      matchedPolicy: policy.policyId,
      ...(matchedGrant === null ? {} : { matchedGrantId: matchedGrant.grantId }),
    });
  }

  if (input.toolRiskEffect === "deny") {
    return createDecision(input, "deny", "TOOL_RISK_DENIED", {
      matchedPolicy: policy.policyId,
      ...(matchedGrant === null ? {} : { matchedGrantId: matchedGrant.grantId }),
    });
  }
  if (input.toolRiskEffect === "require_confirmation") {
    return createDecision(input, "require_confirmation", "REQUIRES_CONFIRMATION", {
      matchedPolicy: policy.policyId,
      ...(matchedGrant === null ? {} : { matchedGrantId: matchedGrant.grantId }),
    });
  }

  return createDecision(
    input,
    "allow",
    matchedGrant === null ? "POLICY_ALLOWED" : "EXPLICIT_GRANT_ALLOWED",
    {
      matchedPolicy: policy.policyId,
      ...(matchedGrant === null ? {} : { matchedGrantId: matchedGrant.grantId }),
    }
  );
}

export class AuthorizationEngine {
  constructor(private readonly dependencies: AuthorizationEngineDependencies) {}

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    let decisionId: string = randomUUID();
    let createdAt = new Date().toISOString();

    try {
      decisionId = this.dependencies.createDecisionId?.() ?? decisionId;
      createdAt = (this.dependencies.now?.() ?? new Date()).toISOString();
      const policy = this.dependencies.resolvePolicy(request);
      const scopeAccess = this.dependencies.resolveScopeAccess(
        request.principal,
        request.scope
      );
      const evaluationBase = {
        policy,
        scopeAccess,
        toolRiskEffect: "allow" as const,
        decisionId,
        createdAt,
      };

      const boundaryReason = boundaryDenialReason(request, policy, scopeAccess);
      if (boundaryReason !== null) {
        return createDecision(
          { ...evaluationBase, matchedGrant: null },
          "deny",
          boundaryReason
        );
      }

      const matchedGrant = await this.dependencies.grantStore.findMatching({
        resource: request.resource,
        granteeScopeId: request.scope.scopeId,
        granteeTenantId: request.scope.tenantId,
        action: request.action,
      });

      return evaluateAuthorization(request, {
        ...evaluationBase,
        matchedGrant,
        toolRiskEffect:
          this.dependencies.evaluateToolRisk?.(request) ?? "allow",
      });
    } catch {
      return {
        decisionId,
        effect: "deny",
        reasonCode: "AUTHORIZATION_UNAVAILABLE",
        createdAt,
      };
    }
  }
}
