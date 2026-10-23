import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Queryable } from "../runtime/persistence/rows.js";

/** The knowledge store is a separate database, so it keeps its own migration ledger. */
const KNOWLEDGE_MIGRATION_FILES = ["001_create_knowledge_store.sql"] as const;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface KnowledgeMigrationResult {
  migrationName: string;
  executed: boolean;
}

function upSection(contents: string): string {
  const upMarker = "-- migrate:up";
  const downMarker = "-- migrate:down";
  const upIndex = contents.indexOf(upMarker);
  const downIndex = contents.indexOf(downMarker);
  if (upIndex === -1 || downIndex === -1 || downIndex <= upIndex) {
    throw new Error("Invalid knowledge migration file markers");
  }
  return contents.slice(upIndex + upMarker.length, downIndex).trim();
}

export async function runKnowledgeMigrations(db: Queryable): Promise<KnowledgeMigrationResult[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS _kb_migrations (
       migration_name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  const results: KnowledgeMigrationResult[] = [];
  for (const migrationName of KNOWLEDGE_MIGRATION_FILES) {
    const applied = await db.query("SELECT 1 FROM _kb_migrations WHERE migration_name = $1", [migrationName]);
    if (applied.rows.length > 0) {
      results.push({ migrationName, executed: false });
      continue;
    }
    await db.query(upSection(await readFile(join(MIGRATIONS_DIR, migrationName), "utf8")));
    await db.query("INSERT INTO _kb_migrations (migration_name) VALUES ($1)", [migrationName]);
    results.push({ migrationName, executed: true });
  }
  return results;
}
