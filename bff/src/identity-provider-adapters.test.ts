import { describe, expect, it } from "vitest";

import {
  DevelopmentIdentityProviderAdapter,
  ServiceTokenIdentityProviderAdapter,
} from "./identity-provider-adapters.js";

const authenticatedAt = new Date("2026-09-30T00:00:00.000Z");

describe("identity provider compatibility adapters", () => {
  it("maps a configured service token to server-owned product identity", async () => {
    const adapter = new ServiceTokenIdentityProviderAdapter(
      new Map([
        [
          "secret-token",
          {
            accountId: "account_01",
            userId: "user_01",
            tenantId: "tenant_01",
            sessionId: "session_01",
            deviceId: "device_01",
            credentialId: "credential_01",
            principalId: "principal_01",
            principalKind: "service" as const,
            roles: ["operator"],
            scopes: ["runs:write"],
            authSource: "service_token" as const,
            authenticatedAt: authenticatedAt.toISOString(),
            accountStatus: "active" as const,
            sessionStatus: "active" as const,
          },
        ],
      ]),
    );

    await expect(
      adapter.resolveIdentity({ credential: "secret-token" }),
    ).resolves.toMatchObject({
      ok: true,
      identity: {
        accountId: "account_01",
        principalId: "principal_01",
        principalKind: "service",
      },
    });
    await expect(
      adapter.resolveIdentity({ credential: "forged-token" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDENTITY_REVOKED_CREDENTIAL" },
    });
  });

  it("keeps development identity isolated and deterministic", async () => {
    const adapter = new DevelopmentIdentityProviderAdapter(() => authenticatedAt);

    await expect(adapter.resolveIdentity({ credential: "ignored" })).resolves.toEqual({
      ok: true,
      identity: {
        accountId: "anonymous",
        userId: "anonymous",
        tenantId: "public",
        sessionId: "development",
        deviceId: "development",
        credentialId: "development",
        principalId: "anonymous",
        principalKind: "anonymous",
        roles: [],
        scopes: [],
        authSource: "development",
        authenticatedAt: authenticatedAt.toISOString(),
        accountStatus: "active",
        sessionStatus: "active",
      },
    });
  });
});
