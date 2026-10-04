import { afterEach, describe, expect, it, vi } from "vitest";

import { getGovernedToolExecutor } from "../platform/tool-governance.js";
import { ToolRiskRegistry } from "../runtime/authorization/tool-risk.js";
import {
  ExecutionProfileEnforcer,
  ExecutionProfileRegistry,
  type SandboxRunnerPort,
} from "../runtime/tool-dispatch/execution-profile.js";
import {
  readResolvedSecret,
  type SecretBrokerPort,
} from "../runtime/tool-dispatch/secret-broker.js";
import { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { BUILT_IN_MCP_RISK_DESCRIPTORS } from "./authorization/tool-authorization.js";
import { loadMcpTools } from "./mcp-loader.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "tool-call-1",
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

describe("MCP isolated loader", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not spawn stdio and denies invocation when no sandbox runner exists", async () => {
    vi.stubEnv("MCP_FILESYSTEM_ENABLED", "true");
    vi.stubEnv("MCP_FILESYSTEM_PATH", process.cwd());
    vi.stubEnv("MCP_FILESYSTEM_ALLOWED_ROOTS", process.cwd());
    vi.stubEnv("MCP_BRAVE_SEARCH_ENABLED", "true");
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const descriptorRegistry = new RuntimeToolDescriptorRegistry();
    const profileRegistry = new ExecutionProfileRegistry();
    const enforcer = new ExecutionProfileEnforcer({
      descriptorRegistry,
      profileRegistry,
      isEnabled: () => true,
    });
    const loadStdio = vi.fn(async () => []);

    const tools = await loadMcpTools(
      {
        riskRegistry: new ToolRiskRegistry([], { unregisteredToolDefault: "deny" }),
        authorizationEngine: {
          authorize: vi.fn(async () => ({
            decisionId: "decision-1",
            effect: "allow" as const,
            reasonCode: "POLICY_ALLOWED" as const,
            createdAt: "2026-10-03T00:00:00.000Z",
          })),
        },
        decisionStore: { record: vi.fn(async () => undefined) },
        policyVersion: "test-policy-v1",
        resolveContext: () => ({
          principal: executionContext.principal,
          scope: executionContext.scope,
        }),
      },
      BUILT_IN_MCP_RISK_DESCRIPTORS,
      {
        descriptorRegistry,
        profileRegistry,
        executionProfileEnforcer: enforcer,
        isExecutionProfileEnforcementEnabled: () => true,
        loadStdioServerTools: loadStdio,
      }
    );

    expect(loadStdio).not.toHaveBeenCalled();
    const readFile = tools.find(({ name }) => name === "read_file");
    expect(readFile).toBeDefined();
    const outcome = await getGovernedToolExecutor(readFile!)?.executeTyped(
      { path: "readme.txt" },
      { configurable: { execution_context: executionContext } }
    );
    expect(outcome).toEqual({
      type: "rejected_before_dispatch",
      errorCode: "SANDBOX_RUNNER_UNAVAILABLE",
    });
  });

  it("executes through a runner and injects the Brave secret only at dispatch", async () => {
    vi.stubEnv("MCP_FILESYSTEM_ENABLED", "false");
    vi.stubEnv("MCP_BRAVE_SEARCH_ENABLED", "true");
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const descriptorRegistry = new RuntimeToolDescriptorRegistry();
    const profileRegistry = new ExecutionProfileRegistry();
    const secretBroker: SecretBrokerPort = {
      resolve: vi.fn(async () => ({ value: "brave-secret-value" })),
    };
    const runner: SandboxRunnerPort = {
      capabilities: () => ({
        executionModes: ["isolated_process"],
        supportsProcessIsolation: true,
        supportsFilesystemIsolation: true,
        supportsEgressIsolation: true,
        supportsResourceLimits: true,
      }),
      run: vi.fn(async (invocation) => ({
        type: "succeeded" as const,
        result: readResolvedSecret(invocation.config, "env:BRAVE_API_KEY"),
      })),
    };
    const enforcer = new ExecutionProfileEnforcer({
      descriptorRegistry,
      profileRegistry,
      runner,
      secretBroker,
      isEnabled: () => true,
    });

    const tools = await loadMcpTools(
      {
        riskRegistry: new ToolRiskRegistry([], { unregisteredToolDefault: "deny" }),
        authorizationEngine: {
          authorize: vi.fn(async () => ({
            decisionId: "decision-2",
            effect: "allow" as const,
            reasonCode: "POLICY_ALLOWED" as const,
            createdAt: "2026-10-03T00:00:00.000Z",
          })),
        },
        decisionStore: { record: vi.fn(async () => undefined) },
        policyVersion: "test-policy-v1",
        resolveContext: () => ({
          principal: executionContext.principal,
          scope: executionContext.scope,
        }),
      },
      BUILT_IN_MCP_RISK_DESCRIPTORS,
      {
        descriptorRegistry,
        profileRegistry,
        executionProfileEnforcer: enforcer,
        isExecutionProfileEnforcementEnabled: () => true,
        loadStdioServerTools: vi.fn(async () => []),
      }
    );

    const braveSearch = tools.find(({ name }) => name === "brave_web_search");
    expect(braveSearch).toBeDefined();
    const outcome = await getGovernedToolExecutor(braveSearch!)?.executeTyped(
      { query: "sandbox" },
      { configurable: { execution_context: executionContext } }
    );
    expect(outcome).toEqual({
      type: "succeeded",
      result: "brave-secret-value",
    });
    expect(secretBroker.resolve).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledOnce();
  });
});
