import { describe, expect, it } from "vitest";

import {
  DATA_INVENTORY_SCHEMA_VERSION,
  type DataInventoryEntry,
  type SubjectDataRequest,
} from "./contracts.js";
import {
  GovernedStoreAdapter,
  createInMemoryGovernedStoreDriver,
  registerBackendGovernedStores,
} from "./governed-store.js";
import { DataInventoryRegistry, createDefaultInventoryEntries } from "./registry.js";

const request: SubjectDataRequest = {
  schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
  workflowId: "workflow_01",
  subject: {
    accountId: "acct_01",
    tenantId: "tenant_01",
    principalId: "principal_01",
  },
  deadline: "2026-10-01T00:00:00.000Z",
};

function entry(overrides: Partial<DataInventoryEntry> = {}): DataInventoryEntry {
  const base = createDefaultInventoryEntries().find(
    (candidate) => candidate.dataClassId === "runtime.tasks",
  );
  if (!base) throw new Error("runtime.tasks fixture missing");
  return { ...base, ...overrides };
}

describe("GovernedStoreAdapter", () => {
  it("exports, deletes, and verifies only the requested subject", async () => {
    const driver = createInMemoryGovernedStoreDriver([
      {
        dataClassId: "runtime.tasks",
        subject: request.subject,
        recordId: "record_01",
        value: { title: "owned" },
      },
      {
        dataClassId: "runtime.tasks",
        subject: {
          accountId: "acct_02",
          tenantId: "tenant_01",
          principalId: "principal_02",
        },
        recordId: "record_02",
        value: { title: "other user" },
      },
      {
        dataClassId: "runtime.tasks",
        subject: {
          accountId: "acct_03",
          tenantId: "tenant_02",
          principalId: "principal_03",
        },
        recordId: "record_03",
        value: { title: "other tenant" },
      },
    ]);
    const store = new GovernedStoreAdapter(entry(), driver);

    await expect(store.exportSubjectData(request)).resolves.toEqual({
      status: "completed",
      storeId: "runtime.tasks",
      records: [{ recordId: "record_01", title: "owned" }],
    });
    await expect(store.deleteSubjectData(request)).resolves.toEqual({
      status: "completed",
      storeId: "runtime.tasks",
      affectedRecords: 1,
    });
    await expect(
      store.verifySubjectDeletion({ ...request, receiptId: "receipt_01" }),
    ).resolves.toMatchObject({ status: "verified", storeId: "runtime.tasks" });

    expect(driver.snapshot()).toEqual([
      expect.objectContaining({ recordId: "record_02" }),
      expect.objectContaining({ recordId: "record_03" }),
    ]);
  });

  it("makes deletion idempotent for the same workflow and subject", async () => {
    const driver = createInMemoryGovernedStoreDriver([
      {
        dataClassId: "runtime.tasks",
        subject: request.subject,
        recordId: "record_01",
        value: {},
      },
    ]);
    const store = new GovernedStoreAdapter(entry(), driver);

    const first = await store.deleteSubjectData(request);
    const second = await store.deleteSubjectData(request);

    expect(first).toEqual(second);
    expect(driver.deleteCount()).toBe(1);
  });

  it("returns typed policy and failure results", async () => {
    const driver = createInMemoryGovernedStoreDriver();
    const retainedStore = new GovernedStoreAdapter(
      entry({
        dataClassId: "runtime.audit",
        exportBehavior: "excluded",
        deletionBehavior: "retain_minimum_audit",
        legalAuditException: {
          policyId: "minimum-audit-evidence",
          reasonCode: "LEGAL_AUDIT_MINIMUM",
          identifierMinimized: true,
        },
      }),
      driver,
    );

    await expect(retainedStore.exportSubjectData(request)).resolves.toEqual({
      status: "skipped",
      storeId: "runtime.audit",
      reasonCode: "EXPORT_EXCLUDED_BY_POLICY",
    });
    await expect(retainedStore.deleteSubjectData(request)).resolves.toMatchObject({
      status: "retained_by_policy",
      storeId: "runtime.audit",
      policyId: "minimum-audit-evidence",
    });

    const failingStore = new GovernedStoreAdapter(entry(), {
      exportBySubject: async () => {
        throw new Error("database unavailable");
      },
      deleteBySubject: async () => {
        throw new Error("database unavailable");
      },
      countBySubject: async () => {
        throw new Error("database unavailable");
      },
    });
    await expect(failingStore.exportSubjectData(request)).resolves.toEqual({
      status: "failed",
      storeId: "runtime.tasks",
      errorCode: "STORE_UNAVAILABLE",
      retryable: true,
    });
    await expect(failingStore.deleteSubjectData(request)).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    await expect(
      failingStore.verifySubjectDeletion({ ...request, receiptId: "receipt_01" }),
    ).resolves.toMatchObject({ status: "failed", retryable: true });
  });

  it("registers all backend governed data classes declaratively", () => {
    const registry = new DataInventoryRegistry();
    const entries = createDefaultInventoryEntries();
    registerBackendGovernedStores(
      registry,
      entries,
      createInMemoryGovernedStoreDriver(),
    );

    const registeredIds = new Set(registry.listStores().map((store) => store.id));
    expect(registeredIds).toEqual(
      new Set(
        entries
          .filter((candidate) => !candidate.dataClassId.startsWith("identity."))
          .map((candidate) => candidate.dataClassId),
      ),
    );
  });
});
