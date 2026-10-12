import { closePool, getPool } from "./connection.js";
import { runMigrations } from "./migration-runner.js";

const database = getPool();
if (!database) throw new Error("DATABASE_URL_REQUIRED");

try {
  const results = await runMigrations("up", database);
  process.stdout.write(`${JSON.stringify({
    applied: results.filter((result) => result.executed).map((result) => result.migrationName),
    skipped: results.filter((result) => !result.executed).length,
  })}\n`);
} finally {
  await closePool();
}
