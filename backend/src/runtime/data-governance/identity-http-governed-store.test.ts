import { describe, expect, it, vi } from "vitest";

import { DATA_INVENTORY_SCHEMA_VERSION, type SubjectDataRequest } from "./contracts.js";
import { HttpIdentityGovernedStore } from "./identity-http-governed-store.js";
import { createDefaultInventoryEntries } from "./registry.js";

const request: SubjectDataRequest = {
  schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
  workflowId: "workflow_01",
  subject: { accountId: "account_01", tenantId: "tenant_01", principalId: "principal_01" },
  deadline: "2026-10-01T00:00:00.000Z",
};

describe("HttpIdentityGovernedStore", () => {
  it("uses the authenticated internal boundary and passes idempotency", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({ status: "completed", storeId: "identity.lifecycle", affectedRecords: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const entry = createDefaultInventoryEntries().find((candidate) => candidate.dataClassId === "identity.accounts");
    if (!entry) throw new Error("identity fixture missing");
    const store = new HttpIdentityGovernedStore(entry, {
      baseUrl: new URL("http://bff.internal"),
      serviceToken: "service-token-at-least-sixteen",
      timeoutMs: 100,
      fetcher,
    });
    await expect(store.deleteSubjectData(request)).resolves.toEqual({
      status: "completed",
      storeId: "identity.accounts",
      affectedRecords: 1,
    });
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-internal-service-token")).toBe(
      "service-token-at-least-sixteen",
    );
    expect(String(init?.body)).toContain('"idempotencyKey":"workflow_01"');
  });

  it("returns typed retryable failure and opens its circuit", async () => {
    const fetcher = vi.fn(async () => { throw new Error("unavailable"); });
    const entry = createDefaultInventoryEntries().find((candidate) => candidate.dataClassId === "identity.accounts");
    if (!entry) throw new Error("identity fixture missing");
    const store = new HttpIdentityGovernedStore(entry, {
      baseUrl: new URL("http://bff.internal"),
      serviceToken: "service-token-at-least-sixteen",
      timeoutMs: 100,
      failureThreshold: 1,
      fetcher,
      now: () => 100,
    });
    await expect(store.exportSubjectData(request)).resolves.toMatchObject({
      status: "failed",
      errorCode: "STORE_UNAVAILABLE",
      retryable: true,
    });
    await store.exportSubjectData(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves terminal access denial without opening the circuit", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "CROSS_TENANT_DENIED",
        message: "internal detail must not cross the boundary",
      },
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));
    const entry = createDefaultInventoryEntries().find(
      (candidate) => candidate.dataClassId === "identity.accounts",
    );
    if (!entry) throw new Error("identity fixture missing");
    const store = new HttpIdentityGovernedStore(entry, {
      baseUrl: new URL("http://bff.internal"),
      serviceToken: "service-token-at-least-sixteen",
      timeoutMs: 100,
      failureThreshold: 1,
      fetcher,
      now: () => 100,
    });

    await expect(store.deleteSubjectData(request)).resolves.toEqual({
      status: "failed",
      storeId: "identity.accounts",
      errorCode: "CROSS_TENANT_DENIED",
      retryable: false,
    });
    await store.deleteSubjectData(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
