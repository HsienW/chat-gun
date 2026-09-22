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
    ["run", { runId: "other-run" }],
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
