export const ACCOUNT_STATUSES = [
  "pending_verification",
  "active",
  "recovery_restricted",
  "suspended",
  "deletion_pending",
  "deleted",
] as const;

export const SESSION_STATUSES = [
  "active",
  "expired",
  "revoked",
  "compromised",
] as const;

export const PRINCIPAL_KINDS = [
  "anonymous",
  "authenticated",
  "service",
  "operator",
  "delegated",
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export type ResolvedProductIdentity = {
  accountId: string;
  userId: string;
  tenantId: string;
  sessionId: string;
  deviceId: string;
  credentialId: string;
  principalId: string;
  principalKind: PrincipalKind;
  roles: string[];
  scopes: string[];
  authSource: "oidc" | "service_token" | "development";
  authenticatedAt: string;
  accountStatus: AccountStatus;
  sessionStatus: SessionStatus;
  delegatedPrincipalId?: string;
  parentPrincipalId?: string;
  delegatedCapabilitySet?: string[];
};

export const IDENTITY_ERROR_CODES = [
  "IDENTITY_IDP_TIMEOUT",
  "IDENTITY_KEY_REFRESH_FAILED",
  "IDENTITY_MALFORMED_CLAIMS",
  "IDENTITY_CLOCK_SKEW",
  "IDENTITY_REVOKED_CREDENTIAL",
  "IDENTITY_ACCOUNT_STORE_UNAVAILABLE",
  "IDENTITY_SESSION_EXPIRED",
  "IDENTITY_ACCOUNT_SUSPENDED",
  "IDENTITY_DELETION_PENDING",
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

export type TypedIdentityError = {
  code: IdentityErrorCode;
  message: string;
  retryable: boolean;
  httpStatus: number;
};

export type IdentityResolution =
  | { ok: true; identity: ResolvedProductIdentity }
  | { ok: false; error: TypedIdentityError };

export type IdentityResolveInput = {
  credential: string;
  signal?: AbortSignal;
};

export interface IdentityProviderPort {
  readonly providerId: string;
  resolveIdentity(input: IdentityResolveInput): Promise<IdentityResolution>;
  refreshVerificationKeys?(): Promise<void>;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PRODUCT_IDENTITY_KEYS = new Set([
  "accountId",
  "userId",
  "tenantId",
  "sessionId",
  "deviceId",
  "credentialId",
  "principalId",
  "principalKind",
  "roles",
  "scopes",
  "authSource",
  "authenticatedAt",
  "accountStatus",
  "sessionStatus",
  "delegatedPrincipalId",
  "parentPrincipalId",
  "delegatedCapabilitySet",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(
    (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 128,
  );
}

export function parseResolvedProductIdentity(
  value: unknown,
): ResolvedProductIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !PRODUCT_IDENTITY_KEYS.has(key))) {
    return undefined;
  }
  const requiredIds = [
    value.accountId,
    value.userId,
    value.tenantId,
    value.sessionId,
    value.deviceId,
    value.credentialId,
    value.principalId,
  ];
  if (!requiredIds.every(isOpaqueId)) return undefined;
  if (!PRINCIPAL_KINDS.includes(value.principalKind as PrincipalKind)) return undefined;
  if (!ACCOUNT_STATUSES.includes(value.accountStatus as AccountStatus)) return undefined;
  if (!SESSION_STATUSES.includes(value.sessionStatus as SessionStatus)) return undefined;
  if (!isStringList(value.roles) || !isStringList(value.scopes)) return undefined;
  if (
    value.authSource !== "oidc" &&
    value.authSource !== "service_token" &&
    value.authSource !== "development"
  ) return undefined;
  if (
    typeof value.authenticatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.authenticatedAt))
  ) return undefined;
  if (value.principalKind === "delegated") {
    if (
      !isOpaqueId(value.delegatedPrincipalId) ||
      !isOpaqueId(value.parentPrincipalId) ||
      !isStringList(value.delegatedCapabilitySet) ||
      value.delegatedCapabilitySet.length === 0
    ) return undefined;
  }
  return {
    accountId: value.accountId as string,
    userId: value.userId as string,
    tenantId: value.tenantId as string,
    sessionId: value.sessionId as string,
    deviceId: value.deviceId as string,
    credentialId: value.credentialId as string,
    principalId: value.principalId as string,
    principalKind: value.principalKind as PrincipalKind,
    roles: [...value.roles],
    scopes: [...value.scopes],
    authSource: value.authSource,
    authenticatedAt: new Date(value.authenticatedAt).toISOString(),
    accountStatus: value.accountStatus as AccountStatus,
    sessionStatus: value.sessionStatus as SessionStatus,
    ...(isOpaqueId(value.delegatedPrincipalId)
      ? { delegatedPrincipalId: value.delegatedPrincipalId }
      : {}),
    ...(isOpaqueId(value.parentPrincipalId)
      ? { parentPrincipalId: value.parentPrincipalId }
      : {}),
    ...(isStringList(value.delegatedCapabilitySet)
      ? { delegatedCapabilitySet: [...value.delegatedCapabilitySet] }
      : {}),
  };
}

export function identityFailure(
  code: IdentityErrorCode,
  message: string,
  options: { retryable?: boolean; httpStatus?: number } = {},
): IdentityResolution {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      httpStatus: options.httpStatus ?? 401,
    },
  };
}
