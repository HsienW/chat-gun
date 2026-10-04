import { z } from "zod";

import type { ExecutionContext } from "../execution-context/execution-context.js";
import { readCanonicalExecutionContext } from "../execution-context/read-execution-context.js";
import type { ToolExecutionTerminationCause } from "../side-effect/governed-outcome.js";
import {
  withResolvedSecrets,
  type SecretBrokerPort,
  type SecretReference,
} from "./secret-broker.js";

export const EXECUTION_PROFILE_VERSION = "1.0" as const;

export const EXECUTION_PROFILE_ERROR_CODES = {
  missing: "EXECUTION_PROFILE_MISSING",
  versionUnsupported: "EXECUTION_PROFILE_VERSION_UNSUPPORTED",
  invalid: "EXECUTION_PROFILE_INVALID",
  runnerUnavailable: "SANDBOX_RUNNER_UNAVAILABLE",
  capabilityInsufficient: "SANDBOX_CAPABILITY_INSUFFICIENT",
  startupFailed: "SANDBOX_STARTUP_FAILED",
  terminationFailed: "SANDBOX_TERMINATION_FAILED",
  secretUnresolvable: "SECRET_REFERENCE_UNRESOLVABLE",
  egressDenied: "EGRESS_DENIED",
  egressPolicyUnavailable: "EGRESS_POLICY_UNAVAILABLE",
} as const;

export type ExecutionProfileErrorCode =
  (typeof EXECUTION_PROFILE_ERROR_CODES)[keyof typeof EXECUTION_PROFILE_ERROR_CODES];

export const executionModeSchema = z.enum([
  "trusted_in_process",
  "isolated_process",
]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const executionProfileReferenceSchema = z
  .object({
    profileId: z.string().min(1),
    profileVersion: z.literal(EXECUTION_PROFILE_VERSION),
  })
  .strict();
export type ExecutionProfileReference = z.infer<
  typeof executionProfileReferenceSchema
>;

export const egressRequirementsSchema = z
  .object({
    destinations: z.array(z.string().min(1)),
    protocols: z.array(z.enum(["http", "https"])),
  })
  .strict();
export type EgressRequirements = z.infer<typeof egressRequirementsSchema>;

export const executionProfileSchema = z
  .object({
    profileVersion: z.literal(EXECUTION_PROFILE_VERSION),
    mode: executionModeSchema,
    filesystem: z
      .object({
        roots: z.array(z.string()),
        writeMode: z.enum(["read_only", "append_only", "scoped_write"]),
      })
      .strict(),
    process: z
      .object({
        creation: z.enum(["allow", "deny"]),
      })
      .strict(),
    resources: z
      .object({
        cpuTimeMs: z.number().int().positive(),
        memoryBytes: z.number().int().positive(),
        diskBytes: z.number().int().nonnegative(),
        wallClockMs: z.number().int().positive(),
      })
      .strict(),
    egress: z
      .object({
        destinations: z.array(z.string().min(1)),
        protocols: z.array(z.enum(["http", "https"])),
        dns: z.literal("resolve_and_connect"),
      })
      .strict(),
    env: z
      .object({
        allowedVariables: z.array(z.string().min(1)),
      })
      .strict(),
    binaries: z
      .object({
        allowed: z.array(z.string().min(1)),
        runtimeImages: z.array(z.string().min(1)),
      })
      .strict(),
    output: z
      .object({
        maxBytes: z.number().int().positive(),
        artifactHandling: z.enum(["inline", "reference", "discard"]),
      })
      .strict(),
  })
  .strict();

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export type ParseExecutionProfileResult =
  | { type: "success"; profile: ExecutionProfile }
  | { type: "failure"; errorCode: ExecutionProfileErrorCode };

export function parseExecutionProfile(
  value: unknown
): ParseExecutionProfileResult {
  if (
    value !== null &&
    typeof value === "object" &&
    "profileVersion" in value &&
    value.profileVersion !== EXECUTION_PROFILE_VERSION
  ) {
    return {
      type: "failure",
      errorCode: EXECUTION_PROFILE_ERROR_CODES.versionUnsupported,
    };
  }
  const parsed = executionProfileSchema.safeParse(value);
  return parsed.success
    ? { type: "success", profile: parsed.data }
    : { type: "failure", errorCode: EXECUTION_PROFILE_ERROR_CODES.invalid };
}

export interface SandboxCapabilities {
  executionModes: readonly ExecutionMode[];
  supportsProcessIsolation: boolean;
  supportsFilesystemIsolation: boolean;
  supportsEgressIsolation: boolean;
  supportsResourceLimits: boolean;
}

export interface SandboxInvocation {
  toolName: string;
  input: unknown;
  executionContext: ExecutionContext;
  config: unknown;
  signal?: AbortSignal;
}

export type SandboxResult<TResult = unknown> =
  | { type: "succeeded"; result: TResult }
  | { type: "failed"; errorCode: ExecutionProfileErrorCode }
  | { type: "cancelled" };

export interface SandboxRunnerPort {
  capabilities(): SandboxCapabilities;
  run(
    invocation: SandboxInvocation,
    profile: ExecutionProfile
  ): Promise<SandboxResult>;
}

export interface EffectiveSandboxCapabilities {
  executionMode: ExecutionMode;
  processIsolation?: boolean;
  filesystemIsolation?: boolean;
  egressIsolation?: boolean;
  resourceLimits?: boolean;
}

export type CapabilityMatchResult =
  | {
      type: "allowed";
      profile: ExecutionProfile;
      effectiveCapabilities: EffectiveSandboxCapabilities;
    }
  | {
      type: "denied";
      errorCode: ExecutionProfileErrorCode;
      terminationCause: "unsupported" | "capability_mismatch";
    };

export function matchExecutionProfileCapabilities(
  profile: ExecutionProfile,
  runner?: SandboxRunnerPort
): CapabilityMatchResult {
  if (profile.mode === "trusted_in_process") {
    return {
      type: "allowed",
      profile,
      effectiveCapabilities: { executionMode: "trusted_in_process" },
    };
  }

  if (runner === undefined) {
    return {
      type: "denied",
      errorCode: EXECUTION_PROFILE_ERROR_CODES.runnerUnavailable,
      terminationCause: "unsupported",
    };
  }

  const capabilities = runner.capabilities();
  const requiresFilesystemIsolation =
    profile.filesystem.roots.length > 0 ||
    profile.filesystem.writeMode !== "read_only";
  const requiresEgressIsolation = profile.egress.destinations.length > 0;
  const hasRequiredCapabilities =
    capabilities.executionModes.includes("isolated_process") &&
    (profile.process.creation === "deny" ||
      capabilities.supportsProcessIsolation) &&
    (!requiresFilesystemIsolation ||
      capabilities.supportsFilesystemIsolation) &&
    (!requiresEgressIsolation || capabilities.supportsEgressIsolation) &&
    capabilities.supportsResourceLimits;

  if (!hasRequiredCapabilities) {
    return {
      type: "denied",
      errorCode: EXECUTION_PROFILE_ERROR_CODES.capabilityInsufficient,
      terminationCause: "capability_mismatch",
    };
  }

  return {
    type: "allowed",
    profile,
    effectiveCapabilities: {
      executionMode: "isolated_process",
      processIsolation: capabilities.supportsProcessIsolation,
      filesystemIsolation: capabilities.supportsFilesystemIsolation,
      egressIsolation: capabilities.supportsEgressIsolation,
      resourceLimits: capabilities.supportsResourceLimits,
    },
  };
}

export class ExecutionProfileRegistry {
  private readonly profiles = new Map<string, ExecutionProfile>();

  register(
    reference: ExecutionProfileReference,
    profile: ExecutionProfile
  ): void {
    const parsedReference = executionProfileReferenceSchema.parse(reference);
    const parsedProfile = executionProfileSchema.parse(profile);
    if (parsedReference.profileVersion !== parsedProfile.profileVersion) {
      throw new Error("Execution profile reference version mismatch");
    }
    if (this.profiles.has(parsedReference.profileId)) {
      throw new Error(`Duplicate execution profile: ${parsedReference.profileId}`);
    }
    this.profiles.set(parsedReference.profileId, parsedProfile);
  }

  resolve(reference: ExecutionProfileReference): ExecutionProfile | null {
    const parsedReference = executionProfileReferenceSchema.safeParse(reference);
    if (!parsedReference.success) return null;
    const profile = this.profiles.get(parsedReference.data.profileId);
    return profile?.profileVersion === parsedReference.data.profileVersion
      ? profile
      : null;
  }
}

export interface ExecutionProfileEvidence {
  executionProfileVersion: string;
  effectiveCapabilities: EffectiveSandboxCapabilities;
  secretRefsUsed: string[];
  egressDecision: null | {
    decision: "allow" | "deny";
    reasonCode: string;
  };
}

export type ExecutionProfileTerminationCause = ToolExecutionTerminationCause;

export interface ExecutionProfileEnforcementRequest {
  toolName: string;
  input: unknown;
  config: unknown;
}

export interface IsolatedExecutionPlan {
  mode: "isolated_process";
  profile: ExecutionProfile;
  runner: SandboxRunnerPort;
}

export type ExecutionProfileEnforcementResult =
  | { type: "disabled"; config: unknown }
  | {
      type: "allowed";
      config: unknown;
      evidence: ExecutionProfileEvidence;
      executionPlan?: IsolatedExecutionPlan;
    }
  | {
      type: "denied";
      errorCode: ExecutionProfileErrorCode;
      terminationCause: ExecutionProfileTerminationCause;
    };

export interface ExecutionProfileEnforcerPort {
  enforce(
    request: ExecutionProfileEnforcementRequest
  ): Promise<ExecutionProfileEnforcementResult>;
}

interface EnforcementDescriptor {
  executionProfileRef?: ExecutionProfileReference;
  secretRequirements?: readonly SecretReference[];
}

interface EnforcementDescriptorRegistry {
  resolve(toolName: string): EnforcementDescriptor | null;
}

export interface ExecutionProfileEnforcerDependencies {
  descriptorRegistry: EnforcementDescriptorRegistry;
  profileRegistry: ExecutionProfileRegistry;
  runner?: SandboxRunnerPort;
  secretBroker?: SecretBrokerPort;
  isEnabled?: () => boolean;
}

export const EXECUTION_PROFILE_ENFORCEMENT_MARKER: unique symbol = Symbol(
  "chat-gun.execution-profile-enforcement"
);
const ENFORCEMENT_CONTEXT: typeof EXECUTION_PROFILE_ENFORCEMENT_MARKER =
  EXECUTION_PROFILE_ENFORCEMENT_MARKER;

interface MarkedExecutionConfig extends Record<PropertyKey, unknown> {
  [ENFORCEMENT_CONTEXT]: {
    toolName: string;
    evidence: ExecutionProfileEvidence;
    executionPlan?: IsolatedExecutionPlan;
  };
}

function readEnforcementContext(
  config: unknown,
  toolName: string
): MarkedExecutionConfig[typeof ENFORCEMENT_CONTEXT] | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const marked = config as Partial<MarkedExecutionConfig>;
  const context = marked[ENFORCEMENT_CONTEXT];
  return context?.toolName === toolName ? context : undefined;
}

function markExecutionConfig(
  config: unknown,
  toolName: string,
  evidence: ExecutionProfileEvidence,
  executionPlan?: IsolatedExecutionPlan
): MarkedExecutionConfig {
  const base =
    config !== null && typeof config === "object"
      ? (config as Record<PropertyKey, unknown>)
      : {};
  return {
    ...base,
    [ENFORCEMENT_CONTEXT]: {
      toolName,
      evidence,
      ...(executionPlan ? { executionPlan } : {}),
    },
  };
}

export class ExecutionProfileEnforcer
  implements ExecutionProfileEnforcerPort
{
  constructor(
    private readonly dependencies: ExecutionProfileEnforcerDependencies
  ) {}

  async enforce(
    request: ExecutionProfileEnforcementRequest
  ): Promise<ExecutionProfileEnforcementResult> {
    const descriptor = this.dependencies.descriptorRegistry.resolve(
      request.toolName
    );
    if (!(this.dependencies.isEnabled?.() ?? false)) {
      const secretResolution = await this.resolveSecrets(
        request,
        descriptor?.secretRequirements ?? []
      );
      if (secretResolution.type === "denied") return secretResolution;
      return { type: "disabled", config: secretResolution.config };
    }

    const existingContext = readEnforcementContext(request.config, request.toolName);
    if (existingContext !== undefined) {
      return {
        type: "allowed",
        config: request.config,
        evidence: existingContext.evidence,
        ...(existingContext.executionPlan
          ? { executionPlan: existingContext.executionPlan }
          : {}),
      };
    }

    if (descriptor?.executionProfileRef === undefined) {
      return {
        type: "denied",
        errorCode: EXECUTION_PROFILE_ERROR_CODES.missing,
        terminationCause: "profile_missing",
      };
    }

    const profile = this.dependencies.profileRegistry.resolve(
      descriptor.executionProfileRef
    );
    if (profile === null) {
      return {
        type: "denied",
        errorCode: EXECUTION_PROFILE_ERROR_CODES.versionUnsupported,
        terminationCause: "profile_version_unsupported",
      };
    }

    const capabilityMatch = matchExecutionProfileCapabilities(
      profile,
      this.dependencies.runner
    );
    if (capabilityMatch.type === "denied") {
      return capabilityMatch;
    }

    const secretResolution = await this.resolveSecrets(
      request,
      descriptor.secretRequirements ?? []
    );
    if (secretResolution.type === "denied") return secretResolution;

    const executionPlan =
      profile.mode === "isolated_process" && this.dependencies.runner
        ? {
            mode: "isolated_process" as const,
            profile,
            runner: this.dependencies.runner,
          }
        : undefined;

    const evidence: ExecutionProfileEvidence = {
      executionProfileVersion: profile.profileVersion,
      effectiveCapabilities: capabilityMatch.effectiveCapabilities,
      secretRefsUsed: secretResolution.secretRefsUsed,
      egressDecision: null,
    };
    return {
      type: "allowed",
      config: markExecutionConfig(
        secretResolution.config,
        request.toolName,
        evidence,
        executionPlan
      ),
      evidence,
      ...(executionPlan ? { executionPlan } : {}),
    };
  }

  private async resolveSecrets(
    request: ExecutionProfileEnforcementRequest,
    requirements: readonly SecretReference[]
  ): Promise<
    | { type: "resolved"; config: unknown; secretRefsUsed: string[] }
    | Extract<ExecutionProfileEnforcementResult, { type: "denied" }>
  > {
    if (requirements.length === 0) {
      return { type: "resolved", config: request.config, secretRefsUsed: [] };
    }
    const executionContext = readCanonicalExecutionContext(request.config);
    if (executionContext === undefined || this.dependencies.secretBroker === undefined) {
      return {
        type: "denied",
        errorCode: EXECUTION_PROFILE_ERROR_CODES.secretUnresolvable,
        terminationCause: "secret_unresolvable",
      };
    }

    const credentials: Record<string, string> = {};
    try {
      for (const requirement of requirements) {
        const credential = await this.dependencies.secretBroker.resolve(
          requirement,
          executionContext
        );
        credentials[requirement.secretRef] = credential.value;
      }
    } catch {
      return {
        type: "denied",
        errorCode: EXECUTION_PROFILE_ERROR_CODES.secretUnresolvable,
        terminationCause: "secret_unresolvable",
      };
    }

    return {
      type: "resolved",
      config: withResolvedSecrets(request.config, credentials),
      secretRefsUsed: requirements.map(({ secretRef }) => secretRef),
    };
  }
}
