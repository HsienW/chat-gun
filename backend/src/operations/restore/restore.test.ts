import { describe, expect, it, vi } from "vitest";

import { createPostgresBackup } from "../backup/postgres-backup.js";
import { deploymentPolicySchema } from "../../platform/deployment-policy.js";
import { restorePostgresBackup, runBoundedRecoveryScan, runRestoreDrill } from "./restore.js";

async function createArtifact() {
  const dump = ["idempotency_records", "business_effects", "active_run_ownership", "task_events"]
    .map((relation) => `CREATE TABLE public.${relation} (id text);`)
    .join("\n");
  return createPostgresBackup({
    databaseUrl: "postgres://operator-only",
    schemaVersion: "20",
    runner: { run: async () => ({ dump }) },
    now: new Date("2026-10-02T00:00:00.000Z"),
  });
}

function createIsolated() {
  return {
    restore: vi.fn(async () => ({ environmentId: "isolated-1" })),
    validate: vi.fn(async () => ({ schemaCompatible: true, eventIntegrity: true, ledgersPresent: true })),
    promote: vi.fn(async () => undefined),
  };
}

describe("isolated restore", () => {
  it("promotes only after isolated validation", async () => {
    const isolated = createIsolated();
    await expect(restorePostgresBackup({ artifact: await createArtifact(), currentSchemaVersion: "20", isolated, promote: true })).resolves.toMatchObject({ status: "promoted" });
    expect(isolated.validate.mock.invocationCallOrder[0]).toBeLessThan(isolated.promote.mock.invocationCallOrder[0]);
  });

  it("aborts incompatible schemas and a drill never promotes", async () => {
    const isolated = createIsolated();
    await expect(restorePostgresBackup({ artifact: await createArtifact(), currentSchemaVersion: "21", isolated, promote: true })).resolves.toEqual({ status: "aborted", reasonCode: "SCHEMA_VERSION_INCOMPATIBLE" });
    const policy = deploymentPolicySchema.parse({ version: "1", availabilityTarget: 0.99, latencyBudgetMs: 1000, errorBudgetRatio: 0.01, recoveryTimeObjectiveMs: 10_000, recoveryPointObjectiveMs: 5_000, backupCadenceMs: 1_000, retentionMs: 20_000, restoreDrill: { maximumRecoveryTimeMs: 10_000, maximumRecoveryPointMs: 5_000 }, multiInstanceEnabled: true });
    const evidence = await runRestoreDrill({ artifact: await createArtifact(), currentSchemaVersion: "20", policy, isolated, startedAt: new Date("2026-10-02T00:00:00Z"), completedAt: new Date("2026-10-02T00:00:02Z"), latestAuthoritativeFactAt: new Date("2026-10-01T23:59:58Z") });
    expect(evidence).toMatchObject({ actualRtoMs: 2_000, actualRpoMs: 4_000, meetsRto: true, meetsRpo: true });
    expect(isolated.promote).not.toHaveBeenCalled();
  });

  it("bounds scans and parks targets after retry budget exhaustion", async () => {
    const recover = vi.fn(async () => false);
    await expect(runBoundedRecoveryScan({ targets: [1, 2, 3], maxTargets: 2, maxAttempts: 3, recover })).resolves.toEqual({ recovered: 0, parked: 2, scanned: 2 });
    expect(recover).toHaveBeenCalledTimes(6);
  });
});
