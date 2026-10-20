import { z } from "zod";

import { executionManifestRefSchema } from "../recovery/interrupt-manifest.js";
import { classifyExecutionManifestCompatibility } from "../recovery/execution-manifest.js";
import { evaluateRuntimeVersionCompatibility, type RuntimeVersionSet } from "./version-compatibility.js";

const identifierSchema = z.string().min(1).max(256).refine((identifier) => identifier.trim() === identifier);
const versionStringSchema = z.string().min(1).max(128).refine((version) => version.trim() === version);
const semverSchema = z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
const boundedExecutionManifestRefSchema = executionManifestRefSchema.refine((manifest) =>
  [manifest.manifestVersion, ...Object.values(manifest.schemaVersions)].every((version) => version.length <= 128));

export const runtimeVersionSetSchema: z.ZodType<RuntimeVersionSet> = z.object({
  schemaVersion: versionStringSchema,
  eventVersion: versionStringSchema,
  packageVersion: versionStringSchema,
  checkpointVersion: versionStringSchema.optional(),
  sideEffectVersion: versionStringSchema.optional(),
  idempotencyVersion: versionStringSchema.optional(),
  manifestVersion: versionStringSchema.optional(),
}).strict();

export const nativeCheckpointRefSchema = z.object({
  threadId: identifierSchema,
  checkpointId: identifierSchema,
  checkpointNamespace: z.string().max(256),
}).strict();

const productIdentityBase = { runId: identifierSchema, taskId: identifierSchema };
export const checkpointProductIdentitySchema = z.union([
  z.object(productIdentityBase).strict(),
  z.object({ ...productIdentityBase, stepId: identifierSchema, attempt: z.number().int().positive().safe() }).strict(),
]);

const adapterVersionRefSchema = z.object({
  adapterId: identifierSchema,
  adapterVersion: semverSchema,
  stateSchemaVersion: semverSchema,
}).strict();

const versionRefSchema = adapterVersionRefSchema.extend({
  executionManifest: boundedExecutionManifestRefSchema,
  runtimeVersions: runtimeVersionSetSchema,
}).strict();

export const checkpointAdapterMetadataV1Schema = versionRefSchema.extend({
  schemaVersion: z.literal("1.0.0"),
  nativeCheckpointRef: nativeCheckpointRefSchema,
  productIdentityRef: checkpointProductIdentitySchema,
}).strict();

const legacyCheckpointSchema = z.object({
  executionManifest: boundedExecutionManifestRefSchema,
  nativeCheckpointRef: nativeCheckpointRefSchema,
  productIdentityRef: checkpointProductIdentitySchema,
}).strict();

const migrationSchema = z.object({
  migrationId: identifierSchema,
  rollbackRef: identifierSchema,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("metadata"), versions: versionRefSchema }).strict(),
    z.object({ kind: z.literal("legacy"), executionManifest: boundedExecutionManifestRefSchema }).strict(),
  ]),
  target: versionRefSchema,
}).strict();

export const checkpointCompatibilityPolicySchema = z.object({
  adapterId: identifierSchema,
  executionManifest: boundedExecutionManifestRefSchema,
  nativeCheckpointRef: nativeCheckpointRefSchema,
  productIdentityRef: checkpointProductIdentitySchema,
  supportedRuntimeVersions: z.array(runtimeVersionSetSchema),
  incompatibleRuntimeVersions: z.array(runtimeVersionSetSchema).default([]),
  supportedAdapters: z.array(adapterVersionRefSchema),
  incompatibleAdapters: z.array(adapterVersionRefSchema).default([]),
  migrations: z.array(migrationSchema).default([]),
}).strict();

export type CheckpointAdapterMetadataV1 = z.infer<typeof checkpointAdapterMetadataV1Schema>;
export type CheckpointCompatibilityPolicy = z.input<typeof checkpointCompatibilityPolicySchema>;
export type CheckpointMigration = z.infer<typeof migrationSchema>;
type ParsedPolicy = z.output<typeof checkpointCompatibilityPolicySchema>;

export type CheckpointCompatibilityReason =
  | "CHECKPOINT_METADATA_INVALID" | "CHECKPOINT_POLICY_INVALID"
  | "CHECKPOINT_IDENTITY_CONFLICT" | "CHECKPOINT_MANIFEST_INCOMPATIBLE"
  | "CHECKPOINT_ADAPTER_INCOMPATIBLE" | "CHECKPOINT_ADAPTER_UNKNOWN"
  | "CHECKPOINT_MIGRATION_REQUIRED" | "CHECKPOINT_LEGACY_UNVERIFIED"
  | "RUNTIME_VERSION_INCOMPATIBLE" | "RUNTIME_VERSION_UNTESTED";

export type CheckpointCompatibility =
  | { status: "compatible"; action: "resume"; metadata: CheckpointAdapterMetadataV1 }
  | { status: "migratable"; action: "migrate_then_recheck"; migrationId: string; rollbackRef: string }
  | { status: "unknown" | "incompatible"; action: "park"; reasonCode: CheckpointCompatibilityReason };

function park(status: "unknown" | "incompatible", reasonCode: CheckpointCompatibilityReason): CheckpointCompatibility {
  return { status, action: "park", reasonCode };
}

function equalReference(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function adapterReference(versions: z.infer<typeof versionRefSchema>) {
  return { adapterId: versions.adapterId, adapterVersion: versions.adapterVersion, stateSchemaVersion: versions.stateSchemaVersion };
}

function versionReference(metadata: CheckpointAdapterMetadataV1) {
  return { ...adapterReference(metadata), executionManifest: metadata.executionManifest, runtimeVersions: metadata.runtimeVersions };
}

function isIdentityCompatible(checkpoint: z.infer<typeof legacyCheckpointSchema>, policy: ParsedPolicy): boolean {
  return equalReference(checkpoint.nativeCheckpointRef, policy.nativeCheckpointRef)
    && equalReference(checkpoint.productIdentityRef, policy.productIdentityRef);
}

function isMigrationTargetSupported(migration: CheckpointMigration, policy: ParsedPolicy): boolean {
  const target = migration.target;
  const adapter = adapterReference(target);
  return target.adapterId === policy.adapterId
    && equalReference(target.executionManifest, policy.executionManifest)
    && policy.supportedAdapters.some((supported) => equalReference(supported, adapter))
    && !policy.incompatibleAdapters.some((incompatible) => equalReference(incompatible, adapter))
    && evaluateRuntimeVersionCompatibility({ observed: target.runtimeVersions, supported: policy.supportedRuntimeVersions, explicitlyIncompatible: policy.incompatibleRuntimeVersions }).status === "compatible";
}

function migrationOutcome(migrations: CheckpointMigration[], policy: ParsedPolicy): CheckpointCompatibility {
  const supported = migrations.filter((migration) => isMigrationTargetSupported(migration, policy));
  if (supported.length !== 1) return park("unknown", "CHECKPOINT_MIGRATION_REQUIRED");
  return { status: "migratable", action: "migrate_then_recheck", migrationId: supported[0].migrationId, rollbackRef: supported[0].rollbackRef };
}

export function evaluateCheckpointAdapterCompatibility(
  metadataValue: unknown,
  policyValue: CheckpointCompatibilityPolicy,
  legacyValue?: unknown,
): CheckpointCompatibility {
  const parsedPolicy = checkpointCompatibilityPolicySchema.safeParse(policyValue);
  if (!parsedPolicy.success) return park("unknown", "CHECKPOINT_POLICY_INVALID");
  const policy = parsedPolicy.data;
  if (metadataValue === undefined) {
    const parsedLegacy = legacyCheckpointSchema.safeParse(legacyValue);
    if (!parsedLegacy.success) return park("unknown", "CHECKPOINT_LEGACY_UNVERIFIED");
    const legacy = parsedLegacy.data;
    if (!isIdentityCompatible(legacy, policy)) return park("incompatible", "CHECKPOINT_IDENTITY_CONFLICT");
    if (classifyExecutionManifestCompatibility(legacy.executionManifest, policy.executionManifest) === "incompatible") return park("incompatible", "CHECKPOINT_MANIFEST_INCOMPATIBLE");
    return migrationOutcome(policy.migrations.filter((migration) => migration.source.kind === "legacy" && equalReference(migration.source.executionManifest, legacy.executionManifest)), policy);
  }
  const parsedMetadata = checkpointAdapterMetadataV1Schema.safeParse(metadataValue);
  if (!parsedMetadata.success) return park("unknown", "CHECKPOINT_METADATA_INVALID");
  const metadata = parsedMetadata.data;
  if (!isIdentityCompatible(metadata, policy)) return park("incompatible", "CHECKPOINT_IDENTITY_CONFLICT");
  const manifestCompatibility = classifyExecutionManifestCompatibility(metadata.executionManifest, policy.executionManifest);
  if (manifestCompatibility === "incompatible") return park("incompatible", "CHECKPOINT_MANIFEST_INCOMPATIBLE");
  const runtimeCompatibility = evaluateRuntimeVersionCompatibility({ observed: metadata.runtimeVersions, supported: policy.supportedRuntimeVersions, explicitlyIncompatible: policy.incompatibleRuntimeVersions });
  if (runtimeCompatibility.status !== "compatible") return park(runtimeCompatibility.status, runtimeCompatibility.errorCode);
  const adapter = adapterReference(metadata);
  if (metadata.adapterId !== policy.adapterId || policy.incompatibleAdapters.some((incompatible) => equalReference(incompatible, adapter))) return park("incompatible", "CHECKPOINT_ADAPTER_INCOMPATIBLE");
  const isAdapterSupported = policy.supportedAdapters.some((supported) => equalReference(supported, adapter));
  if (manifestCompatibility === "compatible" && isAdapterSupported) return { status: "compatible", action: "resume", metadata };
  const migrations = policy.migrations.filter((migration) => migration.source.kind === "metadata" && equalReference(migration.source.versions, versionReference(metadata)));
  if (migrations.length > 0) return migrationOutcome(migrations, policy);
  return park("unknown", isAdapterSupported ? "CHECKPOINT_MIGRATION_REQUIRED" : "CHECKPOINT_ADAPTER_UNKNOWN");
}
