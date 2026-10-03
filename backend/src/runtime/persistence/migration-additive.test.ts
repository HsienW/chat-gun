import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertAdditiveMigration, checkMigrationDirectory } from "./migration-additive.js";

describe("additive migration gate", () => {
  it("accepts the checked-in migration up blocks", async () => {
    const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const migrationNames = await checkMigrationDirectory(directory);

    expect(migrationNames).toHaveLength(21);
    expect(migrationNames.at(-1)).toBe("021_create_data_governance.sql");
  });

  it.each([
    "DROP TABLE users",
    "DROP /* comment */ TABLE users",
    "DROP/* comment */TABLE users",
    "DROP -- comment\n TABLE users",
    "ALTER TABLE users DROP COLUMN name",
    "ALTER TABLE users ALTER COLUMN name TYPE INTEGER",
    "ALTER TABLE users RENAME COLUMN name TO title",
    "ALTER TABLE users DROP CONSTRAINT users_name_key",
  ])("rejects non-additive up SQL: %s", (sql) => {
    expect(() => assertAdditiveMigration(`-- migrate:up\n${sql};\n-- migrate:down\nSELECT 1;`)).toThrow("NON_ADDITIVE_MIGRATION");
  });

  it("ignores destructive down SQL", () => {
    expect(() => assertAdditiveMigration("-- migrate:up\nCREATE TABLE added(id TEXT);\n-- migrate:down\nDROP TABLE added;")).not.toThrow();
  });
});
