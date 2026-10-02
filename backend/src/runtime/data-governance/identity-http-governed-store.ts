import {
  deletionPartResultSchema,
  exportPartResultSchema,
  verificationResultSchema,
  type DataInventoryEntry,
  type DeletionPartResult,
  type ExportPartResult,
  type GovernedDataStore,
  type SubjectDataRequest,
  type SubjectDeletionRequest,
  type SubjectDeletionVerification,
  type VerificationResult,
} from "./contracts.js";

export type HttpIdentityGovernedStoreOptions = {
  baseUrl: URL;
  serviceToken: string;
  timeoutMs: number;
  failureThreshold?: number;
  cooldownMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
};

const IDENTITY_ACCESS_DENIAL_CODES = [
  "CROSS_TENANT_DENIED",
  "CROSS_ACCOUNT_DENIED",
  "CROSS_PRINCIPAL_DENIED",
] as const;

type IdentityAccessDenialCode = (typeof IDENTITY_ACCESS_DENIAL_CODES)[number];

class IdentityAccessDeniedError extends Error {
  constructor(readonly code: IdentityAccessDenialCode) {
    super(code);
    this.name = "IdentityAccessDeniedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAccessDenial(value: unknown): IdentityAccessDeniedError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const code = value.error.code;
  return typeof code === "string" &&
    IDENTITY_ACCESS_DENIAL_CODES.some((candidate) => candidate === code)
    ? new IdentityAccessDeniedError(code as IdentityAccessDenialCode)
    : undefined;
}

function unavailablePart(storeId: string, error: unknown) {
  return error instanceof IdentityAccessDeniedError
    ? {
        status: "failed" as const,
        storeId,
        errorCode: error.code,
        retryable: false,
      }
    : {
        status: "failed" as const,
        storeId,
        errorCode: "STORE_UNAVAILABLE",
        retryable: true,
      };
}

export class HttpIdentityGovernedStore implements GovernedDataStore {
  readonly id: string;
  readonly subjectKey: DataInventoryEntry["subjectKey"];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    entry: DataInventoryEntry,
    private readonly options: HttpIdentityGovernedStoreOptions,
  ) {
    if (!entry.dataClassId.startsWith("identity.") || options.serviceToken.length < 16) {
      throw new Error("INVALID_IDENTITY_GOVERNED_STORE_CONFIG");
    }
    this.id = entry.dataClassId;
    this.subjectKey = entry.subjectKey;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  private async call(operation: "export" | "delete" | "verify", request: SubjectDataRequest) {
    if (this.openUntil > this.now()) throw new Error("IDENTITY_CIRCUIT_OPEN");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetcher(
        new URL("/internal/governed-store/identity", this.options.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-service-token": this.options.serviceToken,
          },
          body: JSON.stringify({
            operation,
            storeId: this.id,
            subject: request.subject,
            idempotencyKey: request.idempotencyKey ?? request.workflowId,
          }),
          signal: controller.signal,
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const denial = parseAccessDenial(payload);
        if (denial) {
          this.consecutiveFailures = 0;
          throw denial;
        }
        throw new Error("IDENTITY_STORE_HTTP_FAILURE");
      }
      this.consecutiveFailures = 0;
      return payload;
    } catch (error) {
      if (error instanceof IdentityAccessDeniedError) throw error;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = this.now() + this.cooldownMs;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async exportSubjectData(request: SubjectDataRequest): Promise<ExportPartResult> {
    try {
      const result = exportPartResultSchema.parse(await this.call("export", request));
      return { ...result, storeId: this.id };
    } catch (error) {
      return unavailablePart(this.id, error);
    }
  }

  async deleteSubjectData(request: SubjectDeletionRequest): Promise<DeletionPartResult> {
    try {
      const result = deletionPartResultSchema.parse(await this.call("delete", request));
      return { ...result, storeId: this.id };
    } catch (error) {
      return unavailablePart(this.id, error);
    }
  }

  async verifySubjectDeletion(request: SubjectDeletionVerification): Promise<VerificationResult> {
    try {
      const result = verificationResultSchema.parse(await this.call("verify", request));
      return { ...result, storeId: this.id };
    } catch (error) {
      return unavailablePart(this.id, error);
    }
  }
}
