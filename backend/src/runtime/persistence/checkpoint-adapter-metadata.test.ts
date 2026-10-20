import { describe, expect, it } from "vitest";

import { createCheckpointFixture } from "./checkpoint-fixture.testing.js";
import {
  checkpointAdapterMetadataV1Schema,
  evaluateCheckpointAdapterCompatibility,
  type CheckpointAdapterMetadataV1,
} from "./checkpoint-adapter-metadata.js";

describe.each(["langgraph", "reference"])("%s checkpoint metadata", (adapterId) => {
  it("uses the same strict schema and does not mutate a compatible checkpoint", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    const before = JSON.stringify(metadata);
    expect(evaluateCheckpointAdapterCompatibility(metadata, policy)).toMatchObject({ status: "compatible", action: "resume" });
    expect(JSON.stringify(metadata)).toBe(before);
  });

  it.each([
    { schemaVersion: "2.0.0" }, { adapterVersion: "unknown" }, { adapterVersion: undefined },
    { injected: true }, { productIdentityRef: { runId: "run-1", taskId: "task-1", stepId: "step-1" } },
    { nativeCheckpointRef: { threadId: "thread-1", checkpointId: "checkpoint-1" } },
    { productIdentityRef: { runId: "run-1", taskId: "task-1", attempt: 0 } },
    { adapterId: "a".repeat(257) },
  ])("parks invalid metadata %j", (override) => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    const candidate = { ...metadata, ...override };
    expect(checkpointAdapterMetadataV1Schema.safeParse(candidate).success).toBe(false);
    expect(evaluateCheckpointAdapterCompatibility(candidate, policy)).toMatchObject({ status: "unknown", action: "park" });
  });

  it("rejects identity conflicts before version evaluation", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    expect(evaluateCheckpointAdapterCompatibility({ ...metadata, productIdentityRef: { ...metadata.productIdentityRef, runId: "other" }, adapterVersion: "9.0.0" }, policy)).toMatchObject({ status: "incompatible", reasonCode: "CHECKPOINT_IDENTITY_CONFLICT" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...policy, nativeCheckpointRef: { ...policy.nativeCheckpointRef, checkpointNamespace: "other" } })).toMatchObject({ status: "incompatible", reasonCode: "CHECKPOINT_IDENTITY_CONFLICT" });
  });

  it("rejects nested unknown fields and oversized manifest versions", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    for (const candidate of [
      { ...metadata, executionManifest: { ...metadata.executionManifest, extra: true } },
      { ...metadata, runtimeVersions: { ...metadata.runtimeVersions, extra: true } },
      { ...metadata, executionManifest: { ...metadata.executionManifest, manifestVersion: `${"1".repeat(129)}.0` } },
    ]) expect(evaluateCheckpointAdapterCompatibility(candidate, policy)).toMatchObject({ status: "unknown", action: "park" });
  });

  it("requires explicit adapter upgrade and rollback paths and rejects ambiguity", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    const versions = ({ adapterId: id, adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions }: CheckpointAdapterMetadataV1) => ({ adapterId: id, adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions });
    const target = { ...metadata, adapterVersion: "2.0.0", stateSchemaVersion: "2.0.0" };
    const migration = { migrationId: "upgrade", rollbackRef: "rollback", source: { kind: "metadata" as const, versions: versions(metadata) }, target: versions(target) };
    const upgraded = { ...policy, supportedAdapters: [{ adapterId, adapterVersion: "2.0.0", stateSchemaVersion: "2.0.0" }], migrations: [migration] };
    expect(evaluateCheckpointAdapterCompatibility(metadata, upgraded)).toMatchObject({ status: "migratable" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...upgraded, migrations: [migration, { ...migration, migrationId: "ambiguous" }] })).toMatchObject({ status: "unknown", action: "park" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...upgraded, migrations: [{ ...migration, rollbackRef: "" }] })).toMatchObject({ status: "unknown", action: "park" });
    expect(evaluateCheckpointAdapterCompatibility(target, policy)).toMatchObject({ status: "unknown", action: "park" });
    expect(evaluateCheckpointAdapterCompatibility(target, { ...policy, migrations: [{ ...migration, migrationId: "downgrade", source: { kind: "metadata", versions: versions(target) }, target: versions(metadata) }] })).toMatchObject({ status: "migratable" });
  });

  it("uses manifest then runtime then adapter compatibility", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...policy, executionManifest: { ...metadata.executionManifest, graphId: "other" } })).toMatchObject({ status: "incompatible", reasonCode: "CHECKPOINT_MANIFEST_INCOMPATIBLE" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...policy, supportedRuntimeVersions: [] })).toMatchObject({ status: "unknown", reasonCode: "RUNTIME_VERSION_UNTESTED" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...policy, incompatibleRuntimeVersions: [metadata.runtimeVersions] })).toMatchObject({ status: "incompatible", reasonCode: "RUNTIME_VERSION_INCOMPATIBLE" });
    expect(evaluateCheckpointAdapterCompatibility({ ...metadata, stateSchemaVersion: "2.0.0" }, policy)).toMatchObject({ status: "unknown", action: "park" });
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...policy, incompatibleAdapters: policy.supportedAdapters })).toMatchObject({ status: "incompatible", action: "park" });
  });

  it("requires an exact registered reversible migration and never performs it", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    const target = { ...metadata, executionManifest: { ...metadata.executionManifest, schemaVersions: { ...metadata.executionManifest.schemaVersions, normalizedInput: "1.1.0" } } };
    const versionRef = ({ adapterId: id, adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions }: CheckpointAdapterMetadataV1) => ({ adapterId: id, adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions });
    const updatedPolicy = { ...policy, executionManifest: target.executionManifest };
    expect(evaluateCheckpointAdapterCompatibility(metadata, updatedPolicy)).toMatchObject({ status: "unknown", action: "park" });
    const before = JSON.stringify(metadata);
    expect(evaluateCheckpointAdapterCompatibility(metadata, { ...updatedPolicy, migrations: [{ migrationId: "upgrade-1", rollbackRef: "rollback-1", source: { kind: "metadata", versions: versionRef(metadata) }, target: versionRef(target) }] })).toMatchObject({ status: "migratable", action: "migrate_then_recheck", migrationId: "upgrade-1" });
    expect(JSON.stringify(metadata)).toBe(before);
  });

  it("parks legacy checkpoints unless trusted identity and a reversible migration are supplied", () => {
    const { metadata, policy } = createCheckpointFixture(adapterId);
    const legacy = { executionManifest: metadata.executionManifest };
    const before = JSON.stringify(legacy);
    expect(evaluateCheckpointAdapterCompatibility(undefined, policy, legacy)).toMatchObject({ status: "unknown", action: "park" });
    const { adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions } = metadata;
    const migration = { migrationId: "legacy-1", rollbackRef: "legacy-rollback", source: { kind: "legacy" as const, executionManifest }, target: { adapterId, adapterVersion, stateSchemaVersion, executionManifest, runtimeVersions } };
    expect(evaluateCheckpointAdapterCompatibility(undefined, { ...policy, migrations: [migration] }, { ...legacy, nativeCheckpointRef: metadata.nativeCheckpointRef, productIdentityRef: metadata.productIdentityRef })).toMatchObject({ status: "migratable", action: "migrate_then_recheck" });
    expect(evaluateCheckpointAdapterCompatibility(undefined, { ...policy, migrations: [migration] }, legacy)).toMatchObject({ status: "unknown", action: "park" });
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
