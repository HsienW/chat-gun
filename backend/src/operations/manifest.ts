import { z } from "zod";

import {
  executionManifestSchema,
  parseExecutionManifest,
  type ExecutionManifest,
} from "./types.js";

const REQUIRED_MANIFEST_FIELDS = [
  "runtimeBuildId",
  "graphVersion",
  "promptVersion",
  "modelRouteVersion",
  "toolSchemaVersion",
  "policyVersion",
] as const satisfies readonly (keyof ExecutionManifest)[];
const OPTIONAL_MANIFEST_FIELDS = [
  "domainSchemaVersion",
  "catalogVersion",
  "embeddingVersion",
  "rerankerVersion",
] as const satisfies readonly (keyof ExecutionManifest)[];
const MANIFEST_FIELDS = [
  ...REQUIRED_MANIFEST_FIELDS,
  ...OPTIONAL_MANIFEST_FIELDS,
] as const;

const compatibilityPolicySchema = z
  .object({
    policyVersion: z.string().trim().min(1),
    migratableFields: z
      .array(z.enum(MANIFEST_FIELDS))
      .refine(
        (fields) => new Set(fields).size === fields.length,
        "migratableFields must not contain duplicates"
      ),
  })
  .strict();
const resumeSafetySchema = z
  .object({
    isSideEffecting: z.boolean(),
    sideEffectState: z.enum([
      "none",
      "not_started",
      "committed",
      "unknown",
    ]),
  })
  .strict();

export type ManifestField = (typeof MANIFEST_FIELDS)[number];
export type ManifestCompatibility = "compatible" | "migratable" | "incompatible";
export type ManifestCompatibilityAction =
  | "resume"
  | "migrate_then_resume"
  | "pin_old_environment_or_park";

export interface ManifestComparison {
  policyVersion: string;
  compatibility: ManifestCompatibility;
  action: ManifestCompatibilityAction;
  changedFields: ManifestField[];
  notApplicableFields: ManifestField[];
}

export interface ManifestResumeDecision {
  compatibility: ManifestCompatibility;
  action:
    | ManifestCompatibilityAction
    | "reconciliation_required";
  authorizesReplay: boolean;
}

export const DEFAULT_MANIFEST_BACKFILL_MAX_DURATION_MS =
  24 * 60 * 60 * 1_000;

export type ManifestMigrationStatus =
  | "not_started"
  | "migration_pending"
  | "completed";

export type DurableManifestState =
  | {
      status: "ready";
      compatibility: "compatible";
      canDispatch: true;
      canResume: true;
    }
  | {
      status: "migration_pending";
      compatibility?: "migratable";
      canDispatch: false;
      canResume: false;
    }
  | {
      status: "parked";
      compatibility: "incompatible";
      canDispatch: false;
      canResume: false;
    }
  | {
      status: "invalid_policy";
      reasonCode: "EXECUTION_MANIFEST_REQUIRED";
      canDispatch: false;
      canResume: false;
    };

export interface DurableManifestStateInput {
  metadata: unknown;
  migrationStatus: ManifestMigrationStatus;
  runtimeManifest: unknown;
  policy: unknown;
}

export interface MissingManifestEntity {
  entityType: "run" | "task";
  entityId: string;
  trustedLedger: unknown;
}

export interface ExecutionManifestMigrationStore {
  listMissingManifestEntities(): Promise<readonly MissingManifestEntity[]>;
  markMigrationPending(entity: MissingManifestEntity): Promise<void>;
  attachManifest(
    entity: MissingManifestEntity,
    manifest: ExecutionManifest
  ): Promise<void>;
  parkIncompatible(
    entity: MissingManifestEntity,
    reasonCode: "INSUFFICIENT_TRUSTED_LEDGER"
  ): Promise<void>;
}

export interface ManifestDeploymentHookConfig {
  policyVersion: string;
  maxDurationMs?: number;
  now?: () => number;
}

export type ManifestDeploymentHookResult =
  | {
      status: "completed";
      policyVersion: string;
      migrated: number;
      parked: number;
    }
  | {
      status: "timed_out";
      policyVersion: string;
      migrated: number;
      parked: number;
      remaining: number;
    };

export function compareExecutionManifests(
  checkpointManifestValue: unknown,
  runtimeManifestValue: unknown,
  policyValue: unknown
): ManifestComparison {
  const checkpointManifest = parseExecutionManifest(
    checkpointManifestValue
  );
  const runtimeManifest = parseExecutionManifest(runtimeManifestValue);
  const policy = compatibilityPolicySchema.parse(policyValue);
  const changedFields: ManifestField[] = [];
  const notApplicableFields: ManifestField[] = [];

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (checkpointManifest[field] !== runtimeManifest[field]) {
      changedFields.push(field);
    }
  }
  for (const field of OPTIONAL_MANIFEST_FIELDS) {
    const checkpointValue = checkpointManifest[field];
    const runtimeValue = runtimeManifest[field];
    if (checkpointValue === undefined && runtimeValue === undefined) continue;
    if (checkpointValue === undefined || runtimeValue === undefined) {
      notApplicableFields.push(field);
      continue;
    }
    if (checkpointValue !== runtimeValue) changedFields.push(field);
  }

  const compatibility: ManifestCompatibility =
    changedFields.length === 0
      ? "compatible"
      : changedFields.every((field) =>
            policy.migratableFields.includes(field)
          )
        ? "migratable"
        : "incompatible";
  const action: ManifestCompatibilityAction =
    compatibility === "compatible"
      ? "resume"
      : compatibility === "migratable"
        ? "migrate_then_resume"
        : "pin_old_environment_or_park";
  return {
    policyVersion: policy.policyVersion,
    compatibility,
    action,
    changedFields,
    notApplicableFields,
  };
}

export function evaluateDurableManifestState(
  input: DurableManifestStateInput
): DurableManifestState {
  if (input.migrationStatus === "migration_pending") {
    return {
      status: "migration_pending",
      canDispatch: false,
      canResume: false,
    };
  }

  let persistedManifest: ExecutionManifest;
  try {
    persistedManifest = readExecutionManifest(input.metadata);
  } catch {
    return {
      status: "invalid_policy",
      reasonCode: "EXECUTION_MANIFEST_REQUIRED",
      canDispatch: false,
      canResume: false,
    };
  }

  const comparison = compareExecutionManifests(
    persistedManifest,
    input.runtimeManifest,
    input.policy
  );
  if (comparison.compatibility === "incompatible") {
    return {
      status: "parked",
      compatibility: "incompatible",
      canDispatch: false,
      canResume: false,
    };
  }
  if (comparison.compatibility === "migratable") {
    return {
      status: "migration_pending",
      compatibility: "migratable",
      canDispatch: false,
      canResume: false,
    };
  }
  return {
    status: "ready",
    compatibility: "compatible",
    canDispatch: true,
    canResume: true,
  };
}

export async function runExecutionManifestDeploymentHook(
  configValue: ManifestDeploymentHookConfig,
  store: ExecutionManifestMigrationStore
): Promise<ManifestDeploymentHookResult> {
  const config = z
    .object({
      policyVersion: z.string().trim().min(1),
      maxDurationMs: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_MANIFEST_BACKFILL_MAX_DURATION_MS)
        .default(DEFAULT_MANIFEST_BACKFILL_MAX_DURATION_MS),
    })
    .strict()
    .parse({
      policyVersion: configValue.policyVersion,
      ...(configValue.maxDurationMs === undefined
        ? {}
        : { maxDurationMs: configValue.maxDurationMs }),
    });
  const now = configValue.now ?? Date.now;
  const startedAt = now();
  const entities = await store.listMissingManifestEntities();
  let migrated = 0;
  let parked = 0;

  for (const [index, entity] of entities.entries()) {
    if (now() - startedAt > config.maxDurationMs) {
      return {
        status: "timed_out",
        policyVersion: config.policyVersion,
        migrated,
        parked,
        remaining: entities.length - index,
      };
    }
    await store.markMigrationPending(entity);
    const reconstructed = executionManifestSchema.safeParse(
      entity.trustedLedger
    );
    if (!reconstructed.success) {
      await store.parkIncompatible(entity, "INSUFFICIENT_TRUSTED_LEDGER");
      parked += 1;
      continue;
    }
    await store.attachManifest(entity, reconstructed.data);
    migrated += 1;
  }

  return {
    status: "completed",
    policyVersion: config.policyVersion,
    migrated,
    parked,
  };
}

export function attachExecutionManifest(
  metadataValue: unknown,
  manifestValue: unknown
): Record<string, unknown> {
  if (
    metadataValue === null ||
    typeof metadataValue !== "object" ||
    Array.isArray(metadataValue)
  ) {
    throw new Error("EXECUTION_MANIFEST_METADATA_INVALID");
  }
  return {
    ...(metadataValue as Record<string, unknown>),
    executionManifest: parseExecutionManifest(manifestValue),
  };
}

export function readExecutionManifest(
  metadataValue: unknown
): ExecutionManifest {
  if (
    metadataValue === null ||
    typeof metadataValue !== "object" ||
    Array.isArray(metadataValue)
  ) {
    throw new Error("EXECUTION_MANIFEST_METADATA_INVALID");
  }
  return parseExecutionManifest(
    (metadataValue as Record<string, unknown>).executionManifest
  );
}

export function createManifestResumeDecision(
  comparison: ManifestComparison,
  safetyValue: unknown
): ManifestResumeDecision {
  const safety = resumeSafetySchema.parse(safetyValue);
  if (safety.isSideEffecting && safety.sideEffectState === "unknown") {
    return {
      compatibility: comparison.compatibility,
      action: "reconciliation_required",
      authorizesReplay: false,
    };
  }
  return {
    compatibility: comparison.compatibility,
    action: comparison.action,
    authorizesReplay:
      !safety.isSideEffecting && comparison.compatibility !== "incompatible",
  };
}
