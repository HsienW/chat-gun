export const IDENTITY_FAILURE_CODES = [
  'IDENTITY_SESSION_EXPIRED',
  'IDENTITY_REVOKED_CREDENTIAL',
  'IDENTITY_ACCOUNT_SUSPENDED',
  'IDENTITY_DELETION_PENDING',
] as const;

export type IdentityFailureCode = (typeof IDENTITY_FAILURE_CODES)[number];
export type IdentityFailure = { code: IdentityFailureCode; message: string };
export type IdentityRecoveryAction = 'reauth' | 'safe_degrade';

export type AnonymousMigrationRequest = {
  schemaVersion: '1.0.0';
  anonymousId: string;
  anonymousSessionId: string;
  anonymousDeviceId: string;
  anonymousCredential: string;
  idempotencyKey: string;
};

export type AnonymousMigrationResponse = {
  schemaVersion: '1.0.0';
  result: 'migrated' | 'already_migrated' | 'conflict';
};

function parseJson(value: unknown): unknown {
  const candidate = value instanceof Error ? value.message : value;
  if (typeof candidate !== 'string') return candidate;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function isIdentityFailureCode(value: unknown): value is IdentityFailureCode {
  return typeof value === 'string' &&
    IDENTITY_FAILURE_CODES.some((candidate) => candidate === value);
}

export function parseIdentityFailure(value: unknown): IdentityFailure | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return isIdentityFailureCode(code) && typeof message === 'string'
    ? { code, message }
    : undefined;
}

export function classifyIdentityFailure(
  failure: IdentityFailure | undefined,
): IdentityRecoveryAction | undefined {
  if (!failure) return undefined;
  return failure.code === 'IDENTITY_SESSION_EXPIRED' ||
    failure.code === 'IDENTITY_REVOKED_CREDENTIAL'
    ? 'reauth'
    : 'safe_degrade';
}

function isMigrationResponse(value: unknown): value is AnonymousMigrationResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<AnonymousMigrationResponse>;
  return response.schemaVersion === '1.0.0' &&
    (response.result === 'migrated' ||
      response.result === 'already_migrated' ||
      response.result === 'conflict');
}

export async function migrateAnonymousIdentity(
  request: AnonymousMigrationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AnonymousMigrationResponse> {
  const response = await fetchImpl('/api/identity/anonymous-migrate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': request.idempotencyKey,
    },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json();
  if ((!response.ok && response.status !== 409) || !isMigrationResponse(body)) {
    throw new Error('IDENTITY_MIGRATION_FAILED');
  }
  return body;
}
