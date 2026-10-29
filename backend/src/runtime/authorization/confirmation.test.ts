import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import {
  createConfirmationRequiredDescriptor,
  parseConfirmationResume,
  PgAuthorizationConfirmationStore,
  toConfirmationInterruptPayload,
} from "./confirmation.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "tool-call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: ["operator"],
    scopes: ["tool:approve"],
    authSource: "trusted_gateway" as const,
    authenticatedAt: "2026-09-20T00:00:00.000Z",
  },
  scope: {
    scopeId: "tenant-1",
    scopeType: "tenant" as const,
    tenantId: "tenant-1",
  },
};

function createDescriptor() {
  return createConfirmationRequiredDescriptor({
    decisionId: "decision-1",
    executionContext,
    action: "tool:write",
    toolName: "write_file",
    resource: {
      resourceType: "mcp_tool",
      resourceId: "filesystem:write_file",
      tenantId: "tenant-1",
      ownerScopeId: "tenant-1",
    },
    policyVersion: "runtime-authorization-v1",
    timeoutMs: 60_000,
    now: new Date("2026-09-21T00:00:00.000Z"),
  });
}

describe("authorization confirmation contract", () => {
  it("creates a versioned redacted descriptor with a 256-bit approval id", () => {
    const descriptor = createDescriptor();
    expect(descriptor.approvalId).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor).toMatchObject({
      type: "confirmation_required",
      schemaVersion: "1.0",
      decisionId: "decision-1",
      runId: "run-1",
      policyVersion: "runtime-authorization-v1",
      resumeCompatibility: {
        type: "tool_authorization_confirmation",
        schemaVersion: "1.0",
        decisions: ["approve", "deny"],
      },
    });
    const interrupt = toConfirmationInterruptPayload(descriptor);
    expect(interrupt.resumeCompatibility).toEqual(
      descriptor.resumeCompatibility
    );
    const serialized = JSON.stringify(interrupt);
    for (const forbidden of ["credential", "token", "apiKey", "rawInput"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("strictly parses the versioned resume payload", () => {
    expect(parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: createDescriptor().approvalId,
      decisionId: "decision-1",
      decision: "approve",
    }).decision).toBe("approve");
    expect(() => parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "2.0",
      approvalId: createDescriptor().approvalId,
      decisionId: "decision-1",
      decision: "approve",
    })).toThrow();
  });
});

describe("PgAuthorizationConfirmationStore", () => {
  it.each(["run-1", "resume-run"])("accepts %s while retaining the waiting run SQL binding and audit", async (runId) => {
    const db: Queryable = { query: async <TResult extends Record<string, unknown>>(sql: string) => ({
      rows: (sql.includes("WITH consumed") ? [{ status: "approved" }] : []) as unknown as TResult[],
      rowCount: sql.includes("WITH consumed") ? 1 : 0,
    }) };
    const query = vi.spyOn(db, "query");
    const audit = { record: vi.fn() };
    const store = new PgAuthorizationConfirmationStore(db, audit);
    const descriptor = createDescriptor();
    const result = await store.consume({ descriptor, resume: parseConfirmationResume({
      type: "tool_authorization_confirmation", schemaVersion: "1.0",
      approvalId: descriptor.approvalId, decisionId: descriptor.decisionId, decision: "approve",
    }), executionContext: { ...executionContext, runId } });
    expect(result).toEqual({ ok: true, status: "approved" });
    expect(query.mock.calls[0][0]).toContain("AND run_id = $7");
    expect(query.mock.calls[0][1]?.[6]).toBe(descriptor.runId);
    expect(query.mock.calls[1][0]).toContain("AND run_id = $8");
    expect(query.mock.calls[1][1]?.[7]).toBe(descriptor.runId);
    expect(audit.record).toHaveBeenCalledWith("authorization.confirmation.consumed", {
      decisionId: descriptor.decisionId, status: "approved", waitingRunId: "run-1", resumeRunId: runId,
    });
  });

  it("idempotently persists pending state and atomically consumes it once", async () => {
    let consumed = false;
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      text: string,
      _values: readonly unknown[] = []
    ) => {
      if (text.includes("INSERT INTO authorization_confirmations")) {
        return {
          rows: [{ task_id: "task-1" }] as unknown as TResult[],
          rowCount: 1,
        };
      }
      if (text.includes("SET status = 'expired'")) {
        return { rows: [] as TResult[], rowCount: 0 };
      }
      if (text.includes("UPDATE authorization_confirmations") && !consumed) {
        consumed = true;
        return {
          rows: [{ status: "approved" }] as unknown as TResult[],
          rowCount: 1,
        };
      }
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const store = new PgAuthorizationConfirmationStore({ query } as Queryable);
    const descriptor = createDescriptor();
    await store.upsertPending(descriptor);
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });

    const [first, second] = await Promise.all([
      store.consume({ descriptor, resume, executionContext }),
      store.consume({ descriptor, resume, executionContext }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'pending'"))).toBe(true);
    expect(query.mock.calls.some(([_sql, values]) =>
      values?.includes("CONFIRMATION_APPROVED") === true
    )).toBe(true);
  });

  it("fails closed when an idempotent pending upsert has conflicting bindings", async () => {
    let capturedSql = "";
    const query = vi.fn(async <TResult extends Record<string, unknown>>(text: string) => {
      capturedSql = text;
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const store = new PgAuthorizationConfirmationStore({ query } as Queryable);

    await expect(store.upsertPending(createDescriptor())).rejects.toThrow(
      "Pending confirmation binding conflict"
    );
    expect(capturedSql).toContain(
      "authorization_confirmations.approval_id = EXCLUDED.approval_id"
    );
  });

  it("atomically expires a pending confirmation and records timeout state", async () => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(text: string) => {
      if (text.includes("SET status = 'expired'")) {
        return {
          rows: [{ status: "expired" }] as unknown as TResult[],
          rowCount: 1,
        };
      }
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const audit = { record: vi.fn(async () => undefined) };
    const store = new PgAuthorizationConfirmationStore(
      { query } as Queryable,
      audit
    );
    const descriptor = createDescriptor();
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });

    await expect(store.consume({
      descriptor,
      resume,
      executionContext,
      now: new Date("2026-09-21T00:02:00.000Z"),
    })).resolves.toEqual({ ok: false, reasonCode: "CONFIRMATION_TIMEOUT" });
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "reason_code = 'CONFIRMATION_TIMEOUT'"
    );
    expect(audit.record).toHaveBeenCalledWith(
      "authorization.confirmation.rejected",
      expect.objectContaining({ reasonCode: "CONFIRMATION_TIMEOUT" })
    );
  });

  it.each([
    ["principal", { principal: { ...executionContext.principal, principalId: "other" } }],
    ["scope", { scope: { ...executionContext.scope, scopeId: "other" } }],
    ["thread", { threadId: "other-thread" }],
  ])("rejects a %s binding mismatch before atomic consume", async (_label, override) => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>() => ({
      rows: [] as TResult[], rowCount: 0,
    }));
    const store = new PgAuthorizationConfirmationStore({ query } as Queryable);
    const descriptor = createDescriptor();
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });
    const result = await store.consume({
      descriptor,
      resume,
      executionContext: { ...executionContext, ...override },
    });
    expect(result).toMatchObject({ ok: false });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["resource", { resourceId: "other-resource", policyVersion: "runtime-authorization-v1" }],
    ["policy", { resourceId: "filesystem:write_file", policyVersion: "other-policy" }],
  ])("rejects a stored %s binding mismatch during atomic consume", async (
    _label,
    binding
  ) => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = []
    ) => {
      if (text.includes("SET status = 'expired'")) {
        return { rows: [] as TResult[], rowCount: 0 };
      }
      const matchesStoredBinding =
        values[9] === "filesystem:write_file" &&
        values[10] === "runtime-authorization-v1";
      return matchesStoredBinding
        ? {
            rows: [{ status: "approved" }] as unknown as TResult[],
            rowCount: 1,
          }
        : { rows: [] as TResult[], rowCount: 0 };
    });
    const store = new PgAuthorizationConfirmationStore({ query } as Queryable);
    const original = createDescriptor();
    const descriptor = {
      ...original,
      resource: { ...original.resource, resourceId: binding.resourceId },
      policyVersion: binding.policyVersion,
    };
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });

    await expect(store.consume({
      descriptor,
      resume,
      executionContext,
    })).resolves.toEqual({
      ok: false,
      reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED",
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("PgAuthorizationConfirmationStore withdrawal", () => {
  const cancellingContext = { ...executionContext, runId: "run-cancel-2" };

  function storeReturning(
    withdrawRows: Record<string, unknown>[],
    statusRow?: Record<string, unknown>
  ) {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      text: string,
      _values: readonly unknown[] = []
    ) => {
      if (text.includes("WITH target AS")) {
        return { rows: withdrawRows as TResult[], rowCount: withdrawRows.length };
      }
      if (text.includes("SELECT status, withdrawn_at, expires_at")) {
        const rows = statusRow ? [statusRow] : [];
        return { rows: rows as TResult[], rowCount: rows.length };
      }
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const audit = { record: vi.fn(async () => undefined) };
    return {
      query,
      audit,
      store: new PgAuthorizationConfirmationStore({ query } as Queryable, audit),
    };
  }

  it("withdraws a pending confirmation from a different run as denied plus withdrawn_at", async () => {
    const { query, audit, store } = storeReturning([{ outcome: "withdrawn" }]);
    const descriptor = createDescriptor();

    await expect(store.withdraw({
      descriptor,
      executionContext: cancellingContext,
      now: new Date("2026-09-21T00:00:30.000Z"),
    })).resolves.toEqual({ ok: true, status: "withdrawn" });

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("THEN 'expired' ELSE 'denied' END");
    expect(String(sql)).toContain("withdrawn_at = CASE");
    expect(String(sql)).toContain("'CONFIRMATION_CANCELLED'");
    expect(String(sql)).toContain("ELSE 'superseded' END");
    expect(String(sql)).not.toMatch(/ELSE 'withdrawn' END,\s*consumed_at/);
    expect(String(sql)).not.toMatch(/run_id = \$/);
    expect(values).toContain(descriptor.approvalId);
    expect(values).toContain("principal-1");
    expect(audit.record).toHaveBeenCalledWith(
      "authorization.confirmation.withdrawn",
      expect.objectContaining({ status: "withdrawn" })
    );
  });

  it("reports an expired confirmation instead of withdrawing it", async () => {
    const { store } = storeReturning([{ outcome: "expired" }]);
    await expect(store.withdraw({
      descriptor: createDescriptor(),
      executionContext: cancellingContext,
      now: new Date("2026-09-21T00:02:00.000Z"),
    })).resolves.toEqual({ ok: true, status: "expired" });
  });

  it.each([
    ["principal", { principal: { ...executionContext.principal, principalId: "other" } }],
    ["scope", { scope: { ...executionContext.scope, scopeId: "other" } }],
    ["tenant", { scope: { ...executionContext.scope, tenantId: "other" } }],
  ])("rejects a %s binding mismatch without touching the store", async (_label, override) => {
    const { query, store } = storeReturning([]);
    await expect(store.withdraw({
      descriptor: createDescriptor(),
      executionContext: { ...cancellingContext, ...override },
    })).resolves.toEqual({ ok: false, reasonCode: "CONFIRMATION_BINDING_MISMATCH" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["approved", { status: "approved", withdrawn_at: null, expires_at: "2026-09-21T00:01:00.000Z" }],
    ["denied", { status: "denied", withdrawn_at: null, expires_at: "2026-09-21T00:01:00.000Z" }],
  ])("returns already decided when the confirmation was %s", async (_label, statusRow) => {
    const { store } = storeReturning([], statusRow);
    await expect(store.withdraw({
      descriptor: createDescriptor(),
      executionContext: cancellingContext,
    })).resolves.toEqual({ ok: false, reasonCode: "CONFIRMATION_ALREADY_DECIDED" });
  });

  it("treats a repeated withdrawal as already withdrawn", async () => {
    const { store } = storeReturning([], {
      status: "denied",
      withdrawn_at: "2026-09-21T00:00:30.000Z",
      expires_at: "2026-09-21T00:01:00.000Z",
    });
    await expect(store.withdraw({
      descriptor: createDescriptor(),
      executionContext: cancellingContext,
    })).resolves.toEqual({ ok: true, status: "withdrawn" });
  });

  it("fails closed with a typed failure when the store cannot be written", async () => {
    const query = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const audit = { record: vi.fn(async () => undefined) };
    const store = new PgAuthorizationConfirmationStore({ query } as unknown as Queryable, audit);
    await expect(store.withdraw({
      descriptor: createDescriptor(),
      executionContext: cancellingContext,
    })).resolves.toEqual({ ok: false, reasonCode: "CONFIRMATION_WITHDRAW_FAILED" });
    expect(audit.record).toHaveBeenCalledWith(
      "authorization.confirmation.withdraw_rejected",
      expect.objectContaining({ reasonCode: "CONFIRMATION_WITHDRAW_FAILED" })
    );
  });

  it("distinguishes a withdrawn confirmation from a denial when reading status", async () => {
    const withdrawn = storeReturning([], {
      status: "denied",
      withdrawn_at: new Date("2026-09-21T00:00:30.000Z"),
      expires_at: new Date("2026-09-21T00:01:00.000Z"),
    });
    const denied = storeReturning([], {
      status: "denied",
      withdrawn_at: null,
      expires_at: new Date("2026-09-21T00:01:00.000Z"),
    });
    const descriptor = createDescriptor();
    const ids = { approvalId: descriptor.approvalId, decisionId: descriptor.decisionId };

    await expect(withdrawn.store.findStatus(ids)).resolves.toEqual({
      status: "denied",
      withdrawn: true,
      expiresAt: "2026-09-21T00:01:00.000Z",
    });
    await expect(denied.store.findStatus(ids)).resolves.toMatchObject({
      status: "denied",
      withdrawn: false,
    });
  });

  it("rejects an unknown stored status instead of guessing", async () => {
    const { store } = storeReturning([], {
      status: "withdrawn",
      withdrawn_at: null,
      expires_at: "2026-09-21T00:01:00.000Z",
    });
    const descriptor = createDescriptor();
    await expect(store.findStatus({
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
    })).rejects.toThrow("Unknown authorization confirmation status");
  });

  it("keeps a withdrawn confirmation non-consumable for the existing consume path", async () => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(text: string) => {
      if (text.includes("SET status = 'expired'")) {
        return { rows: [] as TResult[], rowCount: 0 };
      }
      if (text.includes("AND status = 'pending'")) {
        return { rows: [] as TResult[], rowCount: 0 };
      }
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const store = new PgAuthorizationConfirmationStore({ query } as Queryable);
    const descriptor = createDescriptor();
    const resume = parseConfirmationResume({
      type: "tool_authorization_confirmation",
      schemaVersion: "1.0",
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
      decision: "approve",
    });

    await expect(store.consume({ descriptor, resume, executionContext })).resolves.toEqual({
      ok: false,
      reasonCode: "CONFIRMATION_REPLAYED_OR_EXPIRED",
    });
  });
});
