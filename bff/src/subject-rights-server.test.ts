import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";
import { createServer, type ServerDependencies } from "./server.js";
import { IdentityGovernedStoreAdapter } from "./subject-rights.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }));
});

async function start(dependencies: ServerDependencies) {
  const config = {
    ...loadConfig(),
    port: 0,
    allowedOrigins: [],
    requireAuth: true,
    rateLimitMaxRequests: 100,
    subjectRightsBackendToken: "backend-token-at-least-sixteen",
    identityGovernanceServiceToken: "identity-token-at-least-sixteen",
  };
  const server = createServer(config, dependencies);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const principalResolver: NonNullable<ServerDependencies["principalResolver"]> = {
  resolve: () => ({
    ok: true,
    principal: {
      principalId: "principal_01",
      principalType: "user",
      principalKind: "authenticated",
      tenantId: "tenant_01",
      accountId: "account_01",
      sessionId: "session_01",
      roles: [],
      scopes: [],
      authSource: "oidc",
      authenticatedAt: "2026-09-30T00:00:00.000Z",
    },
    activeScope: { scopeId: "tenant_01", scopeType: "tenant" },
  }),
};

describe("subject-right HTTP integration", () => {
  it("rejects client subject fields before the backend and accepts server-derived subject", async () => {
    const requestExport = vi.fn(async (input) => ({
      schemaVersion: "1.0.0" as const,
      workflowId: input.workflowId,
      type: "export" as const,
      status: "completed" as const,
    }));
    const backend = {
      requestExport,
      requestDeletion: vi.fn(),
      recordConsent: vi.fn(),
      getWorkflow: vi.fn(),
    };
    const url = await start({ principalResolver, subjectRightsBackend: backend });
    const denied = await fetch(`${url}/api/subject-rights/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "workflow_01",
        idempotencyKey: "idem_01",
        tenantId: "other_tenant",
      }),
    });
    expect(denied.status).toBe(400);
    expect(requestExport).not.toHaveBeenCalled();

    const accepted = await fetch(`${url}/api/subject-rights/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "workflow_01", idempotencyKey: "idem_01" }),
    });
    expect(accepted.status).toBe(202);
    expect(requestExport).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        accountId: "account_01",
        tenantId: "tenant_01",
        principalId: "principal_01",
      },
    }));
  });

  it("authenticates the internal identity store before calling its adapter", async () => {
    const deleteIdentity = vi.fn(async () => 1);
    const identityGovernedStore = new IdentityGovernedStoreAdapter({
      exportIdentity: async () => [],
      deleteIdentity,
      countIdentity: async () => 0,
    });
    const url = await start({ principalResolver, identityGovernedStore });
    const denied = await fetch(`${url}/internal/governed-store/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": "backend-token-at-least-sixteen",
      },
      body: JSON.stringify({
        operation: "delete",
        idempotencyKey: "idem_01",
        subject: {
          accountId: "account_01",
          tenantId: "tenant_01",
          principalId: "principal_01",
        },
      }),
    });
    expect(denied.status).toBe(401);
    expect(deleteIdentity).not.toHaveBeenCalled();

    const accepted = await fetch(`${url}/internal/governed-store/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": "identity-token-at-least-sixteen",
      },
      body: JSON.stringify({
        operation: "delete",
        idempotencyKey: "idem_01",
        subject: {
          accountId: "account_01",
          tenantId: "tenant_01",
          principalId: "principal_01",
        },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(deleteIdentity).toHaveBeenCalledOnce();
  });
});
