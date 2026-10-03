import { describe, expect, it } from "vitest";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  DATA_INVENTORY_SCHEMA_VERSION,
  RETENTION_POLICY_SCHEMA_VERSION,
  TOMBSTONE_SCHEMA_VERSION,
  consentRecordSchema,
  dataInventoryEntrySchema,
  deletionPartResultSchema,
  subjectCorrelationRecordSchema,
  subjectDataRequestSchema,
  tombstoneSchema,
  validateDataInventoryEntry,
  validateRetentionPolicy,
} from "./contracts.js";

const validInventoryEntry = {
  schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
  dataClassId: "runtime.tasks",
  authoritativeStore: "postgres.agent_tasks",
  ownerSubject: ["accountId", "tenantId", "principalId"],
  subjectKey: {
    tier: "correlation" as const,
    key: "taskId" as const,
  },
  purpose: "durable runtime task execution",
  sensitivity: "confidential" as const,
  retentionPolicy: {
    schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
    policyId: "runtime-default",
    version: 1,
    durationDays: 30,
    expiryAction: "delete" as const,
  },
  exportBehavior: "subject_only" as const,
  deletionBehavior: "delete" as const,
  legalAuditException: null,
  derivedCopiesCaches: [
    {
      id: "runtime-task-cache",
      kind: "cache" as const,
      rebuildable: true,
      clearable: true,
      authoritative: false,
    },
  ],
};

describe("data-governance contracts", () => {
  it("accepts a complete, versioned inventory entry", () => {
    expect(dataInventoryEntrySchema.parse(validInventoryEntry)).toEqual(
      validInventoryEntry,
    );
  });

  it.each([
    ["unknown schema version", { ...validInventoryEntry, schemaVersion: "99.0.0" }],
    ["unknown sensitivity", { ...validInventoryEntry, sensitivity: "future-secret" }],
    [
      "unknown retention action",
      {
        ...validInventoryEntry,
        retentionPolicy: {
          ...validInventoryEntry.retentionPolicy,
          expiryAction: "archive-forever",
        },
      },
    ],
  ])("fails closed for %s", (_label, input) => {
    expect(() => validateDataInventoryEntry(input)).toThrowError(
      /DATA_GOVERNANCE_VALIDATION_FAILED/,
    );
  });

  it("rejects inventory entries without an owner or deletion behavior", () => {
    const { ownerSubject: _ownerSubject, ...withoutOwner } = validInventoryEntry;
    const { deletionBehavior: _deletionBehavior, ...withoutDeletion } =
      validInventoryEntry;

    expect(() => validateDataInventoryEntry(withoutOwner)).toThrowError(
      /DATA_GOVERNANCE_VALIDATION_FAILED/,
    );
    expect(() => validateDataInventoryEntry(withoutDeletion)).toThrowError(
      /DATA_GOVERNANCE_VALIDATION_FAILED/,
    );
  });

  it("accepts only opaque, server-authoritative subject identifiers", () => {
    const valid = {
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      workflowId: "workflow_01",
      subject: {
        accountId: "acct_01",
        tenantId: "tenant_01",
        principalId: "principal_01",
      },
      deadline: "2026-10-01T00:00:00.000Z",
    };

    expect(subjectDataRequestSchema.parse(valid)).toEqual(valid);
    expect(
      subjectDataRequestSchema.safeParse({
        ...valid,
        subject: { ...valid.subject, email: "person@example.test" },
      }).success,
    ).toBe(false);
    expect(
      subjectDataRequestSchema.safeParse({
        ...valid,
        subject: { ...valid.subject, accountId: "person@example.test" },
      }).success,
    ).toBe(false);
    expect(
      subjectDataRequestSchema.safeParse({ ...valid, clientAccountId: "acct_02" })
        .success,
    ).toBe(false);
  });

  it.each([
    { status: "completed", storeId: "runtime.tasks", affectedRecords: 2 },
    { status: "skipped", storeId: "runtime.cache", reasonCode: "NO_DATA" },
    {
      status: "retained_by_policy",
      storeId: "runtime.audit",
      policyId: "minimum-audit",
      evidenceRef: "audit:opaque:01",
    },
    {
      status: "failed",
      storeId: "runtime.memory",
      errorCode: "STORE_UNAVAILABLE",
      retryable: true,
    },
  ])("validates deletion result $status", (result) => {
    expect(deletionPartResultSchema.parse(result)).toEqual(result);
  });

  it("validates versioned consent, tombstone, and correlation records", () => {
    const consent = {
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      consentId: "consent_01",
      accountId: "acct_01",
      policyVersion: 1,
      status: "granted",
      scope: "personalization",
      recordedAt: "2026-09-30T00:00:00.000Z",
    };
    const tombstone = {
      schemaVersion: TOMBSTONE_SCHEMA_VERSION,
      subjectIdHash: "a".repeat(64),
      objectIdHash: "b".repeat(64),
      deletedAt: "2026-09-30T00:00:00.000Z",
      tombstoneVersion: 1,
      deletionReason: "subject_request",
    };
    const correlation = {
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      correlationKey: "task:task_01",
      accountId: "acct_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
      recordedAt: "2026-09-30T00:00:00.000Z",
    };

    expect(consentRecordSchema.parse(consent)).toEqual(consent);
    expect(tombstoneSchema.parse(tombstone)).toEqual(tombstone);
    expect(subjectCorrelationRecordSchema.parse(correlation)).toEqual(correlation);
  });

  it("fails closed for an unknown retention policy version", () => {
    expect(() =>
      validateRetentionPolicy({
        ...validInventoryEntry.retentionPolicy,
        schemaVersion: "2.0.0",
      }),
    ).toThrowError(/DATA_GOVERNANCE_VALIDATION_FAILED/);
  });
});
