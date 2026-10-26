import { randomBytes } from "node:crypto";

import {
  AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION,
  confirmationInterruptPayloadSchema,
  confirmationRequiredDescriptorSchema,
  confirmationResumeSchema,
  type ConfirmationConsumeFailureReason,
  type ConfirmationConsumeResult,
  type ConfirmationInterruptPayload,
  type ConfirmationRequiredDescriptor,
  type ConfirmationResume,
} from "@gun-ai/harness-contracts";

import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { Queryable } from "../persistence/rows.js";
import { createConfirmationInterruptId } from "../recovery/confirmation-manifest.js";
import type { ResourceRef } from "./resource-ref.js";

export {
  AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION,
  confirmationInterruptPayloadSchema,
  confirmationRequiredDescriptorSchema,
  confirmationResumeSchema,
} from "@gun-ai/harness-contracts";
export type {
  ConfirmationConsumeFailureReason,
  ConfirmationConsumeResult,
  ConfirmationInterruptPayload,
  ConfirmationRequiredDescriptor,
  ConfirmationResume,
} from "@gun-ai/harness-contracts";

export interface CreateConfirmationRequiredDescriptorInput {
  decisionId: string;
  executionContext: ExecutionContext;
  action: string;
  toolName: string;
  resource: ResourceRef;
  policyVersion: string;
  timeoutMs: number;
  now?: Date;
}

export function createConfirmationRequiredDescriptor(
  input: CreateConfirmationRequiredDescriptorInput
): ConfirmationRequiredDescriptor {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Confirmation timeoutMs must be a positive finite number");
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.timeoutMs).toISOString();
  return confirmationRequiredDescriptorSchema.parse({
    type: "confirmation_required",
    schemaVersion: AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION,
    decisionId: input.decisionId,
    approvalId: randomBytes(32).toString("hex"),
    requestId: input.executionContext.requestId,
    threadId: input.executionContext.threadId,
    runId: input.executionContext.runId,
    taskId: input.executionContext.taskId,
    ...(input.executionContext.stepId
      ? { stepId: input.executionContext.stepId }
      : {}),
    ...(input.executionContext.toolCallId
      ? { toolCallId: input.executionContext.toolCallId }
      : {}),
    scope: {
      scopeId: input.executionContext.scope.scopeId,
      scopeType: input.executionContext.scope.scopeType,
      tenantId: input.executionContext.scope.tenantId,
    },
    resource: input.resource,
    policyVersion: input.policyVersion,
    expiresAt,
    allowedApproverPrincipalIds: [
      input.executionContext.principal.principalId,
    ],
    resumeCompatibility: {
      type: "tool_authorization_confirmation",
      schemaVersion: AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION,
      decisions: ["approve", "deny"],
    },
    summary: {
      toolName: input.toolName,
      action: input.action,
      resourceType: input.resource.resourceType,
    },
  });
}

export function toConfirmationInterruptPayload(
  descriptor: ConfirmationRequiredDescriptor
): ConfirmationInterruptPayload {
  return confirmationInterruptPayloadSchema.parse({
    type: "tool_authorization_confirmation",
    schemaVersion: descriptor.schemaVersion,
    approvalId: descriptor.approvalId,
    decisionId: descriptor.decisionId,
    expiresAt: descriptor.expiresAt,
    resumeCompatibility: descriptor.resumeCompatibility,
    summary: descriptor.summary,
  });
}

export function parseConfirmationResume(value: unknown): ConfirmationResume {
  return confirmationResumeSchema.parse(value);
}

export interface ConsumeConfirmationInput {
  descriptor: ConfirmationRequiredDescriptor;
  resume: ConfirmationResume;
  executionContext: ExecutionContext;
  now?: Date;
}

export interface AuthorizationConfirmationStore {
  upsertPending(descriptor: ConfirmationRequiredDescriptor): Promise<void>;
  consume(input: ConsumeConfirmationInput): Promise<ConfirmationConsumeResult>;
}

export interface WithdrawConfirmationInput {
  descriptor: ConfirmationRequiredDescriptor;
  /** The cancelling run's context; its runId is intentionally not bound to the descriptor. */
  executionContext: ExecutionContext;
  now?: Date;
}

export type ConfirmationWithdrawResult =
  | { ok: true; status: "withdrawn" | "expired" }
  | {
      ok: false;
      reasonCode:
        | "CONFIRMATION_BINDING_MISMATCH"
        | "CONFIRMATION_ALREADY_DECIDED"
        | "CONFIRMATION_WITHDRAW_FAILED";
    };

export interface ConfirmationStatusSnapshot {
  status: "pending" | "approved" | "denied" | "expired";
  withdrawn: boolean;
  expiresAt: string;
}

/** Withdrawal is stored as `denied` plus `withdrawn_at`, so older readers still see a non-consumable decision. */
export interface AuthorizationConfirmationWithdrawalStore {
  withdraw(input: WithdrawConfirmationInput): Promise<ConfirmationWithdrawResult>;
  findStatus(input: {
    approvalId: string;
    decisionId: string;
  }): Promise<ConfirmationStatusSnapshot | null>;
}

export interface ConfirmationAuditSink {
  record(eventName: string, payload: Record<string, unknown>): Promise<void> | void;
}

const noopAuditSink: ConfirmationAuditSink = { record: () => undefined };

function hasMatchingWithdrawalBinding(input: WithdrawConfirmationInput): boolean {
  const { descriptor, executionContext } = input;
  return (
    executionContext.scope.scopeId === descriptor.scope.scopeId &&
    executionContext.scope.scopeType === descriptor.scope.scopeType &&
    executionContext.scope.tenantId === descriptor.scope.tenantId &&
    descriptor.resource.tenantId === descriptor.scope.tenantId &&
    descriptor.allowedApproverPrincipalIds.includes(
      executionContext.principal.principalId
    )
  );
}

const CONFIRMATION_STATUSES = ["pending", "approved", "denied", "expired"] as const;

function isConfirmationStatus(
  value: unknown
): value is ConfirmationStatusSnapshot["status"] {
  return CONFIRMATION_STATUSES.some((status) => status === value);
}

function toIsoString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid confirmation timestamp");
  return date.toISOString();
}

function hasMatchingBinding(input: ConsumeConfirmationInput): boolean {
  const { descriptor, resume, executionContext } = input;
  return (
    resume.approvalId === descriptor.approvalId &&
    resume.decisionId === descriptor.decisionId &&
    executionContext.runId === descriptor.runId &&
    executionContext.scope.scopeId === descriptor.scope.scopeId &&
    executionContext.scope.scopeType === descriptor.scope.scopeType &&
    executionContext.scope.tenantId === descriptor.scope.tenantId &&
    descriptor.resource.tenantId === descriptor.scope.tenantId &&
    descriptor.allowedApproverPrincipalIds.includes(
      executionContext.principal.principalId
    )
  );
}

export class PgAuthorizationConfirmationStore
  implements AuthorizationConfirmationStore, AuthorizationConfirmationWithdrawalStore
{
  constructor(
    private readonly db: Queryable,
    private readonly audit: ConfirmationAuditSink = noopAuditSink
  ) {}

  async upsertPending(descriptor: ConfirmationRequiredDescriptor): Promise<void> {
    const validated = confirmationRequiredDescriptorSchema.parse(descriptor);
    const result = await this.db.query<{ task_id: string }>(
      `WITH pending AS (
         INSERT INTO authorization_confirmations (
           approval_id, decision_id, status, principal_ids, tenant_id, scope_id,
           scope_type, run_id, task_id, step_id, resource_type, resource_id,
           policy_version, descriptor, expires_at
         ) VALUES (
           $1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         )
         ON CONFLICT (decision_id) DO UPDATE SET
           descriptor = authorization_confirmations.descriptor
         WHERE authorization_confirmations.status = 'pending'
           AND authorization_confirmations.approval_id = EXCLUDED.approval_id
           AND authorization_confirmations.principal_ids = EXCLUDED.principal_ids
           AND authorization_confirmations.tenant_id = EXCLUDED.tenant_id
           AND authorization_confirmations.scope_id = EXCLUDED.scope_id
           AND authorization_confirmations.scope_type = EXCLUDED.scope_type
           AND authorization_confirmations.run_id = EXCLUDED.run_id
           AND authorization_confirmations.task_id = EXCLUDED.task_id
           AND authorization_confirmations.step_id IS NOT DISTINCT FROM EXCLUDED.step_id
           AND authorization_confirmations.resource_type = EXCLUDED.resource_type
           AND authorization_confirmations.resource_id = EXCLUDED.resource_id
           AND authorization_confirmations.policy_version = EXCLUDED.policy_version
           AND authorization_confirmations.descriptor = EXCLUDED.descriptor
           AND authorization_confirmations.expires_at = EXCLUDED.expires_at
         RETURNING task_id, step_id
       ), updated_task AS (
         UPDATE agent_tasks SET status = 'waiting_confirmation', updated_at = NOW()
         WHERE task_id IN (SELECT task_id FROM pending)
       ), updated_step AS (
         UPDATE task_steps SET status = 'waiting_confirmation', updated_at = NOW()
         WHERE step_id IN (SELECT step_id FROM pending WHERE step_id IS NOT NULL)
       )
       SELECT task_id FROM pending`,
      [
        validated.approvalId,
        validated.decisionId,
        validated.allowedApproverPrincipalIds,
        validated.scope.tenantId,
        validated.scope.scopeId,
        validated.scope.scopeType,
        validated.runId,
        validated.taskId,
        validated.stepId ?? null,
        validated.resource.resourceType,
        validated.resource.resourceId,
        validated.policyVersion,
        validated,
        validated.expiresAt,
      ]
    );
    if (!result.rows[0]) {
      throw new Error("Pending confirmation binding conflict");
    }
  }

  async consume(
    input: ConsumeConfirmationInput
  ): Promise<ConfirmationConsumeResult> {
    const descriptor = confirmationRequiredDescriptorSchema.parse(input.descriptor);
    const resume = confirmationResumeSchema.parse(input.resume);
    const validatedInput = { ...input, descriptor, resume };
    if (!hasMatchingBinding(validatedInput)) {
      await this.audit.record("authorization.confirmation.rejected", {
        decisionId: descriptor.decisionId,
        reasonCode: "CONFIRMATION_BINDING_MISMATCH",
      });
      return { ok: false, reasonCode: "CONFIRMATION_BINDING_MISMATCH" };
    }
    const now = input.now ?? new Date();
    const expired = await this.db.query<{ status: "expired" }>(
      `WITH expired AS (
         UPDATE authorization_confirmations
         SET status = 'expired', consumed_at = $3
         WHERE approval_id = $1
           AND decision_id = $2
           AND status = 'pending'
           AND expires_at <= $3
           AND tenant_id = $4
           AND scope_id = $5
           AND scope_type = $6
           AND run_id = $7
           AND resource_type = $8
           AND resource_id = $9
           AND policy_version = $10
           AND $11 = ANY(principal_ids)
         RETURNING status, decision_id, task_id, step_id
       ), updated_decision AS (
         UPDATE permission_decisions
         SET effect = 'deny', reason_code = 'CONFIRMATION_TIMEOUT'
         WHERE decision_id IN (SELECT decision_id FROM expired)
       ), updated_task AS (
         UPDATE agent_tasks SET status = 'cancelled', updated_at = $3
         WHERE task_id IN (SELECT task_id FROM expired)
       ), updated_step AS (
         UPDATE task_steps SET status = 'cancelled', updated_at = $3
         WHERE step_id IN (SELECT step_id FROM expired WHERE step_id IS NOT NULL)
       )
       SELECT status FROM expired`,
      [
        resume.approvalId,
        resume.decisionId,
        now.toISOString(),
        descriptor.scope.tenantId,
        descriptor.scope.scopeId,
        descriptor.scope.scopeType,
        descriptor.runId,
        descriptor.resource.resourceType,
        descriptor.resource.resourceId,
        descriptor.policyVersion,
        input.executionContext.principal.principalId,
      ]
    );
    if (expired.rows[0]) {
      await this.audit.record("authorization.confirmation.rejected", {
        decisionId: descriptor.decisionId,
        reasonCode: "CONFIRMATION_TIMEOUT",
      });
      return { ok: false, reasonCode: "CONFIRMATION_TIMEOUT" };
    }
    const status = resume.decision === "approve" ? "approved" : "denied";
    const reasonCode =
      status === "approved" ? "CONFIRMATION_APPROVED" : "CONFIRMATION_CANCELLED";
    const result = await this.db.query<{ status: "approved" | "denied" }>(
      `WITH consumed AS (
         UPDATE authorization_confirmations
         SET status = $3, consumed_at = $4
         WHERE approval_id = $1
           AND decision_id = $2
           AND status = 'pending'
           AND expires_at > $4
           AND tenant_id = $5
           AND scope_id = $6
           AND scope_type = $7
           AND run_id = $8
           AND resource_type = $9
           AND resource_id = $10
           AND policy_version = $11
           AND $12 = ANY(principal_ids)
         RETURNING status, decision_id, task_id, step_id
       ), updated_decision AS (
         UPDATE permission_decisions
         SET effect = $13, reason_code = $14
         WHERE decision_id IN (SELECT decision_id FROM consumed)
       ), updated_task AS (
         UPDATE agent_tasks
         SET status = CASE WHEN $3 = 'approved' THEN 'running' ELSE 'cancelled' END,
             updated_at = $4
         WHERE task_id IN (SELECT task_id FROM consumed)
       ), updated_step AS (
         UPDATE task_steps
         SET status = CASE WHEN $3 = 'approved' THEN 'running' ELSE 'cancelled' END,
             updated_at = $4
         WHERE step_id IN (SELECT step_id FROM consumed WHERE step_id IS NOT NULL)
       )
       SELECT status FROM consumed`,
      [
        resume.approvalId,
        resume.decisionId,
        status,
        now.toISOString(),
        descriptor.scope.tenantId,
        descriptor.scope.scopeId,
        descriptor.scope.scopeType,
        descriptor.runId,
        descriptor.resource.resourceType,
        descriptor.resource.resourceId,
        descriptor.policyVersion,
        input.executionContext.principal.principalId,
        status === "approved" ? "allow" : "deny",
        reasonCode,
      ]
    );
    const consumed = result.rows[0];
    if (!consumed) {
      await this.audit.record("authorization.confirmation.rejected", {
        decisionId: descriptor.decisionId,
        reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED",
      });
      return { ok: false, reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED" };
    }
    await this.audit.record("authorization.confirmation.consumed", {
      decisionId: descriptor.decisionId,
      status: consumed.status,
    });
    return { ok: true, status: consumed.status };
  }

  async withdraw(
    input: WithdrawConfirmationInput
  ): Promise<ConfirmationWithdrawResult> {
    const descriptor = confirmationRequiredDescriptorSchema.parse(input.descriptor);
    if (!hasMatchingWithdrawalBinding({ ...input, descriptor })) {
      await this.audit.record("authorization.confirmation.withdraw_rejected", {
        decisionId: descriptor.decisionId,
        reasonCode: "CONFIRMATION_BINDING_MISMATCH",
      });
      return { ok: false, reasonCode: "CONFIRMATION_BINDING_MISMATCH" };
    }
    const now = (input.now ?? new Date()).toISOString();
    const interruptId = createConfirmationInterruptId(descriptor);
    try {
      const result = await this.db.query<{ outcome: "withdrawn" | "expired" }>(
        `WITH target AS (
           SELECT approval_id, decision_id, task_id, step_id,
                  CASE WHEN expires_at <= $3 THEN 'expired' ELSE 'withdrawn' END AS outcome
           FROM authorization_confirmations
           WHERE approval_id = $1
             AND decision_id = $2
             AND status = 'pending'
             AND tenant_id = $4
             AND scope_id = $5
             AND scope_type = $6
             AND $7 = ANY(principal_ids)
           FOR UPDATE
         ), changed AS (
           UPDATE authorization_confirmations AS confirmations
           SET status = CASE WHEN target.outcome = 'expired' THEN 'expired' ELSE 'denied' END,
               consumed_at = $3,
               withdrawn_at = CASE WHEN target.outcome = 'withdrawn' THEN $3::timestamptz ELSE NULL END,
               withdrawn_by_principal_id = CASE WHEN target.outcome = 'withdrawn' THEN $7 ELSE NULL END
           FROM target
           WHERE confirmations.approval_id = target.approval_id
             AND confirmations.status = 'pending'
           RETURNING target.outcome, target.decision_id, target.task_id, target.step_id
         ), updated_decision AS (
           UPDATE permission_decisions
           SET effect = 'deny',
               reason_code = CASE WHEN changed.outcome = 'expired'
                 THEN 'CONFIRMATION_TIMEOUT' ELSE 'CONFIRMATION_CANCELLED' END
           FROM changed
           WHERE permission_decisions.decision_id = changed.decision_id
         ), updated_task AS (
           UPDATE agent_tasks SET status = 'cancelled', updated_at = $3
           WHERE task_id IN (SELECT task_id FROM changed)
         ), updated_step AS (
           UPDATE task_steps SET status = 'cancelled', updated_at = $3
           WHERE step_id IN (SELECT step_id FROM changed WHERE step_id IS NOT NULL)
         ), updated_manifest AS (
           UPDATE interrupt_manifests
           SET status = CASE WHEN changed.outcome = 'expired' THEN 'expired' ELSE 'superseded' END,
               manifest = jsonb_set(
                 jsonb_set(
                   manifest,
                   '{status}',
                   to_jsonb(CASE WHEN changed.outcome = 'expired' THEN 'expired' ELSE 'superseded' END)
                 ),
                 '{updatedAt}', to_jsonb($9::text)
               ),
               updated_at = $3
           FROM changed
           WHERE interrupt_manifests.interrupt_id = $8
             AND interrupt_manifests.status = 'waiting'
         )
         SELECT outcome FROM changed`,
        [
          descriptor.approvalId,
          descriptor.decisionId,
          now,
          descriptor.scope.tenantId,
          descriptor.scope.scopeId,
          descriptor.scope.scopeType,
          input.executionContext.principal.principalId,
          interruptId,
          now,
        ]
      );
      const changed = result.rows[0];
      if (changed) {
        await this.audit.record("authorization.confirmation.withdrawn", {
          decisionId: descriptor.decisionId,
          status: changed.outcome,
        });
        return { ok: true, status: changed.outcome };
      }
      const current = await this.findStatus({
        approvalId: descriptor.approvalId,
        decisionId: descriptor.decisionId,
      });
      if (current?.withdrawn) return { ok: true, status: "withdrawn" };
      if (current?.status === "expired") return { ok: true, status: "expired" };
      if (current === null) {
        return { ok: false, reasonCode: "CONFIRMATION_BINDING_MISMATCH" };
      }
      return { ok: false, reasonCode: "CONFIRMATION_ALREADY_DECIDED" };
    } catch {
      await this.audit.record("authorization.confirmation.withdraw_rejected", {
        decisionId: descriptor.decisionId,
        reasonCode: "CONFIRMATION_WITHDRAW_FAILED",
      });
      return { ok: false, reasonCode: "CONFIRMATION_WITHDRAW_FAILED" };
    }
  }

  async findStatus(input: {
    approvalId: string;
    decisionId: string;
  }): Promise<ConfirmationStatusSnapshot | null> {
    const result = await this.db.query<{
      status: string;
      withdrawn_at: unknown;
      expires_at: unknown;
    }>(
      `SELECT status, withdrawn_at, expires_at
       FROM authorization_confirmations
       WHERE approval_id = $1 AND decision_id = $2`,
      [input.approvalId, input.decisionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!isConfirmationStatus(row.status)) {
      throw new Error(`Unknown authorization confirmation status: ${row.status}`);
    }
    return {
      status: row.status,
      withdrawn: row.withdrawn_at !== null && row.withdrawn_at !== undefined,
      expiresAt: toIsoString(row.expires_at),
    };
  }
}
