import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import { PgGovernedStoreDriver } from "./pg-governed-store-driver.js";

const subject = {
  accountId: "account_01",
  tenantId: "tenant_01",
  principalId: "principal_01",
};

describe("PgGovernedStoreDriver", () => {
  it("filters correlation stores through the authoritative subject index", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.startsWith("SELECT to_jsonb") ? [{ record: { task_id: "task_01" } }] : [],
      rowCount: 1,
    }));
    const driver = new PgGovernedStoreDriver({ query } as Queryable, [{
      dataClassId: "runtime.tasks",
      table: "agent_tasks",
      resolution: "correlation",
      correlationColumn: "task_id",
      correlationDimension: "taskId",
    }]);
    await expect(driver.exportBySubject("runtime.tasks", subject)).resolves.toEqual([
      { task_id: "task_01" },
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("JOIN subject_correlation_index");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "account_01", "tenant_01", "principal_01", "taskId:",
    ]);
  });

  it("uses declared direct columns and rejects unknown plans", async () => {
    const query = vi.fn(async () => ({ rows: [{ record_count: 1 }], rowCount: 1 }));
    const driver = new PgGovernedStoreDriver({ query } as Queryable, [{
      dataClassId: "runtime.result-references",
      table: "result_references",
      resolution: "direct",
      subjectColumns: { tenantId: "tenant_id", principalId: "principal_id" },
    }]);
    await expect(driver.countBySubject("runtime.result-references", subject)).resolves.toBe(1);
    await expect(driver.countBySubject("unknown", subject)).rejects.toThrow(
      "GOVERNED_STORE_PLAN_NOT_FOUND",
    );
  });

  it("rejects dynamic SQL identifiers outside the declarative allowlist", () => {
    expect(() => new PgGovernedStoreDriver({ query: vi.fn() } as unknown as Queryable, [{
      dataClassId: "runtime.tasks",
      table: "agent_tasks; DROP TABLE agent_tasks",
      resolution: "correlation",
      correlationColumn: "task_id",
      correlationDimension: "taskId",
    }])).toThrow("INVALID_GOVERNED_SQL_IDENTIFIER");
  });
});
