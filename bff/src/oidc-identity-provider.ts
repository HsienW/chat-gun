import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
} from "jose";

import {
  identityFailure,
  parseResolvedProductIdentity,
  type IdentityProviderPort,
  type IdentityResolution,
  type IdentityResolveInput,
  type ResolvedProductIdentity,
} from "./identity-provider.js";

export type OidcIdentityProviderConfig = {
  issuer: string;
  audience: string;
  jwksUri: URL;
  clockToleranceSeconds: number;
  requestTimeoutMs: number;
};

export type OidcIdentityProviderDependencies = {
  keyResolver?: JWTVerifyGetKey;
  now?: () => Date;
  mapClaims: (claims: Readonly<JWTPayload>) => Promise<unknown>;
  isCredentialRevoked: (credentialId: string) => Promise<boolean>;
  refreshVerificationKeys?: () => Promise<void>;
};

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

function credentialIdFromClaims(payload: JWTPayload): string | undefined {
  const credentialId = payload.credential_id;
  return typeof credentialId === "string" && credentialId.length > 0
    ? credentialId
    : undefined;
}

function safeFailure(error: unknown): IdentityResolution {
  if (isTimeoutError(error)) {
    return identityFailure("IDENTITY_IDP_TIMEOUT", "Identity provider timed out", {
      retryable: true,
      httpStatus: 503,
    });
  }
  if (
    error instanceof errors.JWTExpired ||
    (error instanceof errors.JWTClaimValidationFailed &&
      (error.claim === "nbf" || error.claim === "exp" || error.claim === "iat"))
  ) {
    return identityFailure("IDENTITY_CLOCK_SKEW", "Identity credential is outside its valid time window");
  }
  return identityFailure("IDENTITY_MALFORMED_CLAIMS", "Identity credential is invalid");
}

function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timeoutError = () => new DOMException("Identity provider timed out", "TimeoutError");
    const onAbort = () => finish(() => reject(timeoutError()));
    const timer = setTimeout(onAbort, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

export class OidcIdentityProviderAdapter implements IdentityProviderPort {
  readonly providerId = "oidc";
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly remoteJwks?: RemoteJWKSet;
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly config: OidcIdentityProviderConfig,
    private readonly dependencies: OidcIdentityProviderDependencies,
  ) {
    if (config.jwksUri.protocol !== "https:") {
      throw new Error("OIDC_JWKS_URI_MUST_USE_HTTPS");
    }
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
      throw new Error("OIDC_REQUEST_TIMEOUT_MUST_BE_POSITIVE");
    }
    if (dependencies.keyResolver) {
      this.keyResolver = dependencies.keyResolver;
    } else {
      this.remoteJwks = createRemoteJWKSet(config.jwksUri, {
        timeoutDuration: config.requestTimeoutMs,
      });
      this.keyResolver = this.remoteJwks;
    }
  }

  async resolveIdentity(input: IdentityResolveInput): Promise<IdentityResolution> {
    if (input.signal?.aborted) {
      return identityFailure("IDENTITY_IDP_TIMEOUT", "Identity provider timed out", {
        retryable: true,
        httpStatus: 503,
      });
    }

    try {
      return await withTimeout(async () => {
        const verified = await jwtVerify(input.credential, this.keyResolver, {
          issuer: this.config.issuer,
          audience: this.config.audience,
          clockTolerance: this.config.clockToleranceSeconds,
          currentDate: this.dependencies.now?.() ?? new Date(),
        });
        const credentialId = credentialIdFromClaims(verified.payload);
        if (credentialId === undefined) {
          return identityFailure("IDENTITY_MALFORMED_CLAIMS", "Identity credential is invalid");
        }
        if (await this.dependencies.isCredentialRevoked(credentialId)) {
          return identityFailure("IDENTITY_REVOKED_CREDENTIAL", "Identity credential has been revoked");
        }
        const mapped = await this.dependencies.mapClaims(verified.payload);
        const identity = parseResolvedProductIdentity(mapped);
        if (identity === undefined) {
          return identityFailure("IDENTITY_MALFORMED_CLAIMS", "Identity claims could not be mapped");
        }
        return { ok: true, identity: identity as ResolvedProductIdentity };
      }, this.config.requestTimeoutMs, input.signal);
    } catch (error) {
      return safeFailure(error);
    }
  }

  refreshVerificationKeys(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.dependencies.refreshVerificationKeys ??
      (this.remoteJwks ? () => this.remoteJwks?.reload() : async () => undefined);
    this.refreshPromise = Promise.resolve()
      .then(refresh)
      .catch((error: unknown) => {
        throw new Error("IDENTITY_KEY_REFRESH_FAILED", { cause: error });
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }
}
