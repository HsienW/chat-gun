import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationEngine,
  type AuthorizationPolicy,
  type AuthorizationRequest,
  type ScopeAccess,
} from "./authorization.js";
import type {
  GrantStore,
  StoredPermissionGrant,
} from "./grant-store.js";
import type { PermissionGrant } from "./grants.js";

const baseRequest: AuthorizationRequest = {
  principal: {
    principalId: "principal-1",
    principalType: "user",
    accountId: "account-1",
    tenantId: "tenant-1",
    roles: ["editor"],
    scopes: ["task:write"],
    authSource: "trusted_gateway",
    authenticatedAt: "2026-08-18T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "team",
    tenantId: "tenant-1",
  },
  action: "task:update",
  resource: {
    resourceType: "task",
    resourceId: "task-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    ownerScopeId: "scope-1",
  },
};

const writePolicy: AuthorizationPolicy = {
  policyId: "task-write-policy-v1",
  actions: ["task:update"],
  access: "write",
  allowedRoles: ["editor"],
  allowedPrincipalScopes: ["task:write"],
};

function createGrant(
  resource = baseRequest.resource
): StoredPermissionGrant {
  return {
    grantId: "grant-1",
    resource,
    granteeScopeId: baseRequest.scope.scopeId,
    granteeTenantId: baseRequest.scope.tenantId,
    actions: [baseRequest.action],
    grantedByPrincipalId: "principal-owner",
    grantedByScopeId: "scope-owner",
    canDelegate: false,
    createdAt: "2026-08-18T00:00:00.000Z",
  };
}

function createGrantStore(
  findMatching: GrantStore["findMatching"] = async () => null
): GrantStore {
  return {
    create: async (grant: PermissionGrant) => grant,
    revoke: async () => null,
    findMatching,
  };
}

function createEngine(options: {
  grantStore?: GrantStore;
  policy?: AuthorizationPolicy | null;
  scopeAccess?: ScopeAccess;
} = {}): AuthorizationEngine {
  return new AuthorizationEngine({
    grantStore: options.grantStore ?? createGrantStore(),
    resolvePolicy: () => options.policy ?? writePolicy,
    resolveScopeAccess: () => options.scopeAccess ?? "writable",
    createDecisionId: () => "decision-1",
    now: () => new Date("2026-08-18T01:00:00.000Z"),
  });
}

describe("AuthorizationEngine", () => {
  it("denies a cross-tenant principal before grant lookup", async () => {
    const findMatching = vi.fn<GrantStore["findMatching"]>(async () => null);
    const engine = createEngine({ grantStore: createGrantStore(findMatching) });

    await expect(
      engine.authorize({
        ...baseRequest,
        principal: { ...baseRequest.principal, tenantId: "tenant-2" },
      })
    ).resolves.toMatchObject({
      effect: "deny",
      reasonCode: "CROSS_TENANT_DENIED",
    });
    expect(findMatching).not.toHaveBeenCalled();
  });

  it("denies a cross-account principal before grant lookup", async () => {
    const findMatching = vi.fn<GrantStore["findMatching"]>(async () => null);
    const engine = createEngine({ grantStore: createGrantStore(findMatching) });
    await expect(engine.authorize({
      ...baseRequest,
      resource: { ...baseRequest.resource, accountId: "account-2" },
    })).resolves.toMatchObject({
      effect: "deny",
      reasonCode: "CROSS_TENANT_DENIED",
    });
    expect(findMatching).not.toHaveBeenCalled();
  });

  it("denies a write action when the active scope is only visible", async () => {
    const engine = createEngine({ scopeAccess: "visible" });

    await expect(engine.authorize(baseRequest)).resolves.toMatchObject({
      effect: "deny",
      reasonCode: "SCOPE_NOT_WRITABLE",
    });
  });

  it("denies when role, principal scope, and explicit grant are all missing", async () => {
    const engine = createEngine();

    await expect(
      engine.authorize({
        ...baseRequest,
        principal: { ...baseRequest.principal, roles: [], scopes: [] },
      })
    ).resolves.toMatchObject({
      effect: "deny",
      reasonCode: "MISSING_ROLE_SCOPE_GRANT",
    });
  });

  it("allows a matching explicit grant and records its identifier", async () => {
    const delegatedResource = {
      ...baseRequest.resource,
      ownerScopeId: "scope-owner",
    };
    const findMatching = vi.fn<GrantStore["findMatching"]>(async () =>
      createGrant(delegatedResource)
    );
    const engine = createEngine({ grantStore: createGrantStore(findMatching) });

    await expect(
      engine.authorize({
        ...baseRequest,
        principal: { ...baseRequest.principal, roles: [], scopes: [] },
        resource: delegatedResource,
      })
    ).resolves.toMatchObject({
      effect: "allow",
      reasonCode: "EXPLICIT_GRANT_ALLOWED",
      matchedGrantId: "grant-1",
    });
    expect(findMatching).toHaveBeenCalledWith({
      resource: delegatedResource,
      granteeScopeId: "scope-1",
      granteeTenantId: "tenant-1",
      action: "task:update",
    });
  });

  it("requires confirmation when a contextual limit is exceeded", async () => {
    const policy: AuthorizationPolicy = {
      ...writePolicy,
      evaluateContext: (context) =>
        context?.amount === 1500 ? "require_confirmation" : "allow",
    };
    const engine = createEngine({ policy });

    await expect(
      engine.authorize({ ...baseRequest, context: { amount: 1500 } })
    ).resolves.toMatchObject({
      effect: "require_confirmation",
      reasonCode: "REQUIRES_CONFIRMATION",
      matchedPolicy: "task-write-policy-v1",
    });
  });

  it("fails closed when explicit grant lookup is unavailable", async () => {
    const engine = createEngine({
      grantStore: createGrantStore(async () => {
        throw new Error("database unavailable");
      }),
    });

    await expect(engine.authorize(baseRequest)).resolves.toMatchObject({
      effect: "deny",
      reasonCode: "AUTHORIZATION_UNAVAILABLE",
    });
  });
});
