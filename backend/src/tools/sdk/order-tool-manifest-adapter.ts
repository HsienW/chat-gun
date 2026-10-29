import { isDeepStrictEqual } from "node:util";

import { MANIFEST_SCHEMA_VERSION, type ToolManifest } from "@gun-ai/harness-contracts";
import { registerTool, type RegistrationFailureCode } from "@gun-ai/harness-sdk";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { defaultToolPolicy } from "../../platform/tool-governance.js";
import type { ToolRiskPolicy } from "../../runtime/authorization/tool-risk.js";
import type { ExecutionProfileRegistry } from "../../runtime/tool-dispatch/execution-profile.js";
import type { RuntimeToolDescriptor } from "../../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { DEFAULT_RETRY_POLICY } from "../../runtime/retry/retry-policy.js";
import { COMMERCE_DATA_CLASSIFICATION } from "../orders/order-contracts.js";
import { ORDER_TOOL_NAMES } from "../orders/order-tools.js";
import { assertHostManifestVersionCompatible } from "./manifest-version-compatibility.js";

/** Approval policy key for tools whose risk policy requires a durable human confirmation (T0 §8). */
export const HUMAN_CONFIRMATION_APPROVAL_POLICY_KEY = "human_confirmation_required";

export type OrderToolRegistrationFailureCode =
  | RegistrationFailureCode
  | "HOST_DESCRIPTOR_MISMATCH"
  | "HOST_POLICY_MISSING"
  | "HOST_PROFILE_MISSING"
  | "HOST_TIMEOUT_RETRY_UNSUPPORTED";

export class OrderToolRegistrationError extends Error {
  readonly name = "OrderToolRegistrationError";

  constructor(
    readonly code: OrderToolRegistrationFailureCode,
    readonly toolId?: string
  ) {
    super(toolId ? `${code}: ${toolId}` : code);
  }
}

export interface OrderToolRegistrationInput {
  readonly tool: StructuredToolInterface;
  readonly descriptor: RuntimeToolDescriptor<unknown, unknown>;
  readonly riskPolicy: ToolRiskPolicy | null;
  readonly profileRegistry: ExecutionProfileRegistry;
}

export interface OrderToolManifestEvidence {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly manifestVersion: string;
  readonly sideEffectClass: string;
  readonly dataClassification: string;
}

/** Builds the X27 manifest; every field resolves from a trusted host contract or fails closed. */
export function createOrderToolManifest(input: OrderToolRegistrationInput): ToolManifest {
  const { tool, descriptor, riskPolicy, profileRegistry } = input;
  const isMutation = !descriptor.isReadOnly;
  if (
    !(ORDER_TOOL_NAMES as readonly string[]).includes(tool.name) ||
    descriptor.toolName !== tool.name ||
    !(descriptor.inputSchema instanceof z.ZodType) ||
    !(descriptor.outputSchema instanceof z.ZodType) ||
    descriptor.inputSchema !== tool.schema ||
    descriptor.secretRequirements !== undefined ||
    (isMutation
      ? descriptor.sideEffect?.reconcile === undefined || descriptor.interruptBehavior !== "reconcile_first"
      : descriptor.sideEffect !== undefined)
  ) {
    throw new OrderToolRegistrationError("HOST_DESCRIPTOR_MISMATCH", tool.name);
  }
  if (
    riskPolicy === null || riskPolicy.toolName !== tool.name ||
    riskPolicy.riskTier !== descriptor.riskTier ||
    riskPolicy.requireConfirmation !== isMutation ||
    riskPolicy.actions.length === 0
  ) {
    throw new OrderToolRegistrationError("HOST_POLICY_MISSING", tool.name);
  }
  const reference = descriptor.executionProfileRef;
  const profile = reference ? profileRegistry.resolve(reference) : null;
  if (
    reference === undefined || profile === null ||
    profile.mode !== "trusted_in_process" ||
    profile.egress.destinations.length !== 0 ||
    !isDeepStrictEqual(descriptor.egressRequirements, { destinations: [], protocols: [] })
  ) {
    throw new OrderToolRegistrationError("HOST_PROFILE_MISSING", tool.name);
  }
  if (
    descriptor.timeoutPolicy.timeoutMs !== defaultToolPolicy(tool.name).timeoutMs ||
    !isDeepStrictEqual(descriptor.retryPolicy, DEFAULT_RETRY_POLICY)
  ) {
    throw new OrderToolRegistrationError("HOST_TIMEOUT_RETRY_UNSUPPORTED", tool.name);
  }
  return {
    kind: "tool",
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    toolId: descriptor.toolName,
    toolVersion: descriptor.toolVersion,
    description: tool.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    sideEffectClass: isMutation ? "external_mutation" : "read-only",
    requiredCapabilities: [...riskPolicy.actions],
    executionProfile: {
      profileId: reference.profileId,
      profileVersion: reference.profileVersion,
      egress: { destinations: [], protocols: [] },
    },
    idempotency: isMutation
      ? { kind: "business_effect_key", descriptorRef: `${descriptor.toolName}@${descriptor.toolVersion}#side-effect` }
      : { kind: "read_only" },
    // After approval a mutation dispatches once (maxAttempts = 1, design §5.1).
    approvalPolicyKey: isMutation ? HUMAN_CONFIRMATION_APPROVAL_POLICY_KEY : "none",
    timeoutRetryClass: isMutation ? "mutation-single-attempt-after-approval-v1" : "local-read-default-v1",
    compensation: isMutation ? "reconcile_only" : "none",
    dataClassification: COMMERCE_DATA_CLASSIFICATION,
  };
}

/** Registers a manifest through the SDK; any missing or invalid field fails closed. */
export async function registerOrderToolManifest(
  manifest: unknown,
  descriptor: RuntimeToolDescriptor<unknown, unknown>
): Promise<{ descriptor: RuntimeToolDescriptor<unknown, unknown>; evidence: OrderToolManifestEvidence }> {
  const result = await registerTool({ manifest });
  if (!result.ok) {
    throw new OrderToolRegistrationError(result.error.code, result.error.toolId ?? descriptor.toolName);
  }
  const registered = result.value.manifest;
  assertHostManifestVersionCompatible(registered.manifestVersion, registered.toolId);
  if (registered.toolId !== descriptor.toolName || registered.toolVersion !== descriptor.toolVersion) {
    throw new OrderToolRegistrationError("HOST_DESCRIPTOR_MISMATCH", descriptor.toolName);
  }
  return {
    descriptor: {
      ...descriptor,
      inputSchema: registered.inputSchema,
      outputSchema: registered.outputSchema,
      manifestVersion: registered.manifestVersion,
    },
    evidence: {
      toolId: registered.toolId,
      toolVersion: registered.toolVersion,
      manifestVersion: registered.manifestVersion,
      sideEffectClass: registered.sideEffectClass,
      dataClassification: registered.dataClassification,
    },
  };
}

export async function stageOrderToolSdkDescriptor(
  input: OrderToolRegistrationInput
): Promise<{ descriptor: RuntimeToolDescriptor<unknown, unknown>; evidence: OrderToolManifestEvidence }> {
  return registerOrderToolManifest(createOrderToolManifest(input), input.descriptor);
}
