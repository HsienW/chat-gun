import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import { instrumentGraphWithExecutionContext } from "../execution-context/instrument-graph.js";
import {
  PgSubjectCorrelationIndex,
  createCorrelationKey,
  createInMemorySubjectCorrelationIndex,
  recordExecutionContextCorrelations,
} from "./subject-correlation-index.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

const executionContext: ExecutionContext = {
  requestId: "request_01",
  threadId: "thread_01",
  runId: "run_01",
  taskId: "task_01",
  stepId: "step_01",
  toolCallId: "tool_call_01",
  toolExecutionId: "tool_execution_01",
  attempt: 1,
  accountId: "acct_01",
  principalKind: "authenticated",
  principal: {
    principalId: "principal_01",
    principalType: "user",
    principalKind: "authenticated",
    tenantId: "tenant_01",
    accountId: "acct_01",
    roles: [],
    scopes: [],
    authSource: "trusted_gateway",
    authenticatedAt: "2026-09-30T00:00:00.000Z",
  },
  scope: {
    scopeId: "principal_01",
    scopeType: "principal",
    tenantId: "tenant_01",
    ownerPrincipalId: "principal_01",
  },
};

describe("subject correlation index", () => {
  it("records canonical ExecutionContext keys without reading metadata", async () => {
    const index = createInMemorySubjectCorrelationIndex();
    await recordExecutionContextCorrelations(
      index,
      executionContext,
      () => new Date("2026-09-30T00:00:00.000Z"),
    );

    expect(await index.resolve(createCorrelationKey("taskId", "task_01"))).toEqual({
      accountId: "acct_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
    });
    expect(await index.resolve(createCorrelationKey("runId", "run_01"))).toEqual({
      accountId: "acct_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
    });
    expect(await index.resolve(createCorrelationKey("toolExecutionId", "tool_execution_01")))
      .toMatchObject({ accountId: "acct_01" });
  });

  it("is idempotent but rejects rebinding a correlation key to another subject", async () => {
    const index = createInMemorySubjectCorrelationIndex();
    await recordExecutionContextCorrelations(index, executionContext);
    await recordExecutionContextCorrelations(index, executionContext);

    await expect(
      recordExecutionContextCorrelations(index, {
        ...executionContext,
        accountId: "acct_02",
        principal: {
          ...executionContext.principal,
          accountId: "acct_02",
          principalId: "principal_02",
        },
      }),
    ).rejects.toThrowError(/SUBJECT_CORRELATION_CONFLICT/);
  });

  it("records correlations before graph invoke and fails closed before execution", async () => {
    const invoke = vi.fn(async (_input?: unknown, _config?: unknown) => "done");
    const index = createInMemorySubjectCorrelationIndex();
    const wrapped = instrumentGraphWithExecutionContext(
      { invoke },
      () => executionContext,
      { subjectCorrelationIndex: index },
    );

    await expect(wrapped.invoke(undefined)).resolves.toBe("done");
    expect(await index.resolve(createCorrelationKey("threadId", "thread_01")))
      .toMatchObject({ accountId: "acct_01" });
    expect(invoke).toHaveBeenCalledTimes(1);

    const failingIndex = {
      record: vi.fn(async () => {
        throw new Error("SUBJECT_CORRELATION_UNAVAILABLE");
      }),
      resolve: vi.fn(),
    };
    const guardedInvoke = vi.fn(
      async (_input?: unknown, _config?: unknown) => "must-not-run",
    );
    const guarded = instrumentGraphWithExecutionContext(
      { invoke: guardedInvoke },
      () => executionContext,
      { subjectCorrelationIndex: failingIndex },
    );
    await expect(guarded.invoke(undefined)).rejects.toThrowError(
      /SUBJECT_CORRELATION_UNAVAILABLE/,
    );
    expect(guardedInvoke).not.toHaveBeenCalled();
  });

  it("uses parameterized PostgreSQL upsert and resolve queries", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.startsWith("SELECT")
        ? [{
            account_id: "acct_01",
            tenant_id: "tenant_01",
            principal_id: "principal_01",
          }]
        : [],
      rowCount: 1,
    }));
    const index = new PgSubjectCorrelationIndex({ query } as Queryable);

    await index.record({
      schemaVersion: "1.0.0",
      correlationKey: "taskId:task_01",
      accountId: "acct_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
      recordedAt: "2026-09-30T00:00:00.000Z",
    });
    await expect(index.resolve("taskId:task_01")).resolves.toEqual({
      accountId: "acct_01",
      tenantId: "tenant_01",
      principalId: "principal_01",
    });
    expect(query.mock.calls.every((call) => Array.isArray(call[1]))).toBe(true);
  });

  it("ships an additive migration for the correlation index", async () => {
    const sql = await readFile(
      resolve(
        currentDirectory,
        "../persistence/migrations/021_create_data_governance.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS subject_correlation_index");
    expect(sql).toContain("UNIQUE (correlation_key)");
    expect(sql).not.toMatch(/ALTER TABLE\s+(agent_tasks|task_steps|task_events)/iu);
  });
});
