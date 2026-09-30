const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,256}$/;

export type AnonymousMigrationRequest = {
  schemaVersion: "1.0.0";
  anonymousId: string;
  anonymousSessionId: string;
  anonymousDeviceId: string;
  anonymousCredential: string;
  idempotencyKey: string;
};

export type AnonymousMigrationResponse = {
  schemaVersion: "1.0.0";
  result: "migrated" | "already_migrated" | "conflict";
};

export type AnonymousOwnership = {
  anonymousId: string;
  accountId: string;
  status: "in_progress" | "complete";
};

type StoredAnonymousOwnership = AnonymousOwnership & {
  idempotencyKey: string;
};

export interface AnonymousCredentialVerifier {
  verify(input: {
    anonymousId: string;
    sessionId: string;
    deviceId: string;
    credential: string;
  }): Promise<boolean>;
}

export interface AnonymousMigrationStorePort {
  claim(input: {
    anonymousId: string;
    accountId: string;
    idempotencyKey: string;
  }): Promise<"claimed" | "resume" | "already_migrated" | "conflict">;
  complete(anonymousId: string, accountId: string): Promise<void>;
  getOwnership(anonymousId: string): Promise<AnonymousOwnership | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAnonymousMigrationRequest(
  value: unknown,
): AnonymousMigrationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = [
    "schemaVersion",
    "anonymousId",
    "anonymousSessionId",
    "anonymousDeviceId",
    "anonymousCredential",
    "idempotencyKey",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value)) ||
    value.schemaVersion !== "1.0.0" ||
    !OPAQUE_ID_PATTERN.test(String(value.anonymousId ?? "")) ||
    !OPAQUE_ID_PATTERN.test(String(value.anonymousSessionId ?? "")) ||
    !OPAQUE_ID_PATTERN.test(String(value.anonymousDeviceId ?? "")) ||
    typeof value.anonymousCredential !== "string" ||
    value.anonymousCredential.length < 1 ||
    value.anonymousCredential.length > 2048 ||
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
  ) return undefined;
  return {
    schemaVersion: "1.0.0",
    anonymousId: value.anonymousId as string,
    anonymousSessionId: value.anonymousSessionId as string,
    anonymousDeviceId: value.anonymousDeviceId as string,
    anonymousCredential: value.anonymousCredential,
    idempotencyKey: value.idempotencyKey,
  };
}

function migrationError(code: string): Error {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}

export function createInMemoryAnonymousMigrationStore(
  options: { interruptAfterClaimOnce?: boolean } = {},
): AnonymousMigrationStorePort {
  const ownership = new Map<string, StoredAnonymousOwnership>();
  let shouldInterrupt = options.interruptAfterClaimOnce ?? false;
  return {
    claim: async ({ anonymousId, accountId, idempotencyKey }) => {
      const current = ownership.get(anonymousId);
      if (!current) {
        ownership.set(anonymousId, {
          anonymousId,
          accountId,
          idempotencyKey,
          status: "in_progress",
        });
        return "claimed";
      }
      if (current.accountId !== accountId) return "conflict";
      return current.status === "complete" ? "already_migrated" : "resume";
    },
    complete: async (anonymousId, accountId) => {
      const current = ownership.get(anonymousId);
      if (!current || current.accountId !== accountId) {
        throw migrationError("ANONYMOUS_MIGRATION_OWNERSHIP_CHANGED");
      }
      if (shouldInterrupt) {
        shouldInterrupt = false;
        throw migrationError("MIGRATION_INTERRUPTED");
      }
      ownership.set(anonymousId, { ...current, status: "complete" });
    },
    getOwnership: async (anonymousId) => {
      const current = ownership.get(anonymousId);
      return current
        ? { anonymousId: current.anonymousId, accountId: current.accountId, status: current.status }
        : null;
    },
  };
}

export class AnonymousMigrationService {
  constructor(
    private readonly store: AnonymousMigrationStorePort,
    private readonly credentialVerifier: AnonymousCredentialVerifier,
  ) {}

  async migrate(
    request: AnonymousMigrationRequest,
    target: { accountId: string; sessionId: string },
  ): Promise<AnonymousMigrationResponse> {
    const verified = await this.credentialVerifier.verify({
      anonymousId: request.anonymousId,
      sessionId: request.anonymousSessionId,
      deviceId: request.anonymousDeviceId,
      credential: request.anonymousCredential,
    });
    if (!verified) throw migrationError("ANONYMOUS_CREDENTIAL_INVALID");
    if (!target.accountId || !target.sessionId) {
      throw migrationError("AUTHENTICATED_SESSION_REQUIRED");
    }

    const claim = await this.store.claim({
      anonymousId: request.anonymousId,
      accountId: target.accountId,
      idempotencyKey: request.idempotencyKey,
    });
    if (claim === "conflict") return { schemaVersion: "1.0.0", result: "conflict" };
    if (claim === "already_migrated") {
      return { schemaVersion: "1.0.0", result: "already_migrated" };
    }
    await this.store.complete(request.anonymousId, target.accountId);
    return { schemaVersion: "1.0.0", result: "migrated" };
  }
}
