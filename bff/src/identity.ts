import type { IncomingMessage } from "node:http";

import type { BffConfig } from "./config.js";

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
export type AuthSource = "service_token" | "development";

export interface ActiveScope {
  scopeId: string;
  scopeType: ScopeType;
}

export interface PrincipalContext {
  principalId: string;
  principalType: PrincipalType;
  tenantId: string;
  roles: string[];
  scopes: string[];
  authSource: AuthSource;
  authenticatedAt: string;
}

export interface ApiKeyPrincipalProfile {
  principalId: string;
  principalType: PrincipalType;
  tenantId: string;
  roles: string[];
  scopes: string[];
  activeScope: ActiveScope;
}

export type PrincipalResolution =
  | { ok: true; principal: PrincipalContext; activeScope: ActiveScope }
  | { ok: false; status: number; message: string };

export interface PrincipalResolver {
  resolve(req: IncomingMessage, config: BffConfig): PrincipalResolution;
}

type Clock = () => Date;

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
        tenantId: profile.tenantId,
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
