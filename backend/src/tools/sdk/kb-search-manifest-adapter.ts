import { isDeepStrictEqual } from "node:util";

import { MANIFEST_SCHEMA_VERSION } from "@gun-ai/harness-contracts";
import { registerTool, type RegistrationFailureCode } from "@gun-ai/harness-sdk";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { CORPUS_DATA_CLASSIFICATION } from "../../knowledge/corpus.js";
import { defaultToolPolicy } from "../../platform/tool-governance.js";
import type { ToolRiskPolicy } from "../../runtime/authorization/tool-risk.js";
import type { ExecutionProfileRegistry } from "../../runtime/tool-dispatch/execution-profile.js";
import type { RuntimeToolDescriptor } from "../../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { DEFAULT_RETRY_POLICY } from "../../runtime/retry/retry-policy.js";
import { KB_SEARCH_SECRET_REFERENCE, KB_SEARCH_TOOL_NAME } from "../kb-search.js";
import { assertHostManifestVersionCompatible } from "./manifest-version-compatibility.js";

export type KbSearchRegistrationFailureCode =
  | RegistrationFailureCode
  | "HOST_DESCRIPTOR_MISMATCH"
  | "HOST_POLICY_MISSING"
  | "HOST_PROFILE_MISSING"
  | "HOST_SECRET_MISSING"
  | "HOST_TIMEOUT_RETRY_UNSUPPORTED";

export class KbSearchRegistrationError extends Error {
  readonly name = "KbSearchRegistrationError";

  constructor(readonly code: KbSearchRegistrationFailureCode) {
    super(code);
  }
}

export interface KbSearchRegistrationInput {
  readonly tool: StructuredToolInterface;
  readonly descriptor: RuntimeToolDescriptor<unknown, string>;
  readonly riskPolicy: ToolRiskPolicy | null;
  readonly profileRegistry: ExecutionProfileRegistry;
}

/** Declares kb_search through the X27 SDK manifest; every field resolves from a trusted host contract. */
export async function stageKbSearchSdkDescriptor(
  input: KbSearchRegistrationInput
): Promise<RuntimeToolDescriptor<unknown, string>> {
  const { tool, descriptor, riskPolicy, profileRegistry } = input;
  if (
    tool.name !== KB_SEARCH_TOOL_NAME ||
    descriptor.toolName !== tool.name ||
    !(descriptor.inputSchema instanceof z.ZodType) ||
    !(descriptor.outputSchema instanceof z.ZodType) ||
    descriptor.inputSchema !== tool.schema ||
    !descriptor.isReadOnly ||
    descriptor.sideEffect !== undefined
  ) {
    throw new KbSearchRegistrationError("HOST_DESCRIPTOR_MISMATCH");
  }
  if (
    riskPolicy === null || riskPolicy.toolName !== tool.name ||
    riskPolicy.riskTier !== descriptor.riskTier || riskPolicy.requireConfirmation ||
    riskPolicy.actions.length === 0
  ) {
    throw new KbSearchRegistrationError("HOST_POLICY_MISSING");
  }
  if (
    descriptor.secretRequirements?.length !== 1 ||
    !isDeepStrictEqual(descriptor.secretRequirements[0], KB_SEARCH_SECRET_REFERENCE)
  ) {
    throw new KbSearchRegistrationError("HOST_SECRET_MISSING");
  }
  const reference = descriptor.executionProfileRef;
  const profile = reference ? profileRegistry.resolve(reference) : null;
  if (
    reference === undefined || profile === null ||
    profile.mode !== "trusted_in_process" ||
    profile.egress.destinations.length === 0 ||
    !isDeepStrictEqual(descriptor.egressRequirements, {
      destinations: profile.egress.destinations,
      protocols: profile.egress.protocols,
    })
  ) {
    throw new KbSearchRegistrationError("HOST_PROFILE_MISSING");
  }
  const hostTimeout = defaultToolPolicy(tool.name).timeoutMs;
  if (
    descriptor.timeoutPolicy.timeoutMs !== hostTimeout ||
    !isDeepStrictEqual(descriptor.retryPolicy, DEFAULT_RETRY_POLICY)
  ) {
    throw new KbSearchRegistrationError("HOST_TIMEOUT_RETRY_UNSUPPORTED");
  }
  const manifest = {
    kind: "tool",
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    toolId: descriptor.toolName,
    toolVersion: descriptor.toolVersion,
    description: tool.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    sideEffectClass: "read-only",
    requiredCapabilities: [...riskPolicy.actions],
    executionProfile: {
      profileId: reference.profileId,
      profileVersion: reference.profileVersion,
      egress: {
        destinations: [...profile.egress.destinations],
        protocols: [...profile.egress.protocols],
      },
    },
    idempotency: { kind: "read_only" },
    approvalPolicyKey: "none",
    timeoutRetryClass: "local-read-default-v1",
    compensation: "none",
    dataClassification: CORPUS_DATA_CLASSIFICATION,
  };
  const result = await registerTool({ manifest });
  if (!result.ok) throw new KbSearchRegistrationError(result.error.code);
  assertHostManifestVersionCompatible(result.value.manifest.manifestVersion, result.value.manifest.toolId);
  return {
    ...descriptor,
    toolName: result.value.manifest.toolId,
    toolVersion: result.value.manifest.toolVersion,
    inputSchema: result.value.manifest.inputSchema,
    outputSchema: result.value.manifest.outputSchema,
    manifestVersion: result.value.manifest.manifestVersion,
  };
}
