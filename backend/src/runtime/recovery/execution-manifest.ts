import { createHash } from "node:crypto";

import { AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION } from "../authorization/confirmation.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../event-envelope.js";
import { NORMALIZED_AGENT_INPUT_SCHEMA_VERSION } from "../input/normalized-agent-input.js";
import {
  executionManifestRefSchema,
  type ExecutionManifestRef,
} from "./interrupt-manifest.js";

export const EXECUTION_MANIFEST_VERSION = "1.0.0" as const;
export const TOOL_DESCRIPTOR_SCHEMA_VERSION = "1.0" as const;

export type ExecutionManifestCompatibility =
  | "compatible"
  | "migratable"
  | "incompatible";

export interface CreateExecutionManifestRefInput {
  graphId: string;
  graphConfig: unknown;
  deploymentVersion?: string;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function majorVersion(version: string): number {
  return Number(version.split(".", 1)[0]);
}

export function createExecutionManifestRef(
  input: CreateExecutionManifestRefInput
): ExecutionManifestRef {
  return executionManifestRefSchema.parse({
    manifestVersion: EXECUTION_MANIFEST_VERSION,
    graphId: input.graphId,
    graphConfigHash: createHash("sha256")
      .update(stableSerialize(input.graphConfig))
      .digest("hex"),
    ...(input.deploymentVersion
      ? { deploymentVersion: input.deploymentVersion }
      : {}),
    schemaVersions: {
      runtimeEventEnvelope: RUNTIME_EVENT_SCHEMA_VERSION,
      toolDescriptor: TOOL_DESCRIPTOR_SCHEMA_VERSION,
      authorizationPolicy: AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION,
      normalizedInput: NORMALIZED_AGENT_INPUT_SCHEMA_VERSION,
    },
  });
}

export function classifyExecutionManifestCompatibility(
  persistedValue: unknown,
  currentValue: unknown
): ExecutionManifestCompatibility {
  const persisted = executionManifestRefSchema.parse(persistedValue);
  const current = executionManifestRefSchema.parse(currentValue);
  if (
    majorVersion(persisted.manifestVersion) !==
      majorVersion(current.manifestVersion) ||
    persisted.graphId !== current.graphId ||
    persisted.graphConfigHash !== current.graphConfigHash
  ) {
    return "incompatible";
  }
  const schemaKeys = Object.keys(
    persisted.schemaVersions
  ) as Array<keyof ExecutionManifestRef["schemaVersions"]>;
  const hasSchemaDifference = schemaKeys.some(
    (key) => persisted.schemaVersions[key] !== current.schemaVersions[key]
  );
  const hasSchemaMajorDifference = schemaKeys.some(
    (key) =>
      majorVersion(persisted.schemaVersions[key]) !==
      majorVersion(current.schemaVersions[key])
  );
  if (hasSchemaMajorDifference) return "incompatible";
  return hasSchemaDifference ? "migratable" : "compatible";
}
