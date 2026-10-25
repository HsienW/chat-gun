import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../../runtime/persistence/rows.js";
import {
  BUILT_IN_MCP_RISK_DESCRIPTORS,
  createLocalToolRiskPolicies,
  createRuntimeToolAuthorizationComposition,
  createToolAuthorizationConfig,
  LOCAL_PRODUCTION_TOOL_NAMES,
  PRODUCTION_TOOL_AUTHORIZATION_POLICY_VERSION,
} from "./tool-authorization.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
    "utf8"
  )
) as { validContext: Record<string, unknown> };

function createDatabase(): Queryable {
  return {
    async query<TResult extends Record<string, unknown>>() {
      return { rows: [] as TResult[], rowCount: 0 };
    },
  };
}

describe("createToolAuthorizationConfig", () => {
  it("assembles production dependencies and reads the canonical execution context", async () => {
    const config = createToolAuthorizationConfig({
      profile: "production",
      policyVersion: "runtime-authorization-v1",
      db: createDatabase(),
      policies: createLocalToolRiskPolicies(),
    });

    expect(config.policyVersion).toBe("runtime-authorization-v1");
    expect(config.riskRegistry.classify("unknown", "tool:read")).toMatchObject({
      effect: "deny",
      reasonCode: "UNREGISTERED_TOOL_DENIED",
    });
    expect(
      config.resolveExecutionContext?.({
        configurable: { execution_context: fixture.validContext },
      })
    ).toMatchObject(fixture.validContext);
  });

  it("allows an unregistered read default only through an explicit development flag", () => {
    const disabled = createToolAuthorizationConfig({
      profile: "development",
      enableDevelopmentReadDefault: false,
      policyVersion: "runtime-authorization-v1",
      db: createDatabase(),
      policies: [],
    });
    const enabled = createToolAuthorizationConfig({
      profile: "development",
      enableDevelopmentReadDefault: true,
      policyVersion: "runtime-authorization-v1",
      db: createDatabase(),
      policies: [],
    });

    expect(disabled.riskRegistry.classify("unknown", "tool:read").effect).toBe(
      "deny"
    );
    expect(enabled.riskRegistry.classify("unknown", "tool:read").effect).toBe(
      "allow"
    );
  });

  it("fails closed for an unknown profile or empty policy version", () => {
    expect(() =>
      createToolAuthorizationConfig({
        profile: "staging" as "production",
        policyVersion: "runtime-authorization-v1",
        db: createDatabase(),
        policies: [],
      })
    ).toThrow("Unknown tool authorization profile");
    expect(() =>
      createToolAuthorizationConfig({
        profile: "production",
        policyVersion: " ",
        db: createDatabase(),
        policies: [],
      })
    ).toThrow("policyVersion");
  });
});

describe("local production ToolRiskPolicy registry", () => {
  it("declares every local production tool exactly once", () => {
    const policies = createLocalToolRiskPolicies();
    expect(policies.map((policy) => policy.toolName).sort()).toEqual(
      [...LOCAL_PRODUCTION_TOOL_NAMES].sort()
    );
    expect(new Set(policies.map((policy) => policy.toolName)).size).toBe(
      policies.length
    );
  });

  it("assembles one runtime composition with an explicit policy version", () => {
    const composition = createRuntimeToolAuthorizationComposition({
      profile: "production",
      db: createDatabase(),
    });

    expect(composition.authorization.policyVersion).toBe(
      PRODUCTION_TOOL_AUTHORIZATION_POLICY_VERSION
    );
    expect(
      composition.authorization.riskRegistry.classify("read_file", "tool:read")
    ).toMatchObject({ effect: "allow" });
    expect(
      composition.authorization.riskRegistry.classify("unknown_mcp", "tool:read")
    ).toMatchObject({ effect: "deny", reasonCode: "UNREGISTERED_TOOL_DENIED" });
  });

  it("declares versioned descriptors for both built-in MCP servers", () => {
    expect(
      new Set(BUILT_IN_MCP_RISK_DESCRIPTORS.map(({ serverName }) => serverName))
    ).toEqual(new Set(["filesystem", "brave_search"]));
    expect(
      BUILT_IN_MCP_RISK_DESCRIPTORS.every(
        ({ schemaVersion }) => schemaVersion === "1.0"
      )
    ).toBe(true);
  });
});

describe("runtime confirmation timeout", () => {
  const decision = {
    decisionId: "decision-timeout",
    effect: "require_confirmation" as const,
    reasonCode: "REQUIRES_CONFIRMATION" as const,
    createdAt: "2026-10-25T12:00:00.000Z",
  };
  const request = {
    action: "tool:write",
    resource: { resourceType: "tool", resourceId: "order_refund_request", tenantId: "tenant-1" },
    context: { toolName: "order_refund_request" },
  };
  const context = {
    ...fixture.validContext,
    principal: { ...(fixture.validContext.principal as Record<string, unknown>), tenantId: "tenant-1" },
    scope: { scopeId: "tenant-1", scopeType: "tenant", tenantId: "tenant-1" },
  };

  async function expiresInMs(): Promise<number> {
    const composition = createRuntimeToolAuthorizationComposition({ profile: "production", db: createDatabase() });
    const descriptor = await composition.authorization.onRequireConfirmation!(
      decision as never,
      request as never,
      context as never
    );
    return Date.parse(descriptor.expiresAt) - Date.parse("2026-10-25T12:00:00.000Z");
  }

  it("defaults to 15 minutes and follows a configured short timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    try {
      vi.stubEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", undefined);
      await expect(expiresInMs()).resolves.toBe(900_000);
      vi.stubEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", "1000");
      await expect(expiresInMs()).resolves.toBe(1_000);
      vi.stubEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", "0");
      await expect(expiresInMs()).rejects.toThrow("Invalid TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS");
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
