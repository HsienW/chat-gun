import { describe, expect, it, vi } from "vitest";

import { authorizeIdentityResourceAccess } from "./resource-identity-authorization.js";
import type { PrincipalContext } from "./identity.js";

const principal: PrincipalContext = {
  principalId: "principal_01",
  principalType: "user",
  principalKind: "authenticated",
  accountId: "account_01",
  sessionId: "session_01",
  deviceId: "device_01",
  tenantId: "tenant_01",
  roles: [],
  scopes: [],
  authSource: "oidc",
  authenticatedAt: "2026-09-30T00:00:00.000Z",
};

describe("BFF identity resource authorization", () => {
  it.each([
    ["cross-account", { accountId: "account_02", tenantId: "tenant_01" }],
    ["cross-tenant", { accountId: "account_01", tenantId: "tenant_02" }],
  ])("denies %s before downstream and emits opaque audit", async (_name, resource) => {
    const downstream = vi.fn(async () => "sensitive-data");
    const audit = vi.fn();
    const result = await authorizeIdentityResourceAccess({
      principal,
      resource,
      downstream,
      audit,
    });
    expect(result).toEqual({ allowed: false, reasonCode: "CROSS_TENANT_DENIED" });
    expect(downstream).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
      reasonCode: "CROSS_TENANT_DENIED",
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("credential");
  });
});
