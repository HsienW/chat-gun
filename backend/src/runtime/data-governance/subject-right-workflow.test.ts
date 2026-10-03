import { describe, expect, it, vi } from "vitest";

import type {
  DataInventoryEntry,
  ExportPartResult,
  GovernedDataStore,
  SubjectDataRequest,
} from "./contracts.js";
import {
  DATA_INVENTORY_SCHEMA_VERSION,
  RETENTION_POLICY_SCHEMA_VERSION,
} from "./contracts.js";
import { DataInventoryRegistry } from "./registry.js";
import {
  SubjectRightWorkflowError,
  SubjectRightWorkflowService,
  createInMemorySubjectRightWorkflowRepository,
} from "./subject-right-workflow.js";

const subject = {
  accountId: "acct_01",
  tenantId: "tenant_01",
  principalId: "principal_01",
};

const request: SubjectDataRequest = {
  schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
  workflowId: "workflow_01",
  subject,
  deadline: "2026-10-01T00:00:00.000Z",
};

function createEntry(id: string): DataInventoryEntry {
  return {
    schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
    dataClassId: id,
    authoritativeStore: `memory.${id}`,
    ownerSubject: ["accountId", "tenantId", "principalId"],
    subjectKey: { tier: "direct", key: "accountId" },
    purpose: "workflow test",
    sensitivity: "confidential",
    retentionPolicy: {
      schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
      policyId: "default",
      version: 1,
      durationDays: 30,
      expiryAction: "delete",
    },
    exportBehavior: "subject_only",
    deletionBehavior: "delete",
    legalAuditException: null,
    derivedCopiesCaches: [],
  };
}

function createStore(
  id: string,
  options: { failDeletionOnce?: boolean; failExportOnce?: boolean } = {},
): GovernedDataStore & {
  deleteSubjectData: ReturnType<typeof vi.fn>;
  exportSubjectData: ReturnType<typeof vi.fn>;
} {
  let deletionAttempts = 0;
  let exportAttempts = 0;
  return {
    id,
    subjectKey: { tier: "direct", key: "accountId" },
    exportSubjectData: vi.fn(async (): Promise<ExportPartResult> => {
      exportAttempts += 1;
      return options.failExportOnce && exportAttempts === 1
        ? { status: "failed", storeId: id, errorCode: "STORE_UNAVAILABLE", retryable: true }
        : { status: "completed", storeId: id, records: [{ recordId: `${id}_record` }] };
    }),
    deleteSubjectData: vi.fn(async () => {
      deletionAttempts += 1;
      return options.failDeletionOnce && deletionAttempts === 1
        ? { status: "failed" as const, storeId: id, errorCode: "STORE_UNAVAILABLE", retryable: true }
        : { status: "completed" as const, storeId: id, affectedRecords: 1 };
    }),
    verifySubjectDeletion: async () => ({
      status: "verified",
      storeId: id,
      evidenceRef: `verification:${id}`,
    }),
  };
}

describe("SubjectRightWorkflowService", () => {
  it("resumes deletion without reprocessing completed stores and persists verification", async () => {
    const registry = new DataInventoryRegistry();
    const completed = createStore("store.completed");
    const retryable = createStore("store.retryable", { failDeletionOnce: true });
    registry.register(createEntry(completed.id), completed);
    registry.register(createEntry(retryable.id), retryable);
    const repository = createInMemorySubjectRightWorkflowRepository();
    const service = new SubjectRightWorkflowService(registry, repository, {
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });

    await service.requestDeletion(request, subject);
    await expect(service.runDeletion(request.workflowId, subject)).resolves.toMatchObject({
      status: "failed",
      retryableStoreIds: ["store.retryable"],
    });
    await expect(service.runDeletion(request.workflowId, subject)).resolves.toMatchObject({
      status: "completed",
      retryableStoreIds: [],
    });
    expect(completed.deleteSubjectData).toHaveBeenCalledTimes(1);
    expect(retryable.deleteSubjectData).toHaveBeenCalledTimes(2);

    const receipt = await service.verifyDeletion(request.workflowId, subject);
    expect(receipt.verification).toHaveLength(2);
    expect(receipt.status).toBe("completed");
  });

  it("retries only failed export parts and rejects expired export access safely", async () => {
    let now = new Date("2026-09-30T00:00:00.000Z");
    const registry = new DataInventoryRegistry();
    const completed = createStore("store.completed");
    const retryable = createStore("store.retryable", { failExportOnce: true });
    registry.register(createEntry(completed.id), completed);
    registry.register(createEntry(retryable.id), retryable);
    const service = new SubjectRightWorkflowService(
      registry,
      createInMemorySubjectRightWorkflowRepository(),
      { now: () => now },
    );

    await service.requestExport(request, subject);
    await expect(service.runExport(request.workflowId, subject)).resolves.toMatchObject({
      status: "failed",
      retryableStoreIds: ["store.retryable"],
    });
    await expect(service.runExport(request.workflowId, subject)).resolves.toMatchObject({
      status: "completed",
      retryableStoreIds: [],
    });
    expect(completed.exportSubjectData).toHaveBeenCalledTimes(1);
    expect(retryable.exportSubjectData).toHaveBeenCalledTimes(2);
    await expect(service.getExport(request.workflowId, subject)).resolves.toHaveLength(2);

    now = new Date("2026-10-02T00:00:00.000Z");
    await expect(service.getExport(request.workflowId, subject)).rejects.toEqual(
      expect.objectContaining<Partial<SubjectRightWorkflowError>>({
        code: "EXPORT_LINK_EXPIRED",
      }),
    );
  });
});
