import { describe, expect, it } from "vitest";

import { runMigrations } from "./migration-runner.js";
import type { Queryable } from "./rows.js";

const migrationNames = [
  "001_create_agent_tasks.sql",
  "002_create_task_steps.sql",
  "003_create_task_events.sql",
  "004_create_idempotency_records.sql",
  "005_create_audit_events.sql",
  "006_create_business_effects.sql",
  "007_create_tool_executions.sql",
  "008_create_tool_execution_attempts.sql",
  "009_create_compensation_executions.sql",
  "010_create_result_references.sql",
  "011_create_permission_grants.sql",
  "012_create_permission_decisions.sql",
  "013_create_active_run_ownership.sql",
  "014_create_decision_records.sql",
  "015_create_decision_evidence_refs.sql",
  "016_create_context_refs.sql",
  "017_add_audit_correlation.sql",
  "018_create_authorization_confirmations.sql",
] as const;

function expectedResults(
  direction: "up" | "down",
  executed: boolean
) {
  const orderedNames =
    direction === "up" ? migrationNames : [...migrationNames].reverse();
  return orderedNames.map((migrationName) => ({
    migrationName,
    direction,
    executed,
  }));
}

class FakeMigrationDb implements Queryable {
  readonly executedSql: string[] = [];
  private readonly appliedMigrations = new Set<string>();

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: TResult[]; rowCount: number | null }> {
    this.executedSql.push(text);

    if (text.startsWith("SELECT migration_name")) {
      const migrationName = String(values[0]);
      const rows = this.appliedMigrations.has(migrationName)
        ? ([{ migration_name: migrationName }] as unknown as TResult[])
        : [];
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith("INSERT INTO _migrations")) {
      this.appliedMigrations.add(String(values[0]));
      return { rows: [], rowCount: 1 };
    }

    if (text.startsWith("DELETE FROM _migrations")) {
      this.appliedMigrations.delete(String(values[0]));
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: null };
  }
}

describe("runMigrations", () => {
  it("returns no results when the database is not configured", async () => {
    await expect(runMigrations("up", null)).resolves.toEqual([]);
  });

  it("runs fixed up migrations once and tracks them", async () => {
    const db = new FakeMigrationDb();

    await expect(runMigrations("up", db)).resolves.toEqual(
      expectedResults("up", true)
    );
    await expect(runMigrations("up", db)).resolves.toEqual(
      expectedResults("up", false)
    );

    const executedSql = db.executedSql.join("\n");
    expect(executedSql).toContain(
      "UNIQUE (tenant_id, scope_id, business_effect_key)"
    );
    expect(executedSql).toContain("UNIQUE (replay_key)");
    expect(executedSql).toContain(
      "UNIQUE (tool_execution_id, execution_attempt)"
    );
    expect(executedSql).toContain("manual_intervention_required");
    expect(executedSql).toContain("payload_ref TEXT NOT NULL");
    expect(executedSql).toContain("grantee_tenant_id TEXT NOT NULL");
    expect(executedSql).toContain(
      "UNIQUE (resource_tenant_id, resource_id, grantee_scope_id)"
    );
    expect(executedSql).toContain("idx_permission_grants_active_match");
    expect(executedSql).toContain("context_summary JSONB");
    expect(executedSql).toContain("idx_permission_decisions_tool_execution_id");
    expect(executedSql).toContain("ADD COLUMN IF NOT EXISTS decision_id TEXT");
    expect(executedSql).toContain("CREATE TABLE IF NOT EXISTS active_run_ownership");
    expect(executedSql).toContain(
      "WHERE status = 'active'"
    );
    expect(executedSql).toContain("CREATE TABLE IF NOT EXISTS decision_records");
    expect(executedSql).toContain("idx_decision_records_task_id");
    expect(executedSql).toContain("CREATE TABLE IF NOT EXISTS decision_evidence_refs");
    expect(executedSql).toContain("idx_decision_evidence_refs_resource");
    expect(executedSql).toContain("CREATE TABLE IF NOT EXISTS context_refs");
    expect(executedSql).toContain("idx_context_refs_source");
    expect(executedSql).toContain("idx_context_refs_target");
    expect(executedSql).toContain("idx_audit_events_run_id");
  });

  it("runs down migrations in reverse order when applied", async () => {
    const db = new FakeMigrationDb();
    await runMigrations("up", db);

    await expect(runMigrations("down", db)).resolves.toEqual(
      expectedResults("down", true)
    );
  });
});
