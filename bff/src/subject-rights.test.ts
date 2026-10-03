import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "./identity-postgres.js";

import {
  HttpSubjectRightsBackendClient,
  IdentityGovernedStoreAdapter,
  PgIdentityGovernanceStore,
  SubjectRightsBoundaryError,
  executeIdentityGovernedStoreRoute,
  executeSubjectRightRoute,
  projectDeletionReceipt,
  type SubjectRightsBackendPort,
} from "./subject-rights.js";

const principal = {
  principalId: "principal_01",
  principalType: "user" as const,
  principalKind: "authenticated" as const,
  tenantId: "tenant_01",
  accountId: "account_01",
  sessionId: "session_01",
  roles: [],
  scopes: [],
  authSource: "oidc" as const,
  authenticatedAt: "2026-09-30T00:00:00.000Z",
};

function backend(): SubjectRightsBackendPort {
  const projection = {
    schemaVersion: "1.0.0" as const,
    workflowId: "workflow_01",
    type: "export" as const,
    status: "requested" as const,
  };
  return {
    requestExport: vi.fn(async () => projection),
    requestDeletion: vi.fn(async () => ({ ...projection, type: "deletion" as const })),
    recordConsent: vi.fn(async () => ({ ...projection, type: "consent" as const })),
    getWorkflow: vi.fn(async () => projection),
  };
}

describe("subject-right boundary", () => {
  it("derives the subject from the authenticated principal", async () => {
    const service = backend();
    const result = await executeSubjectRightRoute({
      method: "POST",
      pathname: "/api/subject-rights/export",
      body: { workflowId: "workflow_01", idempotencyKey: "idem_01" },
      principal,
      backend: service,
    });
    expect(result.status).toBe(202);
    expect(service.requestExport).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: {
          accountId: "account_01",
          tenantId: "tenant_01",
          principalId: "principal_01",
        },
      }),
    );
  });

  it("rejects client-controlled subject fields before calling downstream", async () => {
    const service = backend();
    const result = await executeSubjectRightRoute({
      method: "POST",
      pathname: "/api/subject-rights/deletion",
      body: {
        workflowId: "workflow_01",
        idempotencyKey: "idem_01",
        tenantId: "other_tenant",
      },
      principal,
      backend: service,
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: "CLIENT_SUBJECT_NOT_ALLOWED" } },
    });
    expect(service.requestDeletion).not.toHaveBeenCalled();
  });
});

describe("IdentityGovernedStoreAdapter", () => {
  it("exports, deletes idempotently, and verifies by exact subject", async () => {
    const store = {
      exportIdentity: vi.fn(async () => [{ accountId: "account_01" }]),
      deleteIdentity: vi.fn(async () => 3),
      countIdentity: vi.fn(async () => 0),
    };
    const adapter = new IdentityGovernedStoreAdapter(store);
    const subject = {
      accountId: "account_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
    };
    await expect(adapter.exportSubjectData(subject)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(adapter.deleteSubjectData(subject, "idem_01")).resolves.toEqual({
      status: "completed",
      storeId: "identity.lifecycle",
      affectedRecords: 3,
    });
    await expect(adapter.verifySubjectDeletion(subject)).resolves.toEqual({
      status: "verified",
      storeId: "identity.lifecycle",
    });
    expect(store.deleteIdentity).toHaveBeenCalledWith(subject, "idem_01");
  });

  it("preserves typed access denial at the internal HTTP boundary", async () => {
    const adapter = new IdentityGovernedStoreAdapter({
      exportIdentity: async () => {
        throw new SubjectRightsBoundaryError(
          "CROSS_TENANT_DENIED",
          403,
          "internal detail must not cross the boundary",
        );
      },
      deleteIdentity: async () => 0,
      countIdentity: async () => 0,
    });
    const result = await executeIdentityGovernedStoreRoute({
      serviceToken: "service-token-at-least-sixteen",
      expectedServiceToken: "service-token-at-least-sixteen",
      body: {
        operation: "export",
        subject: {
          accountId: "account_01",
          tenantId: "tenant_02",
          principalId: "principal_01",
        },
      },
      adapter,
    });
    expect(result).toEqual({
      status: 403,
      body: {
        error: {
          code: "CROSS_TENANT_DENIED",
          message: "Subject-right access denied",
        },
      },
    });
  });
});

it("projects only non-sensitive receipt fields", () => {
  const projection = projectDeletionReceipt({
    schemaVersion: "1.0.0",
    workflowId: "workflow_01",
    type: "deletion",
    status: "failed",
    receipt: {
      status: "incomplete",
      parts: [
        {
          storeId: "identity.lifecycle",
          status: "failed",
          reasonCode: "STORE_UNAVAILABLE",
          retryable: true,
        },
      ],
    },
  });
  expect(JSON.stringify(projection)).not.toMatch(/token|credential|email/iu);
});

it("opens the backend circuit after bounded failures", async () => {
  const fetcher = vi.fn(async () => {
    throw new Error("network unavailable");
  });
  const client = new HttpSubjectRightsBackendClient({
    baseUrl: new URL("http://backend.invalid"),
    serviceToken: "service-token-at-least-sixteen",
    timeoutMs: 100,
    failureThreshold: 2,
    cooldownMs: 1_000,
    fetcher,
    now: () => 100,
  });
  const request = {
    workflowId: "workflow_01",
    subject: {
      accountId: "account_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
    },
    deadline: "2026-10-01T00:00:00.000Z",
    idempotencyKey: "idem_01",
  };
  await expect(client.requestDeletion(request)).rejects.toMatchObject({
    code: "STORE_UNAVAILABLE",
  });
  await expect(client.requestDeletion(request)).rejects.toMatchObject({
    code: "STORE_UNAVAILABLE",
  });
  await expect(client.requestDeletion(request)).rejects.toMatchObject({
    code: "STORE_UNAVAILABLE",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves safe typed backend failures without opening the circuit", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    error: {
      code: "WORKFLOW_NOT_FOUND",
      message: "internal detail must not cross the boundary",
    },
  }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }));
  const client = new HttpSubjectRightsBackendClient({
    baseUrl: new URL("http://backend.invalid"),
    serviceToken: "backend-token-at-least-sixteen",
    timeoutMs: 100,
    failureThreshold: 1,
    cooldownMs: 1_000,
    fetcher,
    now: () => 100,
  });

  await expect(client.getWorkflow("missing_workflow", {
    accountId: "account_01",
    tenantId: "tenant_01",
    principalId: "principal_01",
  })).rejects.toMatchObject({
    code: "WORKFLOW_NOT_FOUND",
    status: 404,
    message: "Subject-right workflow was not found",
  });
  await expect(client.getWorkflow("missing_workflow", {
    accountId: "account_01",
    tenantId: "tenant_01",
    principalId: "principal_01",
  })).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses exact subject filters and excludes credentials from identity export", async () => {
  const queries: string[] = [];
  const database: PgQueryable = {
    async query<T extends Record<string, unknown>>(text: string) {
      queries.push(text);
      return {
        rows: [{
          account_id: "account_01",
          user_id: "user_01",
          tenant_id: "tenant_01",
          status: "active",
        }] as unknown as T[],
      };
    },
  };
  const store = new PgIdentityGovernanceStore(database);
  const records = await store.exportIdentity({
    accountId: "account_01",
    tenantId: "tenant_01",
    principalId: "principal_01",
  });
  expect(queries[0]).toContain("s.principal_id = $3");
  expect(JSON.stringify(records)).not.toMatch(/credential|session_id|token/iu);
});

it("authenticates the internal identity adapter before deletion", async () => {
  const deleteIdentity = vi.fn(async () => 1);
  const adapter = new IdentityGovernedStoreAdapter({
    exportIdentity: async () => [],
    deleteIdentity,
    countIdentity: async () => 0,
  });
  const body = {
    operation: "delete",
    idempotencyKey: "idem_01",
    subject: { accountId: "account_01", tenantId: "tenant_01", principalId: "principal_01" },
  };
  const denied = await executeIdentityGovernedStoreRoute({
    serviceToken: "wrong-token-long-enough",
    expectedServiceToken: "service-token-at-least-sixteen",
    body,
    adapter,
  });
  expect(denied.status).toBe(401);
  expect(deleteIdentity).not.toHaveBeenCalled();
});
