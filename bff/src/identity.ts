import type { IncomingMessage } from "node:http";

import type { BffConfig } from "./config.js";
import type {
  IdentityErrorCode,
  IdentityProviderPort,
  PrincipalKind,
  ResolvedProductIdentity,
  TypedIdentityError,
} from "./identity-provider.js";

export const PRINCIPAL_TYPES = [
  "user",
  "merchant_staff",
  "platform_staff",
  "service",
] as const;

export const SCOPE_TYPES = [
  "principal",
  "tenant",
  "team",
  "conversation",
] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export type ScopeType = (typeof SCOPE_TYPES)[number];
export type AuthSource = "oidc" | "service_token" | "development";

export interface ActiveScope {
  scopeId: string;
  scopeType: ScopeType;
}

export interface PrincipalContext {
  principalId: string;
  principalType: PrincipalType;
  principalKind: PrincipalKind;
  tenantId: string;
  accountId?: string;
  sessionId?: string;
  deviceId?: string;
  roles: string[];
  scopes: string[];
  authSource: AuthSource;
  authenticatedAt: string;
  delegatedPrincipalId?: string;
  parentPrincipalId?: string;
  delegatedCapabilitySet?: string[];
}

export interface ApiKeyPrincipalProfile {
  principalId: string;
  principalType: PrincipalType;
  tenantId: string;
  roles: string[];
  scopes: string[];
  activeScope: ActiveScope;
  principalKind?: PrincipalKind;
  accountId?: string;
  sessionId?: string;
  deviceId?: string;
}

export type PrincipalResolution =
  | { ok: true; principal: PrincipalContext; activeScope: ActiveScope }
  | { ok: false; status: number; message: string; code?: IdentityErrorCode };

export interface PrincipalResolver {
  resolve(
    req: IncomingMessage,
    config: BffConfig,
  ): PrincipalResolution | Promise<PrincipalResolution>;
}

type Clock = () => Date;

const SAFE_IDENTITY_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  IDENTITY_IDP_TIMEOUT: "Identity provider timed out",
  IDENTITY_KEY_REFRESH_FAILED: "Identity verification is temporarily unavailable",
  IDENTITY_MALFORMED_CLAIMS: "Identity credential is invalid",
  IDENTITY_CLOCK_SKEW: "Identity credential time validation failed",
  IDENTITY_REVOKED_CREDENTIAL: "Identity credential is invalid or revoked",
  IDENTITY_ACCOUNT_STORE_UNAVAILABLE: "Identity service is temporarily unavailable",
  IDENTITY_SESSION_EXPIRED: "Identity session has expired",
  IDENTITY_ACCOUNT_SUSPENDED: "Account is suspended",
  IDENTITY_DELETION_PENDING: "Account deletion is pending",
};

function principalTypeForKind(kind: PrincipalKind): PrincipalType {
  if (kind === "service" || kind === "delegated") return "service";
  if (kind === "operator") return "platform_staff";
  return "user";
}

function principalKindForType(type: PrincipalType): PrincipalKind {
  if (type === "service") return "service";
  if (type === "platform_staff") return "operator";
  return "authenticated";
}

export function buildPrincipalContext(identity: ResolvedProductIdentity): {
  principal: PrincipalContext;
  activeScope: ActiveScope;
} {
  return {
    principal: {
      principalId: identity.principalId,
      principalType: principalTypeForKind(identity.principalKind),
      principalKind: identity.principalKind,
      tenantId: identity.tenantId,
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      deviceId: identity.deviceId,
      roles: [...identity.roles],
      scopes: [...identity.scopes],
      authSource: identity.authSource,
      authenticatedAt: identity.authenticatedAt,
      ...(identity.delegatedPrincipalId ? { delegatedPrincipalId: identity.delegatedPrincipalId } : {}),
      ...(identity.parentPrincipalId ? { parentPrincipalId: identity.parentPrincipalId } : {}),
      ...(identity.delegatedCapabilitySet
        ? { delegatedCapabilitySet: [...identity.delegatedCapabilitySet] }
        : {}),
    },
    activeScope: { scopeId: identity.tenantId, scopeType: "tenant" },
  };
}

export function mapIdentityFailureToPrincipalResolution(
  error: TypedIdentityError,
): Extract<PrincipalResolution, { ok: false }> {
  return {
    ok: false,
    status: error.httpStatus,
    code: error.code,
    message: SAFE_IDENTITY_MESSAGES[error.code],
  };
}

export class IdentityProviderPrincipalResolver implements PrincipalResolver {
  constructor(private readonly provider: IdentityProviderPort) {}

  async resolve(req: IncomingMessage, _config: BffConfig): Promise<PrincipalResolution> {
    const credential =
      bearerToken(singleHeader(req, "authorization")) ??
      singleHeader(req, "x-api-key");
    if (!credential) {
      return { ok: false, status: 401, message: "Unauthorized" };
    }
    try {
      const resolution = await this.provider.resolveIdentity({ credential });
      if (!resolution.ok) {
        return mapIdentityFailureToPrincipalResolution(resolution.error);
      }
      if (resolution.identity.accountStatus === "suspended") {
        return mapIdentityFailureToPrincipalResolution({
          code: "IDENTITY_ACCOUNT_SUSPENDED",
          message: "Account is suspended",
          retryable: false,
          httpStatus: 403,
        });
      }
      if (
        resolution.identity.accountStatus === "deletion_pending" ||
        resolution.identity.accountStatus === "deleted"
      ) {
        return mapIdentityFailureToPrincipalResolution({
          code: "IDENTITY_DELETION_PENDING",
          message: "Account deletion is pending",
          retryable: false,
          httpStatus: 403,
        });
      }
      if (resolution.identity.sessionStatus === "expired") {
        return mapIdentityFailureToPrincipalResolution({
          code: "IDENTITY_SESSION_EXPIRED",
          message: "Identity session has expired",
          retryable: false,
          httpStatus: 401,
        });
      }
      if (
        resolution.identity.sessionStatus === "revoked" ||
        resolution.identity.sessionStatus === "compromised"
      ) {
        return mapIdentityFailureToPrincipalResolution({
          code: "IDENTITY_REVOKED_CREDENTIAL",
          message: "Identity credential is invalid or revoked",
          retryable: false,
          httpStatus: 401,
        });
      }
      return { ok: true, ...buildPrincipalContext(resolution.identity) };
    } catch {
      return mapIdentityFailureToPrincipalResolution({
        code: "IDENTITY_ACCOUNT_STORE_UNAVAILABLE",
        message: "Identity service is temporarily unavailable",
        retryable: true,
        httpStatus: 503,
      });
    }
  }
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const parts = authorization.split(/\s+/);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer"
    ? parts[1]
    : undefined;
}

export class ApiKeyPrincipalResolver implements PrincipalResolver {
  constructor(private readonly now: Clock = () => new Date()) {}

  resolve(req: IncomingMessage, config: BffConfig): PrincipalResolution {
    const token =
      singleHeader(req, "x-api-key") ??
      bearerToken(singleHeader(req, "authorization"));
    if (token === undefined || !config.apiKeys.has(token)) {
      return { ok: false, status: 401, message: "Unauthorized" };
    }

    const profile = config.apiKeyPrincipals.get(token);
    if (profile === undefined) {
      return { ok: false, status: 401, message: "Unauthorized" };
    }
    const authenticatedAt = this.now();
    if (Number.isNaN(authenticatedAt.getTime())) {
      return { ok: false, status: 500, message: "Identity unavailable" };
    }

    return {
      ok: true,
      principal: {
        principalId: profile.principalId,
        principalType: profile.principalType,
        principalKind: profile.principalKind ?? principalKindForType(profile.principalType),
        tenantId: profile.tenantId,
        ...(profile.accountId ? { accountId: profile.accountId } : {}),
        ...(profile.sessionId ? { sessionId: profile.sessionId } : {}),
        ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
        roles: [...profile.roles],
        scopes: [...profile.scopes],
        authSource: "service_token",
        authenticatedAt: authenticatedAt.toISOString(),
      },
      activeScope: { ...profile.activeScope },
    };
  }
}

export class DevelopmentPrincipalResolver implements PrincipalResolver {
  constructor(private readonly now: Clock = () => new Date()) {}

  resolve(_req: IncomingMessage, _config: BffConfig): PrincipalResolution {
    const authenticatedAt = this.now();
    if (Number.isNaN(authenticatedAt.getTime())) {
      return { ok: false, status: 500, message: "Identity unavailable" };
    }
    return {
      ok: true,
      principal: {
        principalId: "anonymous",
        principalType: "user",
        principalKind: "anonymous",
        tenantId: "public",
        roles: [],
        scopes: [],
        authSource: "development",
        authenticatedAt: authenticatedAt.toISOString(),
      },
      activeScope: { scopeId: "public", scopeType: "tenant" },
    };
  }
}

export function selectPrincipalResolver(config: BffConfig): PrincipalResolver {
  return config.requireAuth
    ? new ApiKeyPrincipalResolver()
    : new DevelopmentPrincipalResolver();
}
