import {
  identityFailure,
  parseResolvedProductIdentity,
  type IdentityProviderPort,
  type IdentityResolution,
  type IdentityResolveInput,
  type ResolvedProductIdentity,
} from "./identity-provider.js";

export class ServiceTokenIdentityProviderAdapter implements IdentityProviderPort {
  readonly providerId = "service-token";

  constructor(
    private readonly profiles: ReadonlyMap<string, ResolvedProductIdentity>,
  ) {}

  async resolveIdentity(input: IdentityResolveInput): Promise<IdentityResolution> {
    const profile = this.profiles.get(input.credential);
    if (profile === undefined) {
      return identityFailure(
        "IDENTITY_REVOKED_CREDENTIAL",
        "Identity credential is invalid or revoked",
      );
    }
    const identity = parseResolvedProductIdentity(profile);
    return identity === undefined
      ? identityFailure(
          "IDENTITY_MALFORMED_CLAIMS",
          "Configured identity profile is invalid",
          { httpStatus: 500 },
        )
      : { ok: true, identity };
  }
}

export class DevelopmentIdentityProviderAdapter implements IdentityProviderPort {
  readonly providerId = "development";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async resolveIdentity(_input: IdentityResolveInput): Promise<IdentityResolution> {
    const authenticatedAt = this.now();
    if (Number.isNaN(authenticatedAt.getTime())) {
      return identityFailure(
        "IDENTITY_ACCOUNT_STORE_UNAVAILABLE",
        "Development identity is unavailable",
        { retryable: true, httpStatus: 503 },
      );
    }
    const identity = parseResolvedProductIdentity({
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
    });
    return identity === undefined
      ? identityFailure(
          "IDENTITY_MALFORMED_CLAIMS",
          "Development identity is invalid",
          { httpStatus: 500 },
        )
      : { ok: true, identity };
  }
}
