import type { DeploymentPolicy } from "../../platform/deployment-policy.js";
import {
  verifyBackupIntegrity,
  type PostgresBackupArtifact,
} from "../backup/postgres-backup.js";

export interface IsolatedRestorePort {
  restore(artifact: PostgresBackupArtifact): Promise<{ environmentId: string }>;
  validate(input: {
    environmentId: string;
    expectedSchemaVersion: string;
  }): Promise<{ schemaCompatible: boolean; eventIntegrity: boolean; ledgersPresent: boolean }>;
  promote(environmentId: string): Promise<void>;
}

export type RestoreResult =
  | { status: "promoted"; environmentId: string }
  | { status: "validated"; environmentId: string }
  | { status: "aborted"; reasonCode: string };

export async function restorePostgresBackup(input: {
  artifact: PostgresBackupArtifact;
  currentSchemaVersion: string;
  isolated: IsolatedRestorePort;
  promote: boolean;
}): Promise<RestoreResult> {
  const integrity = verifyBackupIntegrity(input.artifact);
  if (!integrity.restorable) return { status: "aborted", reasonCode: integrity.reasonCode };
  if (input.artifact.schemaVersion !== input.currentSchemaVersion) {
    return { status: "aborted", reasonCode: "SCHEMA_VERSION_INCOMPATIBLE" };
  }
  const restored = await input.isolated.restore(input.artifact);
  const validation = await input.isolated.validate({
    environmentId: restored.environmentId,
    expectedSchemaVersion: input.currentSchemaVersion,
  });
  if (!validation.schemaCompatible || !validation.eventIntegrity || !validation.ledgersPresent) {
    return { status: "aborted", reasonCode: "ISOLATED_VALIDATION_FAILED" };
  }
  if (!input.promote) return { status: "validated", environmentId: restored.environmentId };
  await input.isolated.promote(restored.environmentId);
  return { status: "promoted", environmentId: restored.environmentId };
}

export interface RestoreDrillEvidence {
  schemaVersion: string;
  measuredAt: string;
  actualRpoMs: number;
  actualRtoMs: number;
  meetsRpo: boolean;
  meetsRto: boolean;
  restoreStatus: "validated";
}

export async function runRestoreDrill(input: {
  artifact: PostgresBackupArtifact;
  currentSchemaVersion: string;
  policy: DeploymentPolicy;
  isolated: IsolatedRestorePort;
  startedAt: Date;
  completedAt: Date;
  latestAuthoritativeFactAt: Date;
}): Promise<RestoreDrillEvidence> {
  const restored = await restorePostgresBackup({
    artifact: input.artifact,
    currentSchemaVersion: input.currentSchemaVersion,
    isolated: input.isolated,
    promote: false,
  });
  if (restored.status === "aborted") {
    throw new Error(`RESTORE_DRILL_${restored.reasonCode}`);
  }
  if (restored.status !== "validated") {
    throw new Error("RESTORE_DRILL_UNEXPECTED_PROMOTION");
  }
  const actualRtoMs = Math.max(0, input.completedAt.getTime() - input.startedAt.getTime());
  const actualRpoMs = Math.max(
    0,
    input.completedAt.getTime() - input.latestAuthoritativeFactAt.getTime()
  );
  return {
    schemaVersion: input.currentSchemaVersion,
    measuredAt: input.completedAt.toISOString(),
    actualRpoMs,
    actualRtoMs,
    meetsRpo: actualRpoMs <= input.policy.recoveryPointObjectiveMs,
    meetsRto: actualRtoMs <= input.policy.recoveryTimeObjectiveMs,
    restoreStatus: "validated",
  };
}

export async function runBoundedRecoveryScan<T>(input: {
  targets: readonly T[];
  maxTargets: number;
  maxAttempts: number;
  recover(target: T, attempt: number): Promise<boolean>;
}): Promise<{ recovered: number; parked: number; scanned: number }> {
  const targets = input.targets.slice(0, input.maxTargets);
  let recovered = 0;
  let parked = 0;
  for (const target of targets) {
    let succeeded = false;
    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      if (await input.recover(target, attempt)) {
        succeeded = true;
        recovered += 1;
        break;
      }
    }
    if (!succeeded) parked += 1;
  }
  return { recovered, parked, scanned: targets.length };
}
