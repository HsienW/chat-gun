import { z } from "zod";

import {
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
