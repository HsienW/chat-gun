import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkMigrationDirectory } from "./migration-additive.js";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

const names = await checkMigrationDirectory(migrationsDirectory);
process.stdout.write(`${JSON.stringify({ status: "passed", checked: names.length })}\n`);
