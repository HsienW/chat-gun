import { createHash, timingSafeEqual } from "node:crypto";

import type { PrincipalContext } from "./identity.js";
import type { PgQueryable } from "./identity-postgres.js";

export const SUBJECT_RIGHTS_SCHEMA_VERSION = "1.0.0" as const;

export type SubjectIdentity = {
  accountId: string;
  tenantId: string;
  principalId: string;
};

export type SubjectRightWorkflowProjection = {
  schemaVersion: typeof SUBJECT_RIGHTS_SCHEMA_VERSION;
  workflowId: string;
  type: "export" | "deletion" | "deletion_verification" | "consent";
  status: "requested" | "in_progress" | "completed" | "failed" | "expired";
  receipt?: {
    status: "completed" | "incomplete";
    parts: Array<{
      storeId: string;
      status: "completed" | "skipped" | "retained_by_policy" | "failed";
      reasonCode?: string;
      retryable?: boolean;
    }>;
  };
};

export interface SubjectRightsBackendPort {
  requestExport(input: {
    workflowId: string;
    subject: SubjectIdentity;
    deadline: string;
    idempotencyKey: string;
  }): Promise<SubjectRightWorkflowProjection>;
  requestDeletion(input: {
    workflowId: string;
    subject: SubjectIdentity;
    deadline: string;
    idempotencyKey: string;
  }): Promise<SubjectRightWorkflowProjection>;
  recordConsent(input: {
    consentId: string;
    accountId: string;
    policyVersion: number;
    status: "granted" | "withdrawn";
    scope:
      | "personalization"
      | "evaluation_contribution"
      | "proactive_background_work";
    recordedAt: string;
  }): Promise<SubjectRightWorkflowProjection>;
  getWorkflow(
    workflowId: string,
    subject: SubjectIdentity,
  ): Promise<SubjectRightWorkflowProjection | undefined>;
}

export class SubjectRightsBoundaryError extends Error {
  constructor(
    readonly code:
      | "AUTHENTICATED_ACCOUNT_REQUIRED"
      | "INVALID_SUBJECT_RIGHT_REQUEST"
      | "CLIENT_SUBJECT_NOT_ALLOWED"
      | "WORKFLOW_NOT_FOUND"
      | "WORKFLOW_TYPE_MISMATCH"
      | "WORKFLOW_ID_CONFLICT"
      | "EXPORT_LINK_EXPIRED"
      | "CROSS_TENANT_DENIED"
      | "CROSS_ACCOUNT_DENIED"
      | "CROSS_PRINCIPAL_DENIED"
      | "STORE_UNAVAILABLE",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SubjectRightsBoundaryError";
  }
}

const SAFE_MESSAGES: Readonly<Record<SubjectRightsBoundaryError["code"], string>> = {
  AUTHENTICATED_ACCOUNT_REQUIRED: "Authenticated account session required",
  INVALID_SUBJECT_RIGHT_REQUEST: "Subject-right request is invalid",
  CLIENT_SUBJECT_NOT_ALLOWED: "Subject identity is server-controlled",
  WORKFLOW_NOT_FOUND: "Subject-right workflow was not found",
  WORKFLOW_TYPE_MISMATCH: "Subject-right workflow type conflicts with the request",
  WORKFLOW_ID_CONFLICT: "Subject-right workflow ID conflicts with an existing request",
  EXPORT_LINK_EXPIRED: "Export link has expired",
  CROSS_TENANT_DENIED: "Subject-right access denied",
  CROSS_ACCOUNT_DENIED: "Subject-right access denied",
  CROSS_PRINCIPAL_DENIED: "Subject-right access denied",
  STORE_UNAVAILABLE: "Subject-right service is temporarily unavailable",
};

const BACKEND_FAILURE_STATUS: Readonly<Partial<
  Record<SubjectRightsBoundaryError["code"], number>
>> = {
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_TYPE_MISMATCH: 409,
  WORKFLOW_ID_CONFLICT: 409,
  EXPORT_LINK_EXPIRED: 410,
  CROSS_TENANT_DENIED: 403,
  CROSS_ACCOUNT_DENIED: 403,
  CROSS_PRINCIPAL_DENIED: 403,
  STORE_UNAVAILABLE: 503,
};

type RouteResult = {
  status: number;
  body: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBackendFailure(value: unknown): SubjectRightsBoundaryError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const code = value.error.code;
  if (typeof code !== "string" || !(code in BACKEND_FAILURE_STATUS)) return undefined;
  const typedCode = code as SubjectRightsBoundaryError["code"];
  const status = BACKEND_FAILURE_STATUS[typedCode];
  return status === undefined
    ? undefined
    : new SubjectRightsBoundaryError(typedCode, status, SAFE_MESSAGES[typedCode]);
}

function subjectFromPrincipal(principal: PrincipalContext): SubjectIdentity {
  if (principal.principalKind !== "authenticated" || !principal.accountId) {
    throw new SubjectRightsBoundaryError(
      "AUTHENTICATED_ACCOUNT_REQUIRED",
      401,
      SAFE_MESSAGES.AUTHENTICATED_ACCOUNT_REQUIRED,
    );
  }
  return {
    accountId: principal.accountId,
    tenantId: principal.tenantId,
    principalId: principal.principalId,
  };
}

function rejectClientSubject(body: Record<string, unknown>): void {
  if (
    "accountId" in body ||
    "tenantId" in body ||
    "principalId" in body ||
    "subject" in body
  ) {
    throw new SubjectRightsBoundaryError(
      "CLIENT_SUBJECT_NOT_ALLOWED",
      400,
      SAFE_MESSAGES.CLIENT_SUBJECT_NOT_ALLOWED,
    );
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new SubjectRightsBoundaryError(
      "INVALID_SUBJECT_RIGHT_REQUEST",
      400,
      SAFE_MESSAGES.INVALID_SUBJECT_RIGHT_REQUEST,
    );
  }
  return value;
}

function failure(error: unknown): RouteResult {
  if (error instanceof SubjectRightsBoundaryError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: SAFE_MESSAGES[error.code] } },
    };
  }
  return {
    status: 503,
    body: {
      error: {
        code: "STORE_UNAVAILABLE",
        message: SAFE_MESSAGES.STORE_UNAVAILABLE,
      },
    },
  };
}

export async function executeSubjectRightRoute(input: {
  method: string;
  pathname: string;
  body: unknown;
  principal: PrincipalContext;
  backend: SubjectRightsBackendPort;
  now?: () => Date;
}): Promise<RouteResult> {
  try {
    const subject = subjectFromPrincipal(input.principal);
    const now = input.now ?? (() => new Date());
    const match = /^\/api\/subject-rights\/([^/]+)$/u.exec(input.pathname);
    if (input.method === "GET" && match) {
      const workflow = await input.backend.getWorkflow(match[1] ?? "", subject);
      if (!workflow) {
        throw new SubjectRightsBoundaryError(
          "WORKFLOW_NOT_FOUND",
          404,
          SAFE_MESSAGES.WORKFLOW_NOT_FOUND,
        );
      }
      return { status: 200, body: workflow };
    }
    if (input.method !== "POST" || !isRecord(input.body)) {
      throw new SubjectRightsBoundaryError(
        "INVALID_SUBJECT_RIGHT_REQUEST",
        400,
        SAFE_MESSAGES.INVALID_SUBJECT_RIGHT_REQUEST,
      );
    }
    rejectClientSubject(input.body);
    const idempotencyKey = requiredString(input.body, "idempotencyKey");
    const workflowId = requiredString(input.body, "workflowId");
    const deadline =
      typeof input.body.deadline === "string"
        ? input.body.deadline
        : new Date(now().getTime() + 24 * 60 * 60 * 1_000).toISOString();
    if (input.pathname === "/api/subject-rights/export") {
      return {
        status: 202,
        body: await input.backend.requestExport({
          workflowId,
          subject,
          deadline,
          idempotencyKey,
        }),
      };
    }
    if (input.pathname === "/api/subject-rights/deletion") {
      return {
        status: 202,
        body: await input.backend.requestDeletion({
          workflowId,
          subject,
          deadline,
          idempotencyKey,
        }),
      };
    }
    if (input.pathname === "/api/subject-rights/consent") {
      const status = input.body.status;
      const scope = input.body.scope;
      const policyVersion = input.body.policyVersion;
      if (
        (status !== "granted" && status !== "withdrawn") ||
        (scope !== "personalization" &&
          scope !== "evaluation_contribution" &&
          scope !== "proactive_background_work") ||
        !Number.isInteger(policyVersion) ||
        Number(policyVersion) < 1
      ) {
        throw new SubjectRightsBoundaryError(
          "INVALID_SUBJECT_RIGHT_REQUEST",
          400,
          SAFE_MESSAGES.INVALID_SUBJECT_RIGHT_REQUEST,
        );
      }
      return {
        status: 202,
        body: await input.backend.recordConsent({
          consentId: workflowId,
          accountId: subject.accountId,
          policyVersion: Number(policyVersion),
          status,
          scope,
          recordedAt: now().toISOString(),
        }),
      };
    }
    throw new SubjectRightsBoundaryError(
      "INVALID_SUBJECT_RIGHT_REQUEST",
      404,
      SAFE_MESSAGES.INVALID_SUBJECT_RIGHT_REQUEST,
    );
  } catch (error) {
    return failure(error);
  }
}

export interface IdentityGovernanceStorePort {
  exportIdentity(subject: SubjectIdentity): Promise<Array<Record<string, unknown>>>;
  deleteIdentity(subject: SubjectIdentity, idempotencyKey: string): Promise<number>;
  countIdentity(subject: SubjectIdentity): Promise<number>;
}

export class IdentityGovernedStoreAdapter {
  readonly id = "identity.lifecycle";

  constructor(private readonly store: IdentityGovernanceStorePort) {}

  async exportSubjectData(subject: SubjectIdentity) {
    return {
      status: "completed" as const,
      storeId: this.id,
      records: await this.store.exportIdentity(subject),
    };
  }

  async deleteSubjectData(subject: SubjectIdentity, idempotencyKey: string) {
    return {
      status: "completed" as const,
      storeId: this.id,
      affectedRecords: await this.store.deleteIdentity(subject, idempotencyKey),
    };
  }

  async verifySubjectDeletion(subject: SubjectIdentity) {
    const remaining = await this.store.countIdentity(subject);
    return remaining === 0
      ? { status: "verified" as const, storeId: this.id }
      : {
          status: "failed" as const,
          storeId: this.id,
          errorCode: "SUBJECT_DATA_REMAINS",
          retryable: true,
        };
  }
}

export class PgIdentityGovernanceStore implements IdentityGovernanceStorePort {
  constructor(private readonly database: PgQueryable) {}

  async exportIdentity(subject: SubjectIdentity): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT a.account_id, a.user_id, a.tenant_id, a.status, a.created_at, a.updated_at
       FROM identity_accounts a
       WHERE a.account_id = $1 AND a.tenant_id = $2
         AND EXISTS (
           SELECT 1 FROM identity_sessions s
           WHERE s.account_id = a.account_id AND s.principal_id = $3
         )`,
      [subject.accountId, subject.tenantId, subject.principalId],
    );
    return result.rows.map((row) => ({ ...row }));
  }

  async deleteIdentity(subject: SubjectIdentity, idempotencyKey: string): Promise<number> {
    const accountIdHash = createHash("sha256")
      .update(subject.accountId, "utf8")
      .digest("hex");
    const result = await this.database.query<{ affected_records: number }>(
      `WITH owned_account AS (
         SELECT a.account_id
         FROM identity_accounts a
         WHERE a.account_id = $1 AND a.tenant_id = $2
           AND EXISTS (
             SELECT 1 FROM identity_sessions s
             WHERE s.account_id = a.account_id AND s.principal_id = $3
           )
       ), tombstone AS (
         INSERT INTO identity_account_tombstones
           (account_id_hash, deleted_at, tombstone_version, deletion_reason)
         SELECT $5, NOW(), 1, 'SUBJECT_REQUEST'
         FROM owned_account
         ON CONFLICT (account_id_hash) DO NOTHING
       ), deleted AS (
         DELETE FROM identity_accounts
         WHERE account_id IN (SELECT account_id FROM owned_account)
         RETURNING account_id
       )
       SELECT COUNT(*)::int AS affected_records FROM deleted
       WHERE $4::text IS NOT NULL`,
      [subject.accountId, subject.tenantId, subject.principalId, idempotencyKey, accountIdHash],
    );
    return result.rows[0]?.affected_records ?? 0;
  }

  async countIdentity(subject: SubjectIdentity): Promise<number> {
    const result = await this.database.query<{ record_count: number }>(
      `SELECT COUNT(*)::int AS record_count
       FROM identity_accounts a
       WHERE a.account_id = $1 AND a.tenant_id = $2
         AND EXISTS (
           SELECT 1 FROM identity_sessions s
           WHERE s.account_id = a.account_id AND s.principal_id = $3
         )`,
      [subject.accountId, subject.tenantId, subject.principalId],
    );
    return result.rows[0]?.record_count ?? 0;
  }
}

export async function executeIdentityGovernedStoreRoute(input: {
  serviceToken: string | undefined;
  expectedServiceToken: string;
  body: unknown;
  adapter: IdentityGovernedStoreAdapter;
}): Promise<RouteResult> {
  const actualToken = Buffer.from(input.serviceToken ?? "");
  const expectedToken = Buffer.from(input.expectedServiceToken);
  if (
    input.expectedServiceToken.length < 16 ||
    actualToken.length !== expectedToken.length ||
    !timingSafeEqual(actualToken, expectedToken)
  ) {
    return {
      status: 401,
      body: { error: { code: "INTERNAL_AUTH_REQUIRED", message: "Internal authentication required" } },
    };
  }
  if (!isRecord(input.body) || !isRecord(input.body.subject)) {
    return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Invalid request" } } };
  }
  const { accountId, tenantId, principalId } = input.body.subject;
  if (typeof accountId !== "string" || typeof tenantId !== "string" || typeof principalId !== "string") {
    return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Invalid request" } } };
  }
  const subject = { accountId, tenantId, principalId };
  try {
    if (input.body.operation === "export") {
      return { status: 200, body: await input.adapter.exportSubjectData(subject) };
    }
    if (input.body.operation === "delete" && typeof input.body.idempotencyKey === "string") {
      return {
        status: 200,
        body: await input.adapter.deleteSubjectData(subject, input.body.idempotencyKey),
      };
    }
    if (input.body.operation === "verify") {
      return { status: 200, body: await input.adapter.verifySubjectDeletion(subject) };
    }
    return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Invalid request" } } };
  } catch (error) {
    return failure(error);
  }
}

export function projectDeletionReceipt(
  workflow: SubjectRightWorkflowProjection,
): SubjectRightWorkflowProjection {
  return workflow.receipt
    ? {
        ...workflow,
        receipt: {
          status: workflow.receipt.status,
          parts: workflow.receipt.parts.map((part) => ({ ...part })),
        },
      }
    : { ...workflow };
}

type HttpSubjectRightsBackendOptions = {
  baseUrl: URL;
  serviceToken: string;
  timeoutMs: number;
  failureThreshold?: number;
  cooldownMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
};

function isWorkflowProjection(value: unknown): value is SubjectRightWorkflowProjection {
  if (!isRecord(value)) return false;
  return value.schemaVersion === SUBJECT_RIGHTS_SCHEMA_VERSION &&
    typeof value.workflowId === "string" &&
    (value.type === "export" || value.type === "deletion" ||
      value.type === "deletion_verification" || value.type === "consent") &&
    (value.status === "requested" || value.status === "in_progress" ||
      value.status === "completed" || value.status === "failed" ||
      value.status === "expired");
}

export class HttpSubjectRightsBackendClient implements SubjectRightsBackendPort {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly options: HttpSubjectRightsBackendOptions) {
    if (options.serviceToken.length < 16 || options.timeoutMs < 1) {
      throw new Error("INVALID_SUBJECT_RIGHTS_BACKEND_CONFIG");
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  private async call(pathname: string, body: Record<string, unknown>) {
    if (this.openUntil > this.now()) {
      throw new SubjectRightsBoundaryError(
        "STORE_UNAVAILABLE", 503, SAFE_MESSAGES.STORE_UNAVAILABLE,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetcher(new URL(pathname, this.options.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-service-token": this.options.serviceToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const failure = parseBackendFailure(payload);
        if (failure && failure.code !== "STORE_UNAVAILABLE") {
          this.consecutiveFailures = 0;
          throw failure;
        }
        throw new Error("SUBJECT_RIGHTS_BACKEND_FAILURE");
      }
      if (!isWorkflowProjection(payload)) {
        throw new Error("INVALID_SUBJECT_RIGHTS_BACKEND_RESPONSE");
      }
      this.consecutiveFailures = 0;
      return payload;
    } catch (error) {
      if (error instanceof SubjectRightsBoundaryError) throw error;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = this.now() + this.cooldownMs;
      }
      throw new SubjectRightsBoundaryError(
        "STORE_UNAVAILABLE", 503, SAFE_MESSAGES.STORE_UNAVAILABLE,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  requestExport(input: Parameters<SubjectRightsBackendPort["requestExport"]>[0]) {
    return this.call("/internal/subject-rights/export", input);
  }

  requestDeletion(input: Parameters<SubjectRightsBackendPort["requestDeletion"]>[0]) {
    return this.call("/internal/subject-rights/deletion", input);
  }

  recordConsent(input: Parameters<SubjectRightsBackendPort["recordConsent"]>[0]) {
    return this.call("/internal/subject-rights/consent", input);
  }

  async getWorkflow(workflowId: string, subject: SubjectIdentity) {
    try {
      return await this.call(
        `/internal/subject-rights/workflow/${encodeURIComponent(workflowId)}`,
        { subject },
      );
    } catch (error) {
      if (error instanceof SubjectRightsBoundaryError) throw error;
      return undefined;
    }
  }
}
