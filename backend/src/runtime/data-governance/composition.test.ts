import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import { createDataGovernanceRuntime } from "./composition.js";
import { DATA_INVENTORY_SCHEMA_VERSION } from "./contracts.js";
import type { GovernedStoreDriver } from "./governed-store.js";

const driver: GovernedStoreDriver = {
  exportBySubject: async () => [],
  deleteBySubject: async () => 0,
  countBySubject: async () => 0,
};

const database = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
} as unknown as Queryable;

const identityHttp = {
  baseUrl: new URL("http://bff.internal"),
  serviceToken: "service-token-at-least-sixteen",
  timeoutMs: 100,
};

describe("data-governance composition", () => {
  it("registers missing external stores as unavailable without crashing or skipping", async () => {
    const runtime = createDataGovernanceRuntime({
      database,
      identityHttp,
      externalDrivers: new Map(),
      activeRecordTtlSeconds: 60,
      tombstoneTtlSeconds: 60,
    });
    expect(runtime.registry.listEntries()).toHaveLength(35);
    expect(runtime.registry.listStores()).toHaveLength(35);
    const memoryStore = runtime.registry
      .listStores()
      .find((store) => store.id === "memory.long-term");
    if (!memoryStore) throw new Error("memory governed store missing");
    await expect(memoryStore.exportSubjectData({
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      workflowId: "workflow_01",
      subject: {
        accountId: "account_01",
        tenantId: "tenant_01",
        principalId: "principal_01",
      },
      deadline: "2026-10-03T00:00:00.000Z",
    })).resolves.toEqual({
      status: "failed",
      storeId: "memory.long-term",
      errorCode: "STORE_UNAVAILABLE",
      retryable: true,
    });
  });

  it("registers every inventory entry through injected drivers", () => {
    const externalDrivers = new Map([
      ["memory.long-term", driver],
      ["runtime.checkpoints", driver],
      ["runtime.cache", driver],
      ["runtime.observability-projection", driver],
    ]);
    const runtime = createDataGovernanceRuntime({
      database,
      identityHttp,
      externalDrivers,
      activeRecordTtlSeconds: 60,
      tombstoneTtlSeconds: 120,
    });
    expect(runtime.registry.listEntries()).toHaveLength(35);
    expect(runtime.registry.listStores()).toHaveLength(35);
  });
});
