import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

const requiredRelationSchema = z.enum([
  "idempotency_records",
  "business_effects",
  "active_run_ownership",
  "task_events",
]);

export const postgresBackupArtifactSchema = z
  .object({
    formatVersion: z.literal("1.0"),
    store: z.literal("postgres"),
    schemaVersion: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    dump: z.string().min(1),
    includedRelations: z.array(requiredRelationSchema),
    redis: z.literal("non_authoritative_rebuildable"),
    encryptionKeyDependency: z.literal("external"),
  })
  .strict();

export type PostgresBackupArtifact = z.infer<typeof postgresBackupArtifactSchema>;

export interface PgDumpRunner {
  run(databaseUrl: string): Promise<{ dump: string }>;
}

export interface PgDumpExecutor {
  (file: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    encoding: "utf8";
  }): Promise<{ stdout: string }>;
}

const executeFile = promisify(execFileCallback) as unknown as PgDumpExecutor;
const AUTHORITATIVE_RELATIONS = [
  "idempotency_records",
  "business_effects",
  "active_run_ownership",
  "task_events",
] as const;

export function createPgDumpRunner(
  executor: PgDumpExecutor = executeFile
): PgDumpRunner {
  return {
    async run(databaseUrl) {
      const { stdout } = await executor(
        "pg_dump",
        ["--format=plain", "--no-owner", "--no-privileges"],
        {
          env: { ...process.env, PGDATABASE: databaseUrl },
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf8",
        }
      );
      return { dump: stdout };
    },
  };
}

export async function createPostgresBackup(input: {
  databaseUrl: string;
  schemaVersion: string;
  runner: PgDumpRunner;
  now?: Date;
}): Promise<PostgresBackupArtifact> {
  if (!input.databaseUrl.trim()) throw new Error("BACKUP_DATABASE_URL_REQUIRED");
  const output = await input.runner.run(input.databaseUrl);
  const checksumSha256 = createHash("sha256").update(output.dump).digest("hex");
  const includedRelations = AUTHORITATIVE_RELATIONS.filter((relation) => {
    const escaped = relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:public\\.)?"?${escaped}"?\\b`, "i").test(output.dump);
  });
  return postgresBackupArtifactSchema.parse({
    formatVersion: "1.0",
    store: "postgres",
    schemaVersion: input.schemaVersion,
    createdAt: (input.now ?? new Date()).toISOString(),
    checksumSha256,
    dump: output.dump,
    includedRelations,
    redis: "non_authoritative_rebuildable",
    encryptionKeyDependency: "external",
  });
}

export type BackupIntegrityResult =
  | { restorable: true; evidence: { checksumVerified: true; requiredRelations: true } }
  | { restorable: false; reasonCode: "CHECKSUM_MISMATCH" | "REQUIRED_LEDGER_MISSING" };

export function verifyBackupIntegrity(artifactValue: unknown): BackupIntegrityResult {
  const artifact = postgresBackupArtifactSchema.parse(artifactValue);
  const checksum = createHash("sha256").update(artifact.dump).digest("hex");
  if (checksum !== artifact.checksumSha256) {
    return { restorable: false, reasonCode: "CHECKSUM_MISMATCH" };
  }
  const relations = new Set(artifact.includedRelations);
  if (!relations.has("idempotency_records") || !relations.has("business_effects")) {
    return { restorable: false, reasonCode: "REQUIRED_LEDGER_MISSING" };
  }
  return {
    restorable: true,
    evidence: { checksumVerified: true, requiredRelations: true },
  };
}
