import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Queryable } from "../persistence/rows.js";
import type { GovernedToolOutcome } from "./governed-outcome.js";
import type { ExecutionProfileEvidence, ExecutionProfileTerminationCause } from "../tool-dispatch/execution-profile.js";
import type {
  BusinessEffectKey,
  ReplayKey,
  ToolExecutionAttemptId,
  TrustedScope,
} from "./identity.js";

export const TOOL_EXECUTION_STATUSES = [
  "prepared",
  "executing",
  "committed",
  "failed",
  "unknown",
  "compensating",
  "compensated",
  "manual_intervention_required",
] as const;
export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];

export type BusinessEffectCommitState =
  | "prepared"
  | "committed"
  | "compensated"
  | "unknown";

export type CompensationExecutionStatus =
  | "prepared"
  | "executing"
  | "compensated"
  | "failed"
  | "manual_intervention_required";

export interface BusinessEffectRecord {
  businessEffectId: string;
  scopeId: string;
  tenantId: string;
  businessEffectKey: BusinessEffectKey;
  externalSystemNamespace?: string;
  externalOperationId?: string;
  commitState: BusinessEffectCommitState;
  expiresAt?: string;
}

export interface ToolExecutionRecord {
  toolExecutionId: string;
  businessEffectId?: string;
  replayKey: ReplayKey;
  requestHash: string;
  status: ToolExecutionStatus;
  resultRef?: string;
  stepId: string;
  toolName: string;
  toolVersion: string;
  decisionId?: string;
  executionProfileVersion?: string;
  effectiveCapabilities?: ExecutionProfileEvidence["effectiveCapabilities"];
  secretRefsUsed?: string[];
  egressDecision?: ExecutionProfileEvidence["egressDecision"];
  terminationCause?: ExecutionProfileTerminationCause;
}

export interface CommittedToolExecutionReference {
  toolExecutionId: string;
  businessEffectId: string;
}

export interface PrepareSideEffectInput {
  businessEffectId: string;
  toolExecutionId: string;
  businessEffectKey: BusinessEffectKey;
  scope: TrustedScope;
  replayKey: ReplayKey;
  requestHash: string;
  requestId?: string;
  threadId?: string;
  runId: string;
  taskId?: string;
  stepId: string;
  callIndex: number;
  toolName: string;
  toolVersion: string;
  externalSystemNamespace?: string;
  externalOperationId?: string;
  expiresAt?: string;
  securityEvidence?: ExecutionProfileEvidence;
}

export type PrepareSideEffectResult =
  | {
      type: "claimed";
      businessEffect: BusinessEffectRecord;
      execution: ToolExecutionRecord;
    }
  | {
      type: "existing_committed";
      businessEffect: BusinessEffectRecord;
      execution: ToolExecutionRecord;
    }
  | {
      type: "not_claimed";
      businessEffect: BusinessEffectRecord;
      execution: ToolExecutionRecord;
    }
  | { type: "conflict"; execution: ToolExecutionRecord }
  | { type: "unavailable"; errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE" };

export interface SideEffectDatabase extends Queryable {
  withTransaction<TResult>(
    operation: (transaction: Queryable) => Promise<TResult>
  ): Promise<TResult>;
}

export interface BusinessEffectLedger {
  prepare(input: PrepareSideEffectInput): Promise<PrepareSideEffectResult>;
  findExecutionByReplayKey(replayKey: ReplayKey): Promise<ToolExecutionRecord | null>;
  recordAttempt(input: {
    toolExecutionAttemptId: ToolExecutionAttemptId;
    toolExecutionId: string;
    executionAttempt: number;
  }): Promise<void>;
  completeAttempt(input: {
    toolExecutionAttemptId: ToolExecutionAttemptId;
    outcome: GovernedToolOutcome<unknown>["type"];
    dispatchState: "before" | "after" | "unknown";
    errorCode?: string;
  }): Promise<void>;
  linkAuthorizationDecision(input: {
    toolExecutionId: string;
    decisionId: string;
  }): Promise<void>;
  transitionExecution(input: {
    toolExecutionId: string;
    expectedStatus: ToolExecutionStatus;
    nextStatus: ToolExecutionStatus;
    resultRef?: string;
    terminationCause?: ExecutionProfileTerminationCause;
  }): Promise<void>;
  transitionBusinessEffect(input: {
    businessEffectId: string;
    expectedState: BusinessEffectCommitState;
    nextState: BusinessEffectCommitState;
    externalSystemNamespace?: string;
    externalOperationId?: string;
  }): Promise<void>;
  commitExecutionAndBusinessEffect(input: {
    toolExecutionId: string;
    expectedExecutionStatus: ToolExecutionStatus;
    resultRef: string;
    terminationCause?: ExecutionProfileTerminationCause;
    businessEffectId: string;
    expectedEffectState: BusinessEffectCommitState;
    externalSystemNamespace?: string;
    externalOperationId?: string;
  }): Promise<void>;
  findCommittedExecutionByStepId(
    stepId: string
  ): Promise<CommittedToolExecutionReference | null>;
  prepareCompensationExecution(input: {
    compensationExecutionId: string;
    businessEffectId: string;
    toolExecutionId: string;
    compensationActionId: string;
    context: Record<string, unknown>;
  }): Promise<void>;
  transitionCompensationExecution(input: {
    compensationExecutionId: string;
    expectedStatus: CompensationExecutionStatus;
    nextStatus: CompensationExecutionStatus;
  }): Promise<void>;
}

interface BusinessEffectRow extends Record<string, unknown> {
  business_effect_id: string;
  scope_id: string;
  tenant_id: string;
  business_effect_key: string;
  external_system_namespace: string | null;
  external_operation_id: string | null;
  commit_state: string;
  expires_at: string | Date | null;
}

interface ToolExecutionRow extends Record<string, unknown> {
  tool_execution_id: string;
  business_effect_id: string | null;
  replay_key: string;
  request_hash: string;
  status: string;
  result_ref: string | null;
  step_id: string;
  tool_name: string;
  tool_version: string;
  decision_id: string | null;
  execution_profile_version: string | null;
  effective_capabilities: ExecutionProfileEvidence["effectiveCapabilities"] | null;
  secret_refs_used: string[] | null;
  egress_decision: ExecutionProfileEvidence["egressDecision"];
  termination_cause: ExecutionProfileTerminationCause | null;
}

const BUSINESS_EFFECT_COLUMNS = `
  business_effect_id, scope_id, tenant_id, business_effect_key,
  external_system_namespace, external_operation_id, commit_state, expires_at,
  created_at, committed_at, updated_at
`;
const TOOL_EXECUTION_COLUMNS = `
  tool_execution_id, business_effect_id, replay_key, request_id, thread_id,
  run_id, task_id, step_id, tool_name, tool_version, call_index, status,
  request_hash, result_ref, decision_id, execution_profile_version,
  effective_capabilities, secret_refs_used, egress_decision, termination_cause,
  created_at, updated_at
`;

function toOptionalIsoString(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid ledger timestamp");
  return date.toISOString();
}

function isCommitState(value: string): value is BusinessEffectCommitState {
  return ["prepared", "committed", "compensated", "unknown"].includes(value);
}

function isToolExecutionStatus(value: string): value is ToolExecutionStatus {
  return TOOL_EXECUTION_STATUSES.includes(value as ToolExecutionStatus);
}

function mapBusinessEffect(row: BusinessEffectRow): BusinessEffectRecord {
  if (!isCommitState(row.commit_state)) {
    throw new Error(`Unknown business effect state: ${row.commit_state}`);
  }
  return {
    businessEffectId: row.business_effect_id,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    businessEffectKey: row.business_effect_key as BusinessEffectKey,
    ...(row.external_system_namespace
      ? { externalSystemNamespace: row.external_system_namespace }
      : {}),
    ...(row.external_operation_id
      ? { externalOperationId: row.external_operation_id }
      : {}),
    commitState: row.commit_state,
    ...(toOptionalIsoString(row.expires_at)
      ? { expiresAt: toOptionalIsoString(row.expires_at) }
      : {}),
  };
}

function mapToolExecution(row: ToolExecutionRow): ToolExecutionRecord {
  if (!isToolExecutionStatus(row.status)) {
    throw new Error(`Unknown tool execution status: ${row.status}`);
  }
  return {
    toolExecutionId: row.tool_execution_id,
    ...(row.business_effect_id
      ? { businessEffectId: row.business_effect_id }
      : {}),
    replayKey: row.replay_key as ReplayKey,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.result_ref ? { resultRef: row.result_ref } : {}),
    stepId: row.step_id,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.execution_profile_version
      ? { executionProfileVersion: row.execution_profile_version }
      : {}),
    ...(row.effective_capabilities
      ? { effectiveCapabilities: row.effective_capabilities }
      : {}),
    ...(row.secret_refs_used ? { secretRefsUsed: row.secret_refs_used } : {}),
    ...(row.egress_decision ? { egressDecision: row.egress_decision } : {}),
    ...(row.termination_cause ? { terminationCause: row.termination_cause } : {}),
  };
}

export class PgSideEffectDatabase implements SideEffectDatabase {
  constructor(private readonly pool: Pool) {}

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: TResult[]; rowCount: number | null }> {
    const result = await this.pool.query(text, [...values]);
    return { rows: result.rows as TResult[], rowCount: result.rowCount };
  }

  async withTransaction<TResult>(
    operation: (transaction: Queryable) => Promise<TResult>
  ): Promise<TResult> {
    const client = await this.pool.connect();
    const transaction: Queryable = {
      query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ) => {
        const result = await client.query(text, [...values]);
        return { rows: result.rows as TRow[], rowCount: result.rowCount };
      },
    };
    try {
      await client.query("BEGIN");
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class SideEffectStateConflictError extends Error {
  constructor(resourceType: string, resourceId: string) {
    super(`CAS transition failed for ${resourceType}: ${resourceId}`);
    this.name = "SideEffectStateConflictError";
  }
}

export class PgBusinessEffectLedger implements BusinessEffectLedger {
  constructor(private readonly db: SideEffectDatabase) {}

  async prepare(input: PrepareSideEffectInput): Promise<PrepareSideEffectResult> {
    try {
      return await this.db.withTransaction(async (transaction) => {
        const insertedEffect = await transaction.query<BusinessEffectRow>(
          `INSERT INTO business_effects (
             business_effect_id, scope_id, tenant_id, business_effect_key,
             external_system_namespace, external_operation_id, commit_state, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7)
           ON CONFLICT (tenant_id, scope_id, business_effect_key) DO NOTHING
           RETURNING ${BUSINESS_EFFECT_COLUMNS}`,
          [
            input.businessEffectId,
            input.scope.scopeId,
            input.scope.tenantId,
            input.businessEffectKey,
            input.externalSystemNamespace ?? null,
            input.externalOperationId ?? null,
            input.expiresAt ?? null,
          ]
        );
        const claimed = insertedEffect.rows.length > 0;
        const effectRow =
          insertedEffect.rows[0] ??
          (
            await transaction.query<BusinessEffectRow>(
              `SELECT ${BUSINESS_EFFECT_COLUMNS}
               FROM business_effects
               WHERE tenant_id = $1 AND scope_id = $2 AND business_effect_key = $3
               FOR UPDATE`,
              [input.scope.tenantId, input.scope.scopeId, input.businessEffectKey]
            )
          ).rows[0];
        if (!effectRow) throw new Error("Business effect disappeared during prepare");

        const businessEffect = mapBusinessEffect(effectRow);
        const reusableExecution =
          !claimed && businessEffect.commitState === "committed"
            ? (
                await transaction.query<ToolExecutionRow>(
                  `SELECT ${TOOL_EXECUTION_COLUMNS}
                   FROM tool_executions
                   WHERE business_effect_id = $1 AND status = 'committed'
                   ORDER BY updated_at DESC
                   LIMIT 1`,
                  [businessEffect.businessEffectId]
                )
              ).rows[0]
            : undefined;
        const executionStatus: ToolExecutionStatus = claimed
          ? "prepared"
          : businessEffect.commitState === "committed"
            ? "committed"
            : "unknown";
        const resultRef = reusableExecution?.result_ref ?? null;
        const insertedExecution = await transaction.query<ToolExecutionRow>(
          `INSERT INTO tool_executions (
             tool_execution_id, business_effect_id, replay_key, request_id,
             thread_id, run_id, task_id, step_id, tool_name, tool_version,
             call_index, status, request_hash, result_ref,
             execution_profile_version, effective_capabilities,
             secret_refs_used, egress_decision, termination_cause
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19
           )
           ON CONFLICT (replay_key) DO NOTHING
           RETURNING ${TOOL_EXECUTION_COLUMNS}`,
          [
            input.toolExecutionId,
            businessEffect.businessEffectId,
            input.replayKey,
            input.requestId ?? null,
            input.threadId ?? null,
            input.runId,
            input.taskId ?? null,
            input.stepId,
            input.toolName,
            input.toolVersion,
            input.callIndex,
            executionStatus,
            input.requestHash,
            resultRef,
            input.securityEvidence?.executionProfileVersion ?? null,
            input.securityEvidence?.effectiveCapabilities ?? null,
            input.securityEvidence?.secretRefsUsed ?? null,
            input.securityEvidence?.egressDecision ?? null,
            reusableExecution?.termination_cause ??
              (executionStatus === "committed" ? "completed" : null),
          ]
        );
        const executionRow =
          insertedExecution.rows[0] ??
          (
            await transaction.query<ToolExecutionRow>(
              `SELECT ${TOOL_EXECUTION_COLUMNS}
               FROM tool_executions WHERE replay_key = $1`,
              [input.replayKey]
            )
          ).rows[0];
        if (!executionRow) throw new Error("Tool execution disappeared during prepare");
        const execution = mapToolExecution(executionRow);
        if (execution.requestHash !== input.requestHash) {
          return { type: "conflict", execution };
        }
        if (claimed) return { type: "claimed", businessEffect, execution };
        return businessEffect.commitState === "committed"
          ? { type: "existing_committed", businessEffect, execution }
          : { type: "not_claimed", businessEffect, execution };
      });
    } catch {
      return {
        type: "unavailable",
        errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
      };
    }
  }

  async findExecutionByReplayKey(
    replayKey: ReplayKey
  ): Promise<ToolExecutionRecord | null> {
    const result = await this.db.query<ToolExecutionRow>(
      `SELECT ${TOOL_EXECUTION_COLUMNS}
       FROM tool_executions WHERE replay_key = $1`,
      [replayKey]
    );
    return result.rows[0] ? mapToolExecution(result.rows[0]) : null;
  }

  async recordAttempt(input: {
    toolExecutionAttemptId: ToolExecutionAttemptId;
    toolExecutionId: string;
    executionAttempt: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO tool_execution_attempts (
         tool_execution_attempt_id, tool_execution_id, execution_attempt,
         dispatch_state, started_at
       ) VALUES ($1, $2, $3, 'before', NOW())`,
      [input.toolExecutionAttemptId, input.toolExecutionId, input.executionAttempt]
    );
  }

  async completeAttempt(input: {
    toolExecutionAttemptId: ToolExecutionAttemptId;
    outcome: GovernedToolOutcome<unknown>["type"];
    dispatchState: "before" | "after" | "unknown";
    errorCode?: string;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE tool_execution_attempts
       SET dispatch_state = $2, outcome = $3, error_code = $4, ended_at = NOW()
       WHERE tool_execution_attempt_id = $1 AND ended_at IS NULL`,
      [
        input.toolExecutionAttemptId,
        input.dispatchState,
        input.outcome,
        input.errorCode ?? null,
      ]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new SideEffectStateConflictError(
        "tool_execution_attempt",
        input.toolExecutionAttemptId
      );
    }
  }

  async linkAuthorizationDecision(input: {
    toolExecutionId: string;
    decisionId: string;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE tool_executions
       SET decision_id = $2, updated_at = NOW()
       WHERE tool_execution_id = $1 AND status = 'executing'`,
      [input.toolExecutionId, input.decisionId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new SideEffectStateConflictError(
        "tool_execution",
        input.toolExecutionId
      );
    }
  }

  async transitionExecution(input: {
    toolExecutionId: string;
    expectedStatus: ToolExecutionStatus;
    nextStatus: ToolExecutionStatus;
    resultRef?: string;
    terminationCause?: ExecutionProfileTerminationCause;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE tool_executions
       SET status = $3,
           result_ref = CASE WHEN $4::text IS NULL THEN result_ref ELSE $4 END,
           termination_cause = CASE
             WHEN $5::text IS NULL THEN termination_cause
             ELSE $5
           END,
           updated_at = NOW()
       WHERE tool_execution_id = $1 AND status = $2`,
      [
        input.toolExecutionId,
        input.expectedStatus,
        input.nextStatus,
        input.resultRef ?? null,
        input.terminationCause ?? null,
      ]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new SideEffectStateConflictError("tool_execution", input.toolExecutionId);
    }
  }

  async transitionBusinessEffect(input: {
    businessEffectId: string;
    expectedState: BusinessEffectCommitState;
    nextState: BusinessEffectCommitState;
    externalSystemNamespace?: string;
    externalOperationId?: string;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE business_effects
       SET commit_state = $3,
           external_system_namespace = COALESCE($4, external_system_namespace),
           external_operation_id = COALESCE($5, external_operation_id),
           committed_at = CASE WHEN $3 = 'committed' THEN NOW() ELSE committed_at END,
           updated_at = NOW()
       WHERE business_effect_id = $1 AND commit_state = $2`,
      [
        input.businessEffectId,
        input.expectedState,
        input.nextState,
        input.externalSystemNamespace ?? null,
        input.externalOperationId ?? null,
      ]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new SideEffectStateConflictError("business_effect", input.businessEffectId);
    }
  }

  async commitExecutionAndBusinessEffect(input: {
    toolExecutionId: string;
    expectedExecutionStatus: ToolExecutionStatus;
    resultRef: string;
    terminationCause?: ExecutionProfileTerminationCause;
    businessEffectId: string;
    expectedEffectState: BusinessEffectCommitState;
    externalSystemNamespace?: string;
    externalOperationId?: string;
  }): Promise<void> {
    await this.db.withTransaction(async (transaction) => {
      const executionResult = await transaction.query(
        `UPDATE tool_executions
         SET status = 'committed', result_ref = $3,
             termination_cause = $4, updated_at = NOW()
         WHERE tool_execution_id = $1 AND status = $2`,
        [
          input.toolExecutionId,
          input.expectedExecutionStatus,
          input.resultRef,
          input.terminationCause ?? "completed",
        ]
      );
      if ((executionResult.rowCount ?? 0) !== 1) {
        throw new SideEffectStateConflictError(
          "tool_execution",
          input.toolExecutionId
        );
      }

      const effectResult = await transaction.query(
        `UPDATE business_effects
         SET commit_state = 'committed',
             external_system_namespace = COALESCE($3, external_system_namespace),
             external_operation_id = COALESCE($4, external_operation_id),
             committed_at = NOW(), updated_at = NOW()
         WHERE business_effect_id = $1 AND commit_state = $2`,
        [
          input.businessEffectId,
          input.expectedEffectState,
          input.externalSystemNamespace ?? null,
          input.externalOperationId ?? null,
        ]
      );
      if ((effectResult.rowCount ?? 0) !== 1) {
        throw new SideEffectStateConflictError(
          "business_effect",
          input.businessEffectId
        );
      }
    });
  }

  async findCommittedExecutionByStepId(
    stepId: string
  ): Promise<CommittedToolExecutionReference | null> {
    const result = await this.db.query<
      Record<string, unknown> & {
        tool_execution_id: string;
        business_effect_id: string;
      }
    >(
      `SELECT tool_execution_id, business_effect_id
       FROM tool_executions
       WHERE step_id = $1 AND status = 'committed' AND business_effect_id IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [stepId]
    );
    const row = result.rows[0];
    return row
      ? {
          toolExecutionId: row.tool_execution_id,
          businessEffectId: row.business_effect_id,
        }
      : null;
  }

  async prepareCompensationExecution(input: {
    compensationExecutionId: string;
    businessEffectId: string;
    toolExecutionId: string;
    compensationActionId: string;
    context: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO compensation_executions (
         compensation_execution_id, business_effect_id, tool_execution_id,
         compensation_action_id, status, context
       ) VALUES ($1, $2, $3, $4, 'prepared', $5)`,
      [
        input.compensationExecutionId,
        input.businessEffectId,
        input.toolExecutionId,
        input.compensationActionId,
        input.context,
      ]
    );
  }

  async transitionCompensationExecution(input: {
    compensationExecutionId: string;
    expectedStatus: CompensationExecutionStatus;
    nextStatus: CompensationExecutionStatus;
  }): Promise<void> {
    const result = await this.db.query(
      `UPDATE compensation_executions
       SET status = $3, updated_at = NOW()
       WHERE compensation_execution_id = $1 AND status = $2`,
      [input.compensationExecutionId, input.expectedStatus, input.nextStatus]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new SideEffectStateConflictError(
        "compensation_execution",
        input.compensationExecutionId
      );
    }
  }
}

export function createCompensationExecutionId(): string {
  return randomUUID();
}
