import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  DataInventoryEntry,
  GovernedDataStore,
} from "./contracts.js";
import {
  DATA_INVENTORY_SCHEMA_VERSION,
  RETENTION_POLICY_SCHEMA_VERSION,
} from "./contracts.js";
import {
  DataInventoryRegistry,
  assertInventoryCompleteness,
  createDefaultInventoryEntries,
} from "./registry.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const backendMigrationDirectory = resolve(
  currentDirectory,
  "../persistence/migrations",
);
const bffIdentityMigration = resolve(
  currentDirectory,
  "../../../../bff/src/migrations/001_consumer_identity.up.sql",
);

async function readDeclaredTables(): Promise<string[]> {
  const migrationNames = (await readdir(backendMigrationDirectory)).filter((name) =>
    name.endsWith(".sql"),
  );
  const sqlFiles = await Promise.all([
    ...migrationNames.map((name) =>
      readFile(join(backendMigrationDirectory, name), "utf8"),
    ),
    readFile(bffIdentityMigration, "utf8"),
  ]);
  return sqlFiles.flatMap((sql) =>
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/giu)].map(
      (match) => match[1] ?? "",
    ),
  );
}

function createEntry(
  dataClassId: string,
  authoritativeStore: string,
): DataInventoryEntry {
  return {
    schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
    dataClassId,
    authoritativeStore,
    ownerSubject: ["accountId", "tenantId", "principalId"],
    subjectKey: { tier: "direct", key: "accountId" },
    purpose: "test store",
    sensitivity: "confidential",
    retentionPolicy: {
      schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
      policyId: "test-default",
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
  subjectKey: GovernedDataStore["subjectKey"] = {
    tier: "direct",
    key: "accountId",
  },
): GovernedDataStore {
  return {
    id,
    subjectKey,
    exportSubjectData: async () => ({ status: "completed", storeId: id, records: [] }),
    deleteSubjectData: async () => ({
      status: "completed",
      storeId: id,
      affectedRecords: 0,
    }),
    verifySubjectDeletion: async () => ({
      status: "verified",
      storeId: id,
      evidenceRef: `verify:${id}`,
    }),
  };
}

describe("DataInventoryRegistry", () => {
  it("discovers stores through declarative registration", () => {
    const registry = new DataInventoryRegistry();
    const entry = createEntry("test.records", "memory.test_records");
    const store = createStore(entry.dataClassId);

    registry.register(entry, store);

    expect(registry.listEntries()).toEqual([entry]);
    expect(registry.listStores()).toEqual([store]);
  });

  it("fails closed for duplicate entries and store ID mismatch", () => {
    const registry = new DataInventoryRegistry();
    const entry = createEntry("test.records", "memory.test_records");
    registry.register(entry, createStore(entry.dataClassId));

    expect(() => registry.register(entry, createStore(entry.dataClassId))).toThrowError(
      /DATA_CLASS_ALREADY_REGISTERED/,
    );
    expect(() =>
      new DataInventoryRegistry().register(entry, createStore("other.records")),
    ).toThrowError(/GOVERNED_STORE_ID_MISMATCH/);
  });

  it("covers every backend and BFF migration table with a subject-reachable entry", async () => {
    const declaredTables = await readDeclaredTables();
    const registry = new DataInventoryRegistry();
    for (const entry of createDefaultInventoryEntries()) {
      registry.register(entry, createStore(entry.dataClassId, entry.subjectKey));
    }

    const report = assertInventoryCompleteness(
      registry,
      declaredTables.map((table) => `postgres.${table}`),
    );

    expect(report.missingAuthoritativeStores).toEqual([]);
    expect(report.unreachableDataClassIds).toEqual([]);
    expect(declaredTables.length).toBeGreaterThanOrEqual(26);
  });

  it("reports unregistered and subject-unreachable stores as gaps", () => {
    const registry = new DataInventoryRegistry();
    const unreachableEntry: DataInventoryEntry = {
      ...createEntry("test.unreachable", "postgres.test_unreachable"),
      subjectKey: { tier: "exception", key: "taskId" },
      legalAuditException: null,
    };

    expect(() => registry.register(unreachableEntry, createStore(unreachableEntry.dataClassId)))
      .toThrowError(/DATA_GOVERNANCE_VALIDATION_FAILED/);

    const report = assertInventoryCompleteness(registry, [
      "postgres.test_unreachable",
    ]);
    expect(report.missingAuthoritativeStores).toEqual([
      "postgres.test_unreachable",
    ]);
  });

  it("does not expose or delete tenant-wide shared evidence as individual data", () => {
    const entries = createDefaultInventoryEntries();
    for (const dataClassId of [
      "runtime.business-effects",
      "runtime.decision-evidence",
      "runtime.context-references",
      "runtime.confirmations",
    ]) {
      const entry = entries.find((candidate) => candidate.dataClassId === dataClassId);
      expect(entry).toMatchObject({
        exportBehavior: "excluded",
        deletionBehavior: "retain_minimum_audit",
        legalAuditException: { identifierMinimized: true },
      });
    }
  });
});
