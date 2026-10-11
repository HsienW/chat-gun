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

export interface ConfirmationAuditSink {
  record(eventName: string, payload: Record<string, unknown>): Promise<void> | void;
}

const noopAuditSink: ConfirmationAuditSink = { record: () => undefined };

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
  implements AuthorizationConfirmationStore
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
}
