import type { Queryable } from "../persistence/rows.js";
import {
  AUTHORIZATION_EFFECTS,
  AUTHORIZATION_REASON_CODES,
  type AuthorizationDecision,
  type AuthorizationEffect,
  type AuthorizationReasonCode,
  type AuthorizationRequest,
} from "./authorization.js";
import {
  PRINCIPAL_TYPES,
  type PrincipalType,
} from "./principal.js";
import type { ResourceRef } from "./resource-ref.js";

const MAX_SUMMARY_STRING_LENGTH = 128;

export interface ContextRedactor {
  redact(context: Record<string, unknown>): Record<string, unknown>;
}

export interface ContextRedactorOptions {
  allowedFields?: readonly string[];
  blockedFields?: readonly string[];
}

const DEFAULT_ALLOWED_FIELDS = [
  "amount",
  "risk",
  "environment",
  "requestid",
  "threadid",
  "runid",
  "taskid",
  "stepid",
  "toolexecutionid",
  "toolname",
  "reasoncode",
] as const;

const DEFAULT_BLOCKED_FIELDS = [
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "email",
  "phone",
  "pii",
  "prompt",
  "messages",
  "input",
  "output",
] as const;

function summaryValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  return value.length <= MAX_SUMMARY_STRING_LENGTH
    ? value
    : value.slice(0, MAX_SUMMARY_STRING_LENGTH);
}

export class DefaultContextRedactor implements ContextRedactor {
  private readonly allowedFields: ReadonlySet<string>;
  private readonly blockedFields: ReadonlySet<string>;

  constructor(options: ContextRedactorOptions = {}) {
    this.allowedFields = new Set(
      (options.allowedFields ?? DEFAULT_ALLOWED_FIELDS).map((field) =>
        field.toLowerCase()
      )
    );
    this.blockedFields = new Set(
      [...DEFAULT_BLOCKED_FIELDS, ...(options.blockedFields ?? [])].map((field) =>
        field.toLowerCase()
      )
    );
  }

  redact(context: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(context)) {
      const normalizedField = field.toLowerCase();
      if (
        this.blockedFields.has(normalizedField) ||
        !this.allowedFields.has(normalizedField)
      ) {
        continue;
      }

      const redactedValue = summaryValue(value);
      if (redactedValue !== undefined) summary[field] = redactedValue;
    }
    return summary;
  }
}

export interface RecordDecisionInput {
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
  policyVersion?: string;
  executionContext?: import("../execution-context/execution-context.js").ExecutionContext;
  taskId?: string;
  stepId?: string;
  toolExecutionId?: string;
}

export interface DecisionStore {
  record(input: RecordDecisionInput): Promise<void>;
}

export interface AuthorizationDecisionObserver {
  recordAuthorizationDecision(
    input: RecordDecisionInput,
    contextSummary: Readonly<Record<string, unknown>>
  ): Promise<void>;
}

export interface StoredAuthorizationDecision {
  decision: AuthorizationDecision;
  principalId: string;
  principalType: PrincipalType;
  tenantId: string;
  scopeId: string;
  action: string;
  resource: ResourceRef;
  policyVersion?: string;
  taskId?: string;
  stepId?: string;
  toolExecutionId?: string;
  contextSummary: Record<string, unknown>;
}

interface PermissionDecisionRow extends Record<string, unknown> {
  decision_id: unknown;
  principal_id: unknown;
  principal_type: unknown;
  tenant_id: unknown;
  scope_id: unknown;
  action: unknown;
  resource_type: unknown;
  resource_id: unknown;
  effect: unknown;
  reason_code: unknown;
  matched_policy: unknown;
  matched_grant_id: unknown;
  policy_version: unknown;
  task_id: unknown;
  step_id: unknown;
  tool_execution_id: unknown;
  context_summary: unknown;
  created_at: unknown;
}

const DECISION_COLUMNS = `
  decision_id, principal_id, principal_type, tenant_id, scope_id, action,
  resource_type, resource_id, effect, reason_code, matched_policy,
  matched_grant_id, policy_version, task_id, step_id, tool_execution_id,
  context_summary, created_at
`;

function requiredString(value: unknown, column: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${column} returned from permission_decisions`);
  }
  return value;
}

function optionalString(value: unknown, column: string): string | undefined {
  return value === null ? undefined : requiredString(value, column);
}

function isPrincipalType(value: string): value is PrincipalType {
  return PRINCIPAL_TYPES.some((principalType) => principalType === value);
}

function isAuthorizationEffect(value: string): value is AuthorizationEffect {
  return AUTHORIZATION_EFFECTS.some((effect) => effect === value);
}

function isAuthorizationReasonCode(
  value: string
): value is AuthorizationReasonCode {
  return AUTHORIZATION_REASON_CODES.some((reasonCode) => reasonCode === value);
}

function isoString(value: unknown, column: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error(`Invalid ${column} returned from permission_decisions`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${column} returned from permission_decisions`);
  }
  return date.toISOString();
}

function contextSummary(value: unknown): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid context_summary returned from permission_decisions");
  }
  return { ...value };
}

function mapDecisionRow(row: PermissionDecisionRow): StoredAuthorizationDecision {
  const principalType = requiredString(row.principal_type, "principal_type");
  if (!isPrincipalType(principalType)) {
    throw new Error("Invalid principal_type returned from permission_decisions");
  }
  const effect = requiredString(row.effect, "effect");
  if (!isAuthorizationEffect(effect)) {
    throw new Error("Invalid effect returned from permission_decisions");
  }
  const reasonCode = requiredString(row.reason_code, "reason_code");
  if (!isAuthorizationReasonCode(reasonCode)) {
    throw new Error("Invalid reason_code returned from permission_decisions");
  }

  const tenantId = requiredString(row.tenant_id, "tenant_id");
  const matchedPolicy = optionalString(row.matched_policy, "matched_policy");
  const matchedGrantId = optionalString(
    row.matched_grant_id,
    "matched_grant_id"
  );
  const policyVersion = optionalString(row.policy_version, "policy_version");
  const taskId = optionalString(row.task_id, "task_id");
  const stepId = optionalString(row.step_id, "step_id");
  const toolExecutionId = optionalString(
    row.tool_execution_id,
    "tool_execution_id"
  );

  return {
    decision: {
      decisionId: requiredString(row.decision_id, "decision_id"),
      effect,
      reasonCode,
      ...(matchedPolicy === undefined ? {} : { matchedPolicy }),
      ...(matchedGrantId === undefined ? {} : { matchedGrantId }),
      createdAt: isoString(row.created_at, "created_at"),
    },
    principalId: requiredString(row.principal_id, "principal_id"),
    principalType,
    tenantId,
    scopeId: requiredString(row.scope_id, "scope_id"),
    action: requiredString(row.action, "action"),
    resource: {
      resourceType: requiredString(row.resource_type, "resource_type"),
      resourceId: requiredString(row.resource_id, "resource_id"),
      tenantId,
    },
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(toolExecutionId === undefined ? {} : { toolExecutionId }),
    contextSummary: contextSummary(row.context_summary),
  };
}

export class PgDecisionStore implements DecisionStore {
  constructor(
    private readonly db: Queryable,
    private readonly redactor: ContextRedactor = new DefaultContextRedactor(),
    private readonly observer?: AuthorizationDecisionObserver
  ) {}

  async record(input: RecordDecisionInput): Promise<void> {
    const summary = this.redactor.redact(input.request.context ?? {});
    await this.db.query(
      `INSERT INTO permission_decisions (
         decision_id, principal_id, principal_type, tenant_id, scope_id,
         action, resource_type, resource_id, effect, reason_code,
         matched_policy, matched_grant_id, policy_version, task_id, step_id,
         tool_execution_id, context_summary, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        input.decision.decisionId,
        input.request.principal.principalId,
        input.request.principal.principalType,
        input.request.principal.tenantId,
        input.request.scope.scopeId,
        input.request.action,
        input.request.resource.resourceType,
        input.request.resource.resourceId,
        input.decision.effect,
        input.decision.reasonCode,
        input.decision.matchedPolicy ?? null,
        input.decision.matchedGrantId ?? null,
        input.policyVersion ?? null,
        input.taskId ?? null,
        input.stepId ?? null,
        input.toolExecutionId ?? null,
        summary,
        input.decision.createdAt,
      ]
    );
    await this.observer?.recordAuthorizationDecision(
      {
        ...input,
        request: {
          ...input.request,
          context: summary,
        },
      },
      summary
    );
  }

  async findByToolExecutionId(
    toolExecutionId: string
  ): Promise<StoredAuthorizationDecision | null> {
    const result = await this.db.query<PermissionDecisionRow>(
      `SELECT ${DECISION_COLUMNS}
       FROM permission_decisions
       WHERE tool_execution_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [toolExecutionId]
    );
    const row = result.rows[0];
    return row ? mapDecisionRow(row) : null;
  }
}
