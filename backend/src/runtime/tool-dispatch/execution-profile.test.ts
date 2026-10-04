import { describe, expect, it, vi } from "vitest";

import {
  ExecutionProfileEnforcer,
  ExecutionProfileRegistry,
  executionProfileSchema,
  matchExecutionProfileCapabilities,
  parseExecutionProfile,
  type ExecutionProfile,
  type SandboxRunnerPort,
} from "./execution-profile.js";
import {
  readResolvedSecret,
  type SecretBrokerPort,
  type SecretReference,
} from "./secret-broker.js";

const trustedProfile: ExecutionProfile = {
  profileVersion: "1.0",
  mode: "trusted_in_process",
  filesystem: { roots: [], writeMode: "read_only" },
  process: { creation: "deny" },
  resources: {
    cpuTimeMs: 1_000,
    memoryBytes: 64 * 1024 * 1024,
    diskBytes: 0,
    wallClockMs: 15_000,
  },
  egress: {
    destinations: [],
    protocols: [],
    dns: "resolve_and_connect",
  },
  env: { allowedVariables: [] },
  binaries: { allowed: [], runtimeImages: [] },
  output: { maxBytes: 24_000, artifactHandling: "inline" },
};

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: "2026-10-03T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "principal" as const,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
  },
};

const secretReference: SecretReference = {
  secretRef: "env:TAVILY_API_KEY",
  secretName: "TAVILY_API_KEY",
  scope: "tool:web_search",
};

function createSecretEnforcer(isEnabled: boolean) {
  const profileRegistry = new ExecutionProfileRegistry();
  profileRegistry.register(
    { profileId: "web-search", profileVersion: "1.0" },
    trustedProfile
  );
  const secretBroker: SecretBrokerPort = {
    resolve: vi.fn(async () => ({ value: "test-secret-value" })),
  };
  return {
    secretBroker,
    enforcer: new ExecutionProfileEnforcer({
      descriptorRegistry: {
        resolve: () => ({
          executionProfileRef: {
            profileId: "web-search",
            profileVersion: "1.0",
          },
          secretRequirements: [secretReference],
        }),
      },
      profileRegistry,
      secretBroker,
      isEnabled: () => isEnabled,
    }),
  };
}

describe("ExecutionProfile", () => {
  it("parses a complete strict versioned profile", () => {
    expect(executionProfileSchema.parse(trustedProfile)).toEqual(trustedProfile);
  });

  it("fails closed for unknown fields", () => {
    expect(() =>
      executionProfileSchema.parse({ ...trustedProfile, implicitTrust: true })
    ).toThrow();
  });

  it("fails with a typed compatibility error for an unsupported version", () => {
    const parsed = parseExecutionProfile({
      ...trustedProfile,
      profileVersion: "2.0",
    });

    expect(parsed).toEqual({
      type: "failure",
      errorCode: "EXECUTION_PROFILE_VERSION_UNSUPPORTED",
    });
  });

  it.each(["trusted_in_process", "isolated_process"] as const)(
    "accepts the %s execution mode",
    (mode) => {
      expect(executionProfileSchema.parse({ ...trustedProfile, mode }).mode).toBe(
        mode
      );
    }
  );
});

describe("ExecutionProfileEnforcer", () => {
  it("injects only declared secret references at the final execution edge", async () => {
    const { enforcer, secretBroker } = createSecretEnforcer(true);
    const result = await enforcer.enforce({
      toolName: "web_search",
      input: {},
      config: { configurable: { execution_context: executionContext } },
    });

    expect(result.type).toBe("allowed");
    if (result.type !== "allowed") return;
    expect(secretBroker.resolve).toHaveBeenCalledWith(
      secretReference,
      executionContext
    );
    expect(readResolvedSecret(result.config, secretReference.secretRef)).toBe(
      "test-secret-value"
    );
    expect(result.evidence.secretRefsUsed).toEqual([
      secretReference.secretRef,
    ]);
    expect(JSON.stringify(result.config)).not.toContain("test-secret-value");
  });

  it("keeps broker injection active during an enforcement rollout", async () => {
    const { enforcer } = createSecretEnforcer(false);
    const result = await enforcer.enforce({
      toolName: "web_search",
      input: {},
      config: { configurable: { execution_context: executionContext } },
    });

    expect(result.type).toBe("disabled");
    if (result.type !== "disabled") return;
    expect(readResolvedSecret(result.config, secretReference.secretRef)).toBe(
      "test-secret-value"
    );
  });

  it("fails closed for a missing profile when enabled", async () => {
    const enforcer = new ExecutionProfileEnforcer({
      descriptorRegistry: { resolve: () => null },
      profileRegistry: new ExecutionProfileRegistry(),
      isEnabled: () => true,
    });

    await expect(
      enforcer.enforce({ toolName: "unknown", input: {}, config: {} })
    ).resolves.toEqual({
      type: "denied",
      errorCode: "EXECUTION_PROFILE_MISSING",
      terminationCause: "profile_missing",
    });
  });

  it("preserves the legacy path when the feature flag is disabled", async () => {
    const enforcer = new ExecutionProfileEnforcer({
      descriptorRegistry: { resolve: () => null },
      profileRegistry: new ExecutionProfileRegistry(),
      isEnabled: () => false,
    });

    const config = {};
    await expect(
      enforcer.enforce({ toolName: "unknown", input: {}, config })
    ).resolves.toEqual({ type: "disabled", config });
  });
});

describe("profile capability matching", () => {
  it("allows trusted_in_process without a runner while retaining the profile", () => {
    expect(matchExecutionProfileCapabilities(trustedProfile)).toMatchObject({
      type: "allowed",
      profile: trustedProfile,
      effectiveCapabilities: { executionMode: "trusted_in_process" },
    });
  });

  it("denies isolated_process when no runner exists", () => {
    expect(
      matchExecutionProfileCapabilities({
        ...trustedProfile,
        mode: "isolated_process",
        process: { creation: "allow" },
      })
    ).toEqual({
      type: "denied",
      errorCode: "SANDBOX_RUNNER_UNAVAILABLE",
      terminationCause: "unsupported",
    });
  });

  it("denies when runner capability is insufficient", () => {
    const runner: SandboxRunnerPort = {
      capabilities: () => ({
        executionModes: ["isolated_process"],
        supportsProcessIsolation: false,
        supportsFilesystemIsolation: true,
        supportsEgressIsolation: true,
        supportsResourceLimits: true,
      }),
      run: vi.fn(),
    };

    expect(
      matchExecutionProfileCapabilities(
        {
          ...trustedProfile,
          mode: "isolated_process",
          process: { creation: "allow" },
        },
        runner
      )
    ).toEqual({
      type: "denied",
      errorCode: "SANDBOX_CAPABILITY_INSUFFICIENT",
      terminationCause: "capability_mismatch",
    });
  });
});
