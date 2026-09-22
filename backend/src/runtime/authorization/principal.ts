export const PRINCIPAL_TYPES = [
  "user",
  "merchant_staff",
  "platform_staff",
  "service",
] as const;

export const AUTH_SOURCES = [
  "trusted_gateway",
  "service_token",
  "development",
] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export type AuthSource = (typeof AUTH_SOURCES)[number];

export interface PrincipalContext {
  principalId: string;
  principalType: PrincipalType;
  tenantId: string;
  roles: string[];
  scopes: string[];
  authSource: AuthSource;
  authenticatedAt: string;
}

const TRUSTED_PRINCIPAL_HEADERS = {
  principalId: "x-bff-principal-id",
  principalType: "x-bff-principal-type",
  tenantId: "x-bff-tenant-id",
  roles: "x-bff-roles",
  scopes: "x-bff-scopes",
  authSource: "x-bff-auth-source",
  authenticatedAt: "x-bff-authenticated-at",
} as const;

type TrustedPrincipalHeaderName =
  (typeof TRUSTED_PRINCIPAL_HEADERS)[keyof typeof TRUSTED_PRINCIPAL_HEADERS];
type HeaderValue = string | readonly string[] | undefined;

export type TrustedPrincipalHeaders =
  | Readonly<Record<string, HeaderValue>>
  | { get(name: string): string | null | undefined };

export type TrustedPrincipalParseResult =
  | { ok: true; principal: PrincipalContext }
  | {
      ok: false;
      error: {
        code:
          | "MISSING_TRUSTED_PRINCIPAL_FIELD"
          | "INVALID_TRUSTED_PRINCIPAL_FIELD";
        field: TrustedPrincipalHeaderName;
      };
    };

function hasHeaderGetter(
  headers: TrustedPrincipalHeaders
): headers is { get(name: string): string | null | undefined } {
  return "get" in headers && typeof headers.get === "function";
}

function readTrustedHeader(
  headers: TrustedPrincipalHeaders,
  name: TrustedPrincipalHeaderName
): string | undefined {
  if (hasHeaderGetter(headers)) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name];
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  return value.join(",");
}

function parseList(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function isPrincipalType(value: string): value is PrincipalType {
  return (PRINCIPAL_TYPES as readonly string[]).includes(value);
}

function isAuthSource(value: string): value is AuthSource {
  return (AUTH_SOURCES as readonly string[]).includes(value);
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function missing(field: TrustedPrincipalHeaderName): TrustedPrincipalParseResult {
  return {
    ok: false,
    error: { code: "MISSING_TRUSTED_PRINCIPAL_FIELD", field },
  };
}

function invalid(field: TrustedPrincipalHeaderName): TrustedPrincipalParseResult {
  return {
    ok: false,
    error: { code: "INVALID_TRUSTED_PRINCIPAL_FIELD", field },
  };
}

function findArrayValuedHeader(
  headers: TrustedPrincipalHeaders
): TrustedPrincipalHeaderName | undefined {
  if (hasHeaderGetter(headers)) return undefined;
  return Object.values(TRUSTED_PRINCIPAL_HEADERS).find((name) =>
    Array.isArray(headers[name])
  );
}

export function parseTrustedPrincipal(
  headers: TrustedPrincipalHeaders
): TrustedPrincipalParseResult {
  const arrayValuedHeader = findArrayValuedHeader(headers);
  if (arrayValuedHeader !== undefined) return invalid(arrayValuedHeader);

  const principalId = readTrustedHeader(headers, TRUSTED_PRINCIPAL_HEADERS.principalId)?.trim();
  if (!principalId) return missing(TRUSTED_PRINCIPAL_HEADERS.principalId);

  const principalType = readTrustedHeader(
    headers,
    TRUSTED_PRINCIPAL_HEADERS.principalType
  )?.trim();
  if (!principalType) return missing(TRUSTED_PRINCIPAL_HEADERS.principalType);
  if (!isPrincipalType(principalType)) {
    return invalid(TRUSTED_PRINCIPAL_HEADERS.principalType);
  }

  const tenantId = readTrustedHeader(headers, TRUSTED_PRINCIPAL_HEADERS.tenantId)?.trim();
  if (!tenantId) return missing(TRUSTED_PRINCIPAL_HEADERS.tenantId);

  const roles = readTrustedHeader(headers, TRUSTED_PRINCIPAL_HEADERS.roles);
  if (roles === undefined) return missing(TRUSTED_PRINCIPAL_HEADERS.roles);

  const scopes = readTrustedHeader(headers, TRUSTED_PRINCIPAL_HEADERS.scopes);
  if (scopes === undefined) return missing(TRUSTED_PRINCIPAL_HEADERS.scopes);

  const authSource = readTrustedHeader(
    headers,
    TRUSTED_PRINCIPAL_HEADERS.authSource
  )?.trim();
  if (!authSource) return missing(TRUSTED_PRINCIPAL_HEADERS.authSource);
  if (!isAuthSource(authSource)) {
    return invalid(TRUSTED_PRINCIPAL_HEADERS.authSource);
  }

  const authenticatedAt = readTrustedHeader(
    headers,
    TRUSTED_PRINCIPAL_HEADERS.authenticatedAt
  )?.trim();
  if (!authenticatedAt) return missing(TRUSTED_PRINCIPAL_HEADERS.authenticatedAt);
  if (!isIsoTimestamp(authenticatedAt)) {
    return invalid(TRUSTED_PRINCIPAL_HEADERS.authenticatedAt);
  }

  return {
    ok: true,
    principal: {
      principalId,
      principalType,
      tenantId,
      roles: parseList(roles),
      scopes: parseList(scopes),
      authSource,
      authenticatedAt,
    },
  };
}
