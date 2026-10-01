import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";
import {
  ApiKeyPrincipalResolver,
  DevelopmentPrincipalResolver,
  IdentityProviderPrincipalResolver,
  SCOPE_TYPES,
  buildPrincipalContext,
  mapIdentityFailureToPrincipalResolution,
  selectPrincipalResolver,
  type ApiKeyPrincipalProfile,
} from "./identity.js";
import type { IdentityProviderPort } from "./identity-provider.js";

const sharedScopeTypes = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/execution-context.fixture.json", import.meta.url),
      "utf8"
    )
  ) as { trustedAuthorization: { scopeTypes: string[] } }
).trustedAuthorization.scopeTypes;

const authenticatedAt = new Date("2026-08-18T00:00:00.000Z");

function request(headers: IncomingHttpHeaders = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function profile(
  overrides: Partial<ApiKeyPrincipalProfile> = {}
): ApiKeyPrincipalProfile {
  return {
    principalId: "service-orders",
    principalType: "service",
    tenantId: "tenant-1",
    roles: ["order-reader"],
    scopes: ["orders:read"],
    activeScope: { scopeId: "tenant-1", scopeType: "tenant" },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PrincipalResolver", () => {
  it("keeps BFF scope types aligned with the shared cross-layer fixture", () => {
    expect([...SCOPE_TYPES]).toEqual(sharedScopeTypes);
  });

  it("selects the development resolver when authentication is not required", () => {
    const config = { ...loadConfig(), requireAuth: false };

    expect(selectPrincipalResolver(config)).toBeInstanceOf(
      DevelopmentPrincipalResolver
    );
  });

  it("selects the API key resolver when authentication is required", () => {
    const config = { ...loadConfig(), requireAuth: true };

    expect(selectPrincipalResolver(config)).toBeInstanceOf(
      ApiKeyPrincipalResolver
    );
  });

  it("resolves a configured API key to its server-side principal profile", () => {
    const config = {
      ...loadConfig(),
      requireAuth: true,
      apiKeys: new Set(["secret-key"]),
      apiKeyPrincipals: new Map([["secret-key", profile()]]),
    };
    const resolver = new ApiKeyPrincipalResolver(() => authenticatedAt);

    expect(
      resolver.resolve(request({ "x-api-key": "secret-key" }), config)
    ).toEqual({
      ok: true,
      principal: {
        principalId: "service-orders",
        principalType: "service",
        principalKind: "service",
        tenantId: "tenant-1",
        roles: ["order-reader"],
        scopes: ["orders:read"],
        authSource: "service_token",
        authenticatedAt: "2026-08-18T00:00:00.000Z",
      },
      activeScope: { scopeId: "tenant-1", scopeType: "tenant" },
    });
  });

  it("rejects a valid legacy key that has no principal mapping", () => {
    const config = {
      ...loadConfig(),
      requireAuth: true,
      apiKeys: new Set(["legacy-key"]),
      apiKeyPrincipals: new Map<string, ApiKeyPrincipalProfile>(),
    };
    const resolver = new ApiKeyPrincipalResolver(() => authenticatedAt);

    expect(
      resolver.resolve(request({ "x-api-key": "legacy-key" }), config)
    ).toEqual({ ok: false, status: 401, message: "Unauthorized" });
  });

  it("ignores forged client identity headers", () => {
    const config = {
      ...loadConfig(),
      requireAuth: true,
      apiKeys: new Set(["secret-key"]),
      apiKeyPrincipals: new Map([["secret-key", profile()]]),
    };
    const resolver = new ApiKeyPrincipalResolver(() => authenticatedAt);

    const resolution = resolver.resolve(
      request({
        "x-api-key": "secret-key",
        "x-user-id": "attacker",
        "x-tenant-id": "tenant-attacker",
      }),
      config
    );

    expect(resolution).toMatchObject({
      ok: true,
      principal: {
        principalId: "service-orders",
        tenantId: "tenant-1",
      },
    });
  });

  it("uses an isolated anonymous public principal in development", () => {
    const resolver = new DevelopmentPrincipalResolver(() => authenticatedAt);

    expect(resolver.resolve(request(), loadConfig())).toEqual({
      ok: true,
      principal: {
        principalId: "anonymous",
        principalType: "user",
        principalKind: "anonymous",
        tenantId: "public",
        roles: [],
        scopes: [],
        authSource: "development",
        authenticatedAt: "2026-08-18T00:00:00.000Z",
      },
      activeScope: { scopeId: "public", scopeType: "tenant" },
    });
  });

  it("returns the authentication source active scope without guessing from permission scopes", () => {
    const config = {
      ...loadConfig(),
      requireAuth: true,
      apiKeys: new Set(["secret-key"]),
      apiKeyPrincipals: new Map([
        [
          "secret-key",
          profile({
            scopes: ["team:read", "conversation:write"],
            activeScope: { scopeId: "team-7", scopeType: "team" },
          }),
        ],
      ]),
    };
    const resolver = new ApiKeyPrincipalResolver(() => authenticatedAt);

    expect(
      resolver.resolve(request({ "x-api-key": "secret-key" }), config)
    ).toMatchObject({
      ok: true,
      principal: { scopes: ["team:read", "conversation:write"] },
      activeScope: { scopeId: "team-7", scopeType: "team" },
    });
  });

  it("builds authority only from a verified product identity", () => {
    expect(buildPrincipalContext({
      accountId: "account_01",
      userId: "user_01",
      tenantId: "tenant_01",
      sessionId: "session_01",
      deviceId: "device_01",
      credentialId: "credential_01",
      principalId: "principal_01",
      principalKind: "authenticated",
      roles: ["member"],
      scopes: ["chat:write"],
      authSource: "oidc",
      authenticatedAt: authenticatedAt.toISOString(),
      accountStatus: "active",
      sessionStatus: "active",
    })).toMatchObject({
      principal: {
        accountId: "account_01",
        tenantId: "tenant_01",
        roles: ["member"],
        principalKind: "authenticated",
      },
    });
  });

  it("maps typed identity failures to stable non-leaking responses", () => {
    const result = mapIdentityFailureToPrincipalResolution({
      code: "IDENTITY_IDP_TIMEOUT",
      message: "provider said token=secret claim=email@example.test",
      retryable: true,
      httpStatus: 504,
    });
    expect(result).toEqual({
      ok: false,
      status: 504,
      code: "IDENTITY_IDP_TIMEOUT",
      message: "Identity provider timed out",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("adapts an async identity provider into a trusted principal", async () => {
    const provider: IdentityProviderPort = {
      providerId: "test",
      resolveIdentity: async () => ({
        ok: true,
        identity: {
          accountId: "account_01",
          userId: "user_01",
          tenantId: "tenant_01",
          sessionId: "session_01",
          deviceId: "device_01",
          credentialId: "credential_01",
          principalId: "principal_01",
          principalKind: "authenticated",
          roles: ["member"],
          scopes: ["chat:write"],
          authSource: "oidc",
          authenticatedAt: authenticatedAt.toISOString(),
          accountStatus: "active",
          sessionStatus: "active",
        },
      }),
    };
    const resolver = new IdentityProviderPrincipalResolver(provider);
    await expect(resolver.resolve(request({ authorization: "Bearer verified-token" }), loadConfig()))
      .resolves.toMatchObject({
        ok: true,
        principal: { accountId: "account_01", principalKind: "authenticated" },
      });
  });

  it("fails closed on provider account status without leaking credential", async () => {
    const provider: IdentityProviderPort = {
      providerId: "test",
      resolveIdentity: async () => ({
        ok: false,
        error: {
          code: "IDENTITY_ACCOUNT_SUSPENDED",
          message: "token=verified-token claim=email@example.test",
          retryable: false,
          httpStatus: 403,
        },
      }),
    };
    const result = await new IdentityProviderPrincipalResolver(provider)
      .resolve(request({ authorization: "Bearer verified-token" }), loadConfig());
    expect(result).toEqual({
      ok: false,
      code: "IDENTITY_ACCOUNT_SUSPENDED",
      status: 403,
      message: "Account is suspended",
    });
    expect(JSON.stringify(result)).not.toContain("verified-token");
  });
});
