import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN_UP_STATEMENTS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i,
] as const;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

export function extractMigrationUpSql(contents: string): string {
  const upMarker = "-- migrate:up";
  const downMarker = "-- migrate:down";
  const upIndex = contents.indexOf(upMarker);
  const downIndex = contents.indexOf(downMarker);
  if (upIndex === -1 || downIndex <= upIndex) throw new Error("INVALID_MIGRATION_MARKERS");
  return contents.slice(upIndex + upMarker.length, downIndex);
}

export function assertAdditiveMigration(contents: string, name = "migration"): void {
  const upSql = stripSqlComments(extractMigrationUpSql(contents));
  if (FORBIDDEN_UP_STATEMENTS.some((pattern) => pattern.test(upSql))) {
    throw new Error(`NON_ADDITIVE_MIGRATION:${name}`);
  }
}

export async function checkMigrationDirectory(directory: string): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    assertAdditiveMigration(await readFile(join(directory, name), "utf8"), name);
  }
  return names;
}
