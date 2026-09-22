import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
