import { describe, expect, it, vi } from "vitest";

import type {
  DataInventoryEntry,
  DeletionPartResult,
  GovernedDataStore,
  SubjectDeletionRequest,
} from "./contracts.js";
import {
  DATA_INVENTORY_SCHEMA_VERSION,
  RETENTION_POLICY_SCHEMA_VERSION,
} from "./contracts.js";
import {
  DeletionCoordinator,
  SubjectRightsDeniedError,
} from "./deletion-coordinator.js";
import { DataInventoryRegistry } from "./registry.js";

const subject = {
  accountId: "acct_01",
  tenantId: "tenant_01",
  principalId: "principal_01",
};

const request: SubjectDeletionRequest = {
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
    purpose: "coordinator test",
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
  deletionResult: DeletionPartResult | Error,
): GovernedDataStore & { deleteSubjectData: ReturnType<typeof vi.fn> } {
  return {
    id,
    subjectKey: { tier: "direct", key: "accountId" },
    exportSubjectData: async () => ({ status: "completed", storeId: id, records: [] }),
    deleteSubjectData: vi.fn(async () => {
      if (deletionResult instanceof Error) throw deletionResult;
      return deletionResult;
    }),
    verifySubjectDeletion: async () => ({
      status: "verified",
      storeId: id,
      evidenceRef: `verify:${id}`,
    }),
  };
}

describe("DeletionCoordinator", () => {
  it("enumerates every registered store and preserves all four result categories", async () => {
    const registry = new DataInventoryRegistry();
    const stores = [
      createStore("store.completed", {
        status: "completed",
        storeId: "store.completed",
        affectedRecords: 2,
      }),
      createStore("store.skipped", {
        status: "skipped",
        storeId: "store.skipped",
        reasonCode: "NO_DATA",
      }),
      createStore("store.retained", {
        status: "retained_by_policy",
        storeId: "store.retained",
        policyId: "minimum-audit",
        evidenceRef: "audit:opaque:01",
      }),
      createStore("store.failed", {
        status: "failed",
        storeId: "store.failed",
        errorCode: "STORE_UNAVAILABLE",
        retryable: true,
      }),
      createStore("store.thrown", new Error("raw credential=do-not-leak")),
    ];
    for (const store of stores) registry.register(createEntry(store.id), store);
    const coordinator = new DeletionCoordinator(registry, {
      maxConcurrency: 2,
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });

    const receipt = await coordinator.delete(request, subject);

    expect(stores.every((store) => store.deleteSubjectData.mock.calls.length === 1))
      .toBe(true);
    expect(receipt.status).toBe("incomplete");
    expect(receipt.parts.map((part) => part.status)).toEqual([
      "completed",
      "skipped",
      "retained_by_policy",
      "failed",
      "failed",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(
      /credential|do-not-leak|person@example\.test/iu,
    );
  });

  it("denies cross-account and cross-tenant requests before enumerating stores", async () => {
    const registry = new DataInventoryRegistry();
    const store = createStore("store.completed", {
      status: "completed",
      storeId: "store.completed",
      affectedRecords: 1,
    });
    registry.register(createEntry(store.id), store);
    const coordinator = new DeletionCoordinator(registry);

    await expect(
      coordinator.delete(request, { ...subject, accountId: "acct_02" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubjectRightsDeniedError>>({
        code: "CROSS_ACCOUNT_DENIED",
      }),
    );
    await expect(
      coordinator.delete(request, { ...subject, tenantId: "tenant_02" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubjectRightsDeniedError>>({
        code: "CROSS_TENANT_DENIED",
      }),
    );
    expect(store.deleteSubjectData).not.toHaveBeenCalled();
  });
});
