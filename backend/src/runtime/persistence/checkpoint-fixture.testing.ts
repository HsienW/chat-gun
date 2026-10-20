import { createExecutionManifestRef } from "../recovery/execution-manifest.js";
import type { CheckpointAdapterMetadataV1, CheckpointCompatibilityPolicy } from "./checkpoint-adapter-metadata.js";

export function createCheckpointFixture(adapterId = "reference") {
  const metadata: CheckpointAdapterMetadataV1 = {
    schemaVersion: "1.0.0",
    adapterId,
    adapterVersion: "1.0.0",
    stateSchemaVersion: "1.0.0",
    executionManifest: createExecutionManifestRef({ graphId: "fixture", graphConfig: {} }),
    runtimeVersions: { schemaVersion: "20", eventVersion: "1.0.0", packageVersion: "0.1.0" },
    nativeCheckpointRef: { threadId: "thread-1", checkpointId: "checkpoint-1", checkpointNamespace: "" },
    productIdentityRef: { runId: "run-1", taskId: "task-1", stepId: "step-1", attempt: 1 },
  };
  const policy: CheckpointCompatibilityPolicy = {
    adapterId,
    executionManifest: metadata.executionManifest,
    nativeCheckpointRef: metadata.nativeCheckpointRef,
    productIdentityRef: metadata.productIdentityRef,
    supportedRuntimeVersions: [metadata.runtimeVersions],
    supportedAdapters: [{ adapterId, adapterVersion: "1.0.0", stateSchemaVersion: "1.0.0" }],
  };
  return { metadata, policy };
}
