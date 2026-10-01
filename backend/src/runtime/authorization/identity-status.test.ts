import { describe, expect, it, vi } from "vitest";

import {
  PgRuntimeIdentityStatusPort,
  enforceRuntimeIdentityStatus,
  type ReadOnlyPgQueryable,
  type RuntimeIdentityStatusPort,
} from "./identity-status.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";

const context = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  attempt: 1,
  accountId: "account-1",
  sessionId: "session-1",
  principalKind: "authenticated",
  principal: {
    principalId: "principal-1",
    principalType: "user",
    principalKind: "authenticated",
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "oidc",
    authenticatedAt: "2026-09-30T00:00:00.000Z",
  },
  scope: { scopeId: "tenant-1", scopeType: "tenant", tenantId: "tenant-1" },
} satisfies ExecutionContext;

function port(overrides: Partial<RuntimeIdentityStatusPort> = {}): RuntimeIdentityStatusPort {
  return {
    checkAccount: vi.fn(async () => ({ status: "active" as const })),
    checkSession: vi.fn(async () => ({ status: "active" as const })),
    ...overrides,
  };
}

describe("runtime identity status enforcement", () => {
  it("uses parameterized read-only Postgres queries", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => ({
      rows: text.includes("identity_accounts") ? [{ status: "active" }] : [{ status: "active" }],
    }));
    const adapter = new PgRuntimeIdentityStatusPort({
      query: query as unknown as ReadOnlyPgQueryable["query"],
    });
    await adapter.checkAccount("account-1");
    await adapter.checkSession("session-1", "account-1", "principal-1");
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      expect(sql).toContain("$1");
      expect(values?.length).toBeGreaterThan(0);
    }
  });

  it("falls back to trusted snapshot semantics when disabled", async () => {
    const statusPort = port();
    await expect(enforceRuntimeIdentityStatus(context, {
      enabled: false,
      protectedPath: true,
      port: statusPort,
    })).resolves.toBeUndefined();
    expect(statusPort.checkAccount).not.toHaveBeenCalled();
  });

  it("fails closed for old protected checkpoints missing identity", async () => {
    await expect(enforceRuntimeIdentityStatus({
      ...context,
      accountId: undefined,
      sessionId: undefined,
    }, { enabled: true, protectedPath: true, port: port() }))
      .rejects.toMatchObject({ code: "IDENTITY_CONTEXT_REQUIRED" });
  });

  it.each([
    ["suspended account", port({ checkAccount: vi.fn(async () => ({ status: "suspended" as const })) }), "IDENTITY_ACCOUNT_DENIED"],
    ["revoked session", port({ checkSession: vi.fn(async () => ({ status: "revoked" as const })) }), "IDENTITY_SESSION_DENIED"],
    ["unavailable store", port({ checkAccount: vi.fn(async () => { throw new Error("db password secret"); }) }), "IDENTITY_STATUS_UNAVAILABLE"],
  ])("denies %s before dispatch", async (_name, statusPort, code) => {
    await expect(enforceRuntimeIdentityStatus(context, {
      enabled: true,
      protectedPath: true,
      port: statusPort,
    })).rejects.toMatchObject({ code });
  });

  it("allows an active account and session", async () => {
    await expect(enforceRuntimeIdentityStatus(context, {
      enabled: true,
      protectedPath: true,
      port: port(),
    })).resolves.toBeUndefined();
  });
});
