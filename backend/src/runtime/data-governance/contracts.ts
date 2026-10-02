import { z } from "zod";

import { opaqueIdentityIdSchema } from "../authorization/consumer-identity.js";

export const DATA_INVENTORY_SCHEMA_VERSION = "1.0.0" as const;
export const RETENTION_POLICY_SCHEMA_VERSION = "1.0.0" as const;
export const CONSENT_RECORD_SCHEMA_VERSION = "1.0.0" as const;
export const TOMBSTONE_SCHEMA_VERSION = "1.0.0" as const;
export const SUBJECT_RIGHT_WORKFLOW_SCHEMA_VERSION = "1.0.0" as const;

export const DATA_SENSITIVITY_VALUES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

export const OWNER_SUBJECT_VALUES = [
  "accountId",
  "tenantId",
  "principalId",
] as const;

export const SUBJECT_KEY_VALUES = [
  "accountId",
  "tenantId",
  "principalId",
  "taskId",
  "runId",
  "threadId",
  "stepId",
  "toolExecutionId",
  "memoryNamespace",
  "correlationKey",
  "workflowId",
  "subjectIdHash",
] as const;

export const RESOLUTION_TIER_VALUES = ["direct", "correlation", "exception"] as const;
export const EXPORT_BEHAVIOR_VALUES = ["subject_only", "excluded"] as const;
export const DELETION_BEHAVIOR_VALUES = [
  "delete",
  "clear_projection",
  "retain_minimum_audit",
  "tombstone",
] as const;
export const RETENTION_EXPIRY_ACTION_VALUES = [
  "delete",
  "anonymize",
  "retain_by_policy",
] as const;
export const CONSENT_STATUS_VALUES = ["granted", "withdrawn"] as const;
export const CONSENT_SCOPE_VALUES = [
  "personalization",
  "evaluation_contribution",
  "proactive_background_work",
] as const;
export const SUBJECT_RIGHT_WORKFLOW_TYPE_VALUES = [
  "export",
  "deletion",
  "deletion_verification",
  "retention_sweep",
  "consent",
] as const;
export const SUBJECT_RIGHT_WORKFLOW_STATUS_VALUES = [
  "requested",
  "in_progress",
  "completed",
  "failed",
  "expired",
] as const;
export const DELETION_RECEIPT_STATUS_VALUES = ["completed", "incomplete"] as const;

export const dataSensitivitySchema = z.enum(DATA_SENSITIVITY_VALUES);
export const ownerSubjectSchema = z.enum(OWNER_SUBJECT_VALUES);
export const resolutionTierSchema = z.enum(RESOLUTION_TIER_VALUES);
export const subjectKeyNameSchema = z.enum(SUBJECT_KEY_VALUES);
export const exportBehaviorSchema = z.enum(EXPORT_BEHAVIOR_VALUES);
export const deletionBehaviorSchema = z.enum(DELETION_BEHAVIOR_VALUES);
export const retentionExpiryActionSchema = z.enum(
  RETENTION_EXPIRY_ACTION_VALUES,
);

export const retentionPolicySchema = z
  .object({
    schemaVersion: z.literal(RETENTION_POLICY_SCHEMA_VERSION),
    policyId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    durationDays: z.number().int().nonnegative(),
    expiryAction: retentionExpiryActionSchema,
  })
  .strict();

export const subjectKeySchema = z
  .object({
    tier: resolutionTierSchema,
    key: subjectKeyNameSchema,
  })
  .strict()
  .superRefine((subjectKey, context) => {
    if (
      subjectKey.tier === "direct" &&
      !OWNER_SUBJECT_VALUES.some((key) => key === subjectKey.key)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "direct subject keys must use an owner subject column",
      });
    }
  });

export const derivedCopyCacheSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["cache", "projection", "backup"]),
    rebuildable: z.boolean(),
    clearable: z.boolean(),
    authoritative: z.literal(false),
  })
  .strict();

export const legalAuditExceptionSchema = z
  .object({
    policyId: z.string().min(1).max(128),
    reasonCode: z.string().min(1).max(128),
    identifierMinimized: z.literal(true),
  })
  .strict();

export const dataInventoryEntrySchema = z
  .object({
    schemaVersion: z.literal(DATA_INVENTORY_SCHEMA_VERSION),
    dataClassId: z.string().min(1).max(128),
    authoritativeStore: z.string().min(1).max(256),
    ownerSubject: z.array(ownerSubjectSchema).min(1),
    subjectKey: subjectKeySchema,
    purpose: z.string().min(1).max(512),
    sensitivity: dataSensitivitySchema,
    retentionPolicy: retentionPolicySchema,
    exportBehavior: exportBehaviorSchema,
    deletionBehavior: deletionBehaviorSchema,
    legalAuditException: legalAuditExceptionSchema.nullable(),
    derivedCopiesCaches: z.array(derivedCopyCacheSchema),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.subjectKey.tier === "exception" &&
      entry.legalAuditException === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exception-tier entries require a documented legal/audit exception",
      });
    }
  });

export const subjectIdentitySchema = z
  .object({
    accountId: opaqueIdentityIdSchema,
    tenantId: opaqueIdentityIdSchema,
    principalId: opaqueIdentityIdSchema,
  })
  .strict();

const subjectRequestFields = {
  schemaVersion: z.literal(DATA_INVENTORY_SCHEMA_VERSION),
  workflowId: opaqueIdentityIdSchema,
  subject: subjectIdentitySchema,
  deadline: z.string().datetime(),
  idempotencyKey: opaqueIdentityIdSchema.optional(),
} as const;

export const subjectDataRequestSchema = z.object(subjectRequestFields).strict();
export const subjectDeletionRequestSchema = z.object(subjectRequestFields).strict();
export const subjectDeletionVerificationSchema = z
  .object({
    ...subjectRequestFields,
    receiptId: opaqueIdentityIdSchema,
  })
  .strict();

export const exportPartResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    storeId: z.string().min(1),
    records: z.array(z.record(z.unknown())),
  }).strict(),
  z.object({
    status: z.literal("skipped"),
    storeId: z.string().min(1),
    reasonCode: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    storeId: z.string().min(1),
    errorCode: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
]);

export const deletionPartResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    storeId: z.string().min(1),
    affectedRecords: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("skipped"),
    storeId: z.string().min(1),
    reasonCode: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("retained_by_policy"),
    storeId: z.string().min(1),
    policyId: z.string().min(1),
    evidenceRef: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    storeId: z.string().min(1),
    errorCode: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
]);

export const verificationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    storeId: z.string().min(1),
    evidenceRef: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    storeId: z.string().min(1),
    errorCode: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
]);

export const consentRecordSchema = z
  .object({
    schemaVersion: z.literal(CONSENT_RECORD_SCHEMA_VERSION),
    consentId: opaqueIdentityIdSchema,
    accountId: opaqueIdentityIdSchema,
    policyVersion: z.number().int().positive(),
    status: z.enum(CONSENT_STATUS_VALUES),
    scope: z.enum(CONSENT_SCOPE_VALUES),
    recordedAt: z.string().datetime(),
  })
  .strict();

export const tombstoneSchema = z
  .object({
    schemaVersion: z.literal(TOMBSTONE_SCHEMA_VERSION),
    subjectIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    objectIdHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    deletedAt: z.string().datetime(),
    tombstoneVersion: z.number().int().positive(),
    deletionReason: z.string().min(1).max(128),
  })
  .strict();

export const subjectCorrelationRecordSchema = z
  .object({
    schemaVersion: z.literal(DATA_INVENTORY_SCHEMA_VERSION),
    correlationKey: z.string().min(1).max(256),
    accountId: opaqueIdentityIdSchema,
    tenantId: opaqueIdentityIdSchema,
    principalId: opaqueIdentityIdSchema,
    recordedAt: z.string().datetime(),
  })
  .strict();

export const subjectRightWorkflowSchema = z
  .object({
    schemaVersion: z.literal(SUBJECT_RIGHT_WORKFLOW_SCHEMA_VERSION),
    workflowId: opaqueIdentityIdSchema,
    type: z.enum(SUBJECT_RIGHT_WORKFLOW_TYPE_VALUES),
    subject: subjectIdentitySchema,
    status: z.enum(SUBJECT_RIGHT_WORKFLOW_STATUS_VALUES),
    deadline: z.string().datetime(),
    completedStoreIds: z.array(z.string().min(1)),
    retryableStoreIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const deletionReceiptSchema = z
  .object({
    schemaVersion: z.literal(DATA_INVENTORY_SCHEMA_VERSION),
    receiptId: opaqueIdentityIdSchema,
    workflowId: opaqueIdentityIdSchema,
    status: z.enum(DELETION_RECEIPT_STATUS_VALUES),
    parts: z.array(deletionPartResultSchema),
    verification: z.array(verificationResultSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DataInventoryEntry = z.infer<typeof dataInventoryEntrySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type SubjectIdentity = z.infer<typeof subjectIdentitySchema>;
export type SubjectDataRequest = z.infer<typeof subjectDataRequestSchema>;
export type SubjectDeletionRequest = z.infer<typeof subjectDeletionRequestSchema>;
export type SubjectDeletionVerification = z.infer<
  typeof subjectDeletionVerificationSchema
>;
export type ExportPartResult = z.infer<typeof exportPartResultSchema>;
export type DeletionPartResult = z.infer<typeof deletionPartResultSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
export type Tombstone = z.infer<typeof tombstoneSchema>;
export type SubjectCorrelationRecord = z.infer<
  typeof subjectCorrelationRecordSchema
>;
export type SubjectRightWorkflow = z.infer<typeof subjectRightWorkflowSchema>;
export type DeletionReceipt = z.infer<typeof deletionReceiptSchema>;

export interface GovernedDataStore {
  readonly id: string;
  readonly subjectKey: z.infer<typeof subjectKeySchema>;
  exportSubjectData(request: SubjectDataRequest): Promise<ExportPartResult>;
  deleteSubjectData(
    request: SubjectDeletionRequest,
  ): Promise<DeletionPartResult>;
  verifySubjectDeletion(
    request: SubjectDeletionVerification,
  ): Promise<VerificationResult>;
}

export class DataGovernanceValidationError extends Error {
  readonly code = "DATA_GOVERNANCE_VALIDATION_FAILED";

  constructor(readonly issues: readonly z.ZodIssue[]) {
    super(`DATA_GOVERNANCE_VALIDATION_FAILED: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "DataGovernanceValidationError";
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DataGovernanceValidationError(parsed.error.issues);
  }
  return parsed.data;
}

export function validateDataInventoryEntry(value: unknown): DataInventoryEntry {
  return parseOrThrow(dataInventoryEntrySchema, value);
}

export function validateRetentionPolicy(value: unknown): RetentionPolicy {
  return parseOrThrow(retentionPolicySchema, value);
}

export function validateConsentRecord(value: unknown): ConsentRecord {
  return parseOrThrow(consentRecordSchema, value);
}

export function validateTombstone(value: unknown): Tombstone {
  return parseOrThrow(tombstoneSchema, value);
}

export function validateSubjectDataRequest(value: unknown): SubjectDataRequest {
  return parseOrThrow(subjectDataRequestSchema, value);
}

export function validateSubjectDeletionRequest(
  value: unknown,
): SubjectDeletionRequest {
  return parseOrThrow(subjectDeletionRequestSchema, value);
}

export function validateSubjectDeletionVerification(
  value: unknown,
): SubjectDeletionVerification {
  return parseOrThrow(subjectDeletionVerificationSchema, value);
}
