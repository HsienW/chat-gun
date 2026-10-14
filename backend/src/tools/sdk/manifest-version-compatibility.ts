import {
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from "@gun-ai/harness-contracts";

import {
  assertResumeVersionCompatible,
  evaluateRuntimeVersionCompatibility,
  type RuntimeVersionSet,
} from "../../runtime/persistence/version-compatibility.js";

/** Reviewed X26 tuple for the current backend release; extend only after cross-repo verification. */
const HOST_RUNTIME_VERSION: RuntimeVersionSet = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  eventVersion: RUNTIME_EVENT_SCHEMA_VERSION,
  packageVersion: "0.1.0",
};

const SUPPORTED_RUNTIME_VERSIONS: readonly RuntimeVersionSet[] = [
  HOST_RUNTIME_VERSION,
  { ...HOST_RUNTIME_VERSION, manifestVersion: MANIFEST_SCHEMA_VERSION },
];

export function assertHostManifestVersionCompatible(
  manifestVersion: string | undefined,
  toolId: string
): void {
  const observed = {
    ...HOST_RUNTIME_VERSION,
    ...(manifestVersion === undefined ? {} : { manifestVersion }),
  };
  assertResumeVersionCompatible(
    evaluateRuntimeVersionCompatibility({
      observed,
      supported: SUPPORTED_RUNTIME_VERSIONS,
    }),
    { correlation: { toolId } }
  );
}
