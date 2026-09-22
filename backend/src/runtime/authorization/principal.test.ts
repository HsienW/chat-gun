import { describe, expect, it } from "vitest";

import {
  AUTH_SOURCES,
  PRINCIPAL_TYPES,
  parseTrustedPrincipal,
} from "./principal.js";

const canonicalHeaders = {
  "x-bff-principal-id": "principal-1",
  "x-bff-principal-type": "merchant_staff",
  "x-bff-tenant-id": "tenant-1",
  "x-bff-roles": "support, operator",
  "x-bff-scopes": "catalog:read, orders:write",
  "x-bff-auth-source": "trusted_gateway",
  "x-bff-authenticated-at": "2026-08-18T01:02:03.000Z",
};

describe("parseTrustedPrincipal", () => {
  it("rejects array-valued trusted principal headers", () => {
    expect(parseTrustedPrincipal({
      ...canonicalHeaders,
      "x-bff-principal-id": ["principal-1", "principal-2"],
    })).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRUSTED_PRINCIPAL_FIELD" },
    });
  });
  it("parses canonical trusted headers into PrincipalContext", () => {
    expect(parseTrustedPrincipal(canonicalHeaders)).toEqual({
      ok: true,
      principal: {
        principalId: "principal-1",
        principalType: "merchant_staff",
        tenantId: "tenant-1",
        roles: ["support", "operator"],
        scopes: ["catalog:read", "orders:write"],
        authSource: "trusted_gateway",
        authenticatedAt: "2026-08-18T01:02:03.000Z",
      },
    });
  });

  it("ignores conflicting raw client identity headers", () => {
    const parsed = parseTrustedPrincipal({
      ...canonicalHeaders,
      "x-user-id": "spoofed-principal",
      "x-tenant-id": "spoofed-tenant",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.principal.principalId).toBe("principal-1");
      expect(parsed.principal.tenantId).toBe("tenant-1");
    }

    expect(
      parseTrustedPrincipal({
        "x-user-id": "spoofed-principal",
        "x-tenant-id": "spoofed-tenant",
      })
    ).toEqual({
      ok: false,
      error: {
        code: "MISSING_TRUSTED_PRINCIPAL_FIELD",
        field: "x-bff-principal-id",
      },
    });
  });

  it("returns a typed error when a required trusted field is missing", () => {
    const { "x-bff-tenant-id": _tenantId, ...missingTenantHeaders } =
      canonicalHeaders;

    expect(parseTrustedPrincipal(missingTenantHeaders)).toEqual({
      ok: false,
      error: {
        code: "MISSING_TRUSTED_PRINCIPAL_FIELD",
        field: "x-bff-tenant-id",
      },
    });
  });

  it("rejects values outside the closed principal and auth-source enums", () => {
    expect(
      parseTrustedPrincipal({
        ...canonicalHeaders,
        "x-bff-principal-type": "administrator",
      })
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_TRUSTED_PRINCIPAL_FIELD",
        field: "x-bff-principal-type",
      },
    });
  });
});

describe("trusted principal domain constants", () => {
  it("keeps principal types and auth sources closed", () => {
    expect(PRINCIPAL_TYPES).toEqual([
      "user",
      "merchant_staff",
      "platform_staff",
      "service",
    ]);
    expect(AUTH_SOURCES).toEqual([
      "trusted_gateway",
      "service_token",
      "development",
    ]);
  });
});
