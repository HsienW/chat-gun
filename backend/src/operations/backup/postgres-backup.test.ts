import { describe, expect, it, vi } from "vitest";

import { createPgDumpRunner, createPostgresBackup, verifyBackupIntegrity, type PgDumpExecutor } from "./postgres-backup.js";

const RELATIONS = [
  "idempotency_records",
  "business_effects",
  "active_run_ownership",
  "task_events",
];
const COMPLETE_DUMP = RELATIONS.map(
  (relation) => `CREATE TABLE public.${relation} (id text);`
).join("\n");

describe("Postgres backup", () => {
  it("creates a checksummed logical backup without embedding a key", async () => {
    const artifact = await createPostgresBackup({
      databaseUrl: "postgres://operator-only",
      schemaVersion: "20",
      runner: { run: vi.fn(async () => ({ dump: COMPLETE_DUMP })) },
      now: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(artifact).toMatchObject({
      schemaVersion: "20",
      redis: "non_authoritative_rebuildable",
      encryptionKeyDependency: "external",
    });
    expect(JSON.stringify(artifact)).not.toContain("operator-only");
    expect(verifyBackupIntegrity(artifact).restorable).toBe(true);
  });

  it("rejects checksum tampering and missing ledgers", async () => {
    const artifact = await createPostgresBackup({
      databaseUrl: "postgres://operator-only",
      schemaVersion: "20",
      runner: { run: async () => ({ dump: COMPLETE_DUMP }) },
    });
    expect(verifyBackupIntegrity({ ...artifact, dump: "tampered" })).toEqual({
      restorable: false,
      reasonCode: "CHECKSUM_MISMATCH",
    });
    const incomplete = await createPostgresBackup({
      databaseUrl: "postgres://operator-only",
      schemaVersion: "20",
      runner: { run: async () => ({ dump: "CREATE TABLE public.task_events (id text);" }) },
    });
    expect(verifyBackupIntegrity(incomplete)).toEqual({
      restorable: false,
      reasonCode: "REQUIRED_LEDGER_MISSING",
    });
  });

  it("invokes a fixed pg_dump command and passes the database URL only through child env", async () => {
    const executor = vi.fn<PgDumpExecutor>(async () => ({ stdout: "dump" }));
    const runner = createPgDumpRunner(executor);
    await runner.run("postgres://secret-credential");
    expect(executor).toHaveBeenCalledWith(
      "pg_dump",
      ["--format=plain", "--no-owner", "--no-privileges"],
      expect.objectContaining({
        env: expect.objectContaining({ PGDATABASE: "postgres://secret-credential" }),
      })
    );
    expect(executor.mock.calls[0]?.[1]?.join(" ")).not.toContain("secret-credential");
  });
});
