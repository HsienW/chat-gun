import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPool } from "./connection.js";
import type { Queryable } from "./rows.js";

const MIGRATION_FILES = [
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

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type MigrationDirection = "up" | "down";

export interface MigrationRunResult {
  migrationName: string;
  direction: MigrationDirection;
  executed: boolean;
}

async function ensureMigrationTable(db: Queryable): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       migration_name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
}

function getMigrationNames(direction: MigrationDirection): readonly string[] {
  return direction === "up" ? MIGRATION_FILES : [...MIGRATION_FILES].reverse();
}

function parseMigrationSql(contents: string, direction: MigrationDirection): string {
  const upMarker = "-- migrate:up";
  const downMarker = "-- migrate:down";
  const upIndex = contents.indexOf(upMarker);
  const downIndex = contents.indexOf(downMarker);

  if (upIndex === -1 || downIndex === -1 || downIndex <= upIndex) {
    throw new Error("Invalid migration file markers");
  }

  return direction === "up"
    ? contents.slice(upIndex + upMarker.length, downIndex).trim()
    : contents.slice(downIndex + downMarker.length).trim();
}

async function readMigrationSql(
  migrationName: string,
  direction: MigrationDirection
): Promise<string> {
  const migrationPath = join(MIGRATIONS_DIR, migrationName);
  const contents = await readFile(migrationPath, "utf8");
  return parseMigrationSql(contents, direction);
}

async function hasMigrationRun(db: Queryable, migrationName: string): Promise<boolean> {
  const result = await db.query<{ migration_name: string }>(
    "SELECT migration_name FROM _migrations WHERE migration_name = $1",
    [migrationName]
  );

  return result.rows.length > 0;
}

async function runMigration(
  db: Queryable,
  migrationName: string,
  direction: MigrationDirection
): Promise<MigrationRunResult> {
  const alreadyApplied = await hasMigrationRun(db, migrationName);

  if (direction === "up" && alreadyApplied) {
    return { migrationName, direction, executed: false };
  }

  if (direction === "down" && !alreadyApplied) {
    return { migrationName, direction, executed: false };
  }

  await db.query(await readMigrationSql(migrationName, direction));
  await db.query(
    direction === "up"
      ? "INSERT INTO _migrations (migration_name) VALUES ($1)"
      : "DELETE FROM _migrations WHERE migration_name = $1",
    [migrationName]
  );

  return { migrationName, direction, executed: true };
}

export async function runMigrations(
  direction: MigrationDirection,
  db: Queryable | null = getPool()
): Promise<MigrationRunResult[]> {
  if (!db) {
    return [];
  }

  await ensureMigrationTable(db);

  const results: MigrationRunResult[] = [];
  for (const migrationName of getMigrationNames(direction)) {
    results.push(await runMigration(db, migrationName, direction));
  }

  return results;
}
