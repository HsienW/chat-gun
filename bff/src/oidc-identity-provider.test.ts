import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ResolvedProductIdentity } from "./identity-provider.js";
import { OidcIdentityProviderAdapter } from "./oidc-identity-provider.js";

const issuer = "https://identity.example.test";
const audience = "chat-gun";
const now = new Date("2026-09-30T00:00:00.000Z");
let privateKey: CryptoKey;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  keyResolver = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "RS256", kid: "key-1", use: "sig" }],
  });
});

async function signToken(
  claims: Record<string, unknown> = {},
): Promise<string> {
  const token = new SignJWT({
    sid: "session_01",
    device_id: "device_01",
    credential_id: "credential_01",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setSubject("provider-subject")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setNotBefore(Math.floor(now.getTime() / 1_000) - 5);
  if (claims.exp === undefined) {
    token.setExpirationTime(Math.floor(now.getTime() / 1_000) + 300);
  }
  return token.sign(privateKey);
}

function productIdentity(): ResolvedProductIdentity {
  return {
    accountId: "account_01",
    userId: "user_01",
    tenantId: "tenant_01",
    sessionId: "session_01",
    deviceId: "device_01",
    credentialId: "credential_01",
    principalId: "principal_01",
    principalKind: "authenticated",
    roles: ["member"],
    scopes: ["runs:write"],
    authSource: "oidc",
    authenticatedAt: now.toISOString(),
    accountStatus: "active",
    sessionStatus: "active",
  };
}

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof OidcIdentityProviderAdapter>[1]> = {},
  configOverrides: Partial<ConstructorParameters<typeof OidcIdentityProviderAdapter>[0]> = {},
) {
  return new OidcIdentityProviderAdapter(
    {
      issuer,
      audience,
      jwksUri: new URL(`${issuer}/.well-known/jwks.json`),
      clockToleranceSeconds: 30,
      requestTimeoutMs: 1_000,
      ...configOverrides,
    },
    {
      keyResolver,
      now: () => now,
      mapClaims: async () => productIdentity(),
      isCredentialRevoked: async () => false,
      ...overrides,
    },
  );
}

describe("OidcIdentityProviderAdapter", () => {
  it("verifies JWT claims and returns only mapped product identity", async () => {
    const adapter = createAdapter();
    const resolution = await adapter.resolveIdentity({
      credential: await signToken({ email: "private@example.test" }),
    });

    expect(resolution).toEqual({ ok: true, identity: productIdentity() });
    expect(JSON.stringify(resolution)).not.toContain("provider-subject");
    expect(JSON.stringify(resolution)).not.toContain("private@example.test");
  });

  it("returns typed failures for malformed, expired, and revoked credentials", async () => {
    const adapter = createAdapter();
    await expect(adapter.resolveIdentity({ credential: "not-a-jwt" })).resolves.toMatchObject({
      ok: false,
      error: { code: "IDENTITY_MALFORMED_CLAIMS", retryable: false },
    });

    const expired = await signToken({ exp: Math.floor(now.getTime() / 1_000) - 120 });
    await expect(adapter.resolveIdentity({ credential: expired })).resolves.toMatchObject({
      ok: false,
      error: { code: "IDENTITY_CLOCK_SKEW", retryable: false },
    });

    const revokedAdapter = createAdapter({ isCredentialRevoked: async () => true });
    await expect(
      revokedAdapter.resolveIdentity({ credential: await signToken() }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDENTITY_REVOKED_CREDENTIAL", retryable: false },
    });
  });

  it("returns a typed timeout without leaking provider details", async () => {
    const adapter = createAdapter({
      mapClaims: async () => {
        const error = new DOMException("provider token leaked", "TimeoutError");
        throw error;
      },
    });

    const resolution = await adapter.resolveIdentity({ credential: await signToken() });
    expect(resolution).toMatchObject({
      ok: false,
      error: { code: "IDENTITY_IDP_TIMEOUT", message: "Identity provider timed out" },
    });
    expect(JSON.stringify(resolution)).not.toContain("provider token leaked");
  });

  it("bounds the complete identity resolution, not only JWKS fetch", async () => {
    const adapter = createAdapter({
      mapClaims: async () => new Promise<never>(() => undefined),
    }, { requestTimeoutMs: 5 });
    await expect(adapter.resolveIdentity({ credential: await signToken() })).resolves.toMatchObject({
      ok: false,
      error: { code: "IDENTITY_IDP_TIMEOUT" },
    });
  });

  it("deduplicates concurrent verification-key refresh", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    const adapter = createAdapter({ refreshVerificationKeys: refresh });

    const first = adapter.refreshVerificationKeys();
    const second = adapter.refreshVerificationKeys();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseRefresh?.();
    await Promise.all([first, second]);
  });
});
