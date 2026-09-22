import type { AuthorizationPolicy } from "../../runtime/authorization/authorization.js";
import { AuthorizationEngine } from "../../runtime/authorization/authorization.js";
import {
  DefaultContextRedactor,
  PgDecisionStore,
} from "../../runtime/authorization/decision-store.js";
import { PgGrantStore } from "../../runtime/authorization/grant-store.js";
import { isActiveScopePresent } from "../../runtime/authorization/scope.js";
import { ToolRiskRegistry, type ToolRiskPolicy } from "../../runtime/authorization/tool-risk.js";
import {
  readDevelopmentExecutionContext,
  readExecutionContext,
} from "../../runtime/execution-context/read-execution-context.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import { getPool } from "../../runtime/persistence/connection.js";
import type { ToolAuthorizationGovernanceConfig } from "../../platform/tool-governance.js";
import { getBooleanEnv, getEnv } from "../../platform/env.js";
import {
  createConfirmationRequiredDescriptor,
  PgAuthorizationConfirmationStore,
  type AuthorizationConfirmationStore,
} from "../../runtime/authorization/confirmation.js";
import {
  MCP_TOOL_RISK_DESCRIPTOR_VERSION,
  parseMcpToolRiskDescriptors,
  toMcpToolRiskPolicy,
  type McpToolRiskDescriptorV1,
} from "./mcp-risk.js";

export const LOCAL_PRODUCTION_TOOL_NAMES = [
  "calculator_tool",
  "current_weather",
  "weather_forecast",
  "web_fetch",
  "web_search",
] as const;

export type ToolAuthorizationProfile = "production" | "development";

export const PRODUCTION_TOOL_AUTHORIZATION_POLICY_VERSION =
  "runtime-authorization-v1";

function createMcpDescriptors(
  serverName: string,
  toolNames: readonly string[],
  riskTier: McpToolRiskDescriptorV1["riskTier"],
  action: string,
  requireConfirmation: boolean
): McpToolRiskDescriptorV1[] {
  return toolNames.map((toolName) => ({
    schemaVersion: MCP_TOOL_RISK_DESCRIPTOR_VERSION,
    serverName,
    toolName,
    riskTier,
    actions: [action],
    requireConfirmation,
    resource: { strategy: "scope_tool", resourceType: "mcp_tool" },
  }));
}

export const BUILT_IN_MCP_RISK_DESCRIPTORS: readonly McpToolRiskDescriptorV1[] = [
  ...createMcpDescriptors(
    "filesystem",
    [
      "read_file",
      "read_text_file",
      "read_media_file",
      "read_multiple_files",
      "list_directory",
      "list_directory_with_sizes",
      "directory_tree",
      "search_files",
      "get_file_info",
      "list_allowed_directories",
    ],
    "read",
    "tool:read",
    false
  ),
  ...createMcpDescriptors(
    "filesystem",
    ["write_file", "edit_file", "create_directory", "move_file"],
    "sensitive",
    "tool:write",
    true
  ),
  ...createMcpDescriptors(
    "brave_search",
    ["brave_web_search", "brave_local_search"],
    "read",
    "tool:read",
    false
  ),
];

export interface CreateToolAuthorizationConfigInput {
  profile: ToolAuthorizationProfile;
  policyVersion: string;
  db: Queryable;
  policies: readonly ToolRiskPolicy[];
  enableDevelopmentReadDefault?: boolean;
}

export interface CreateRuntimeToolAuthorizationCompositionInput {
  profile?: string;
  db?: Queryable | null;
  policyVersion?: string;
  enableDevelopmentReadDefault?: boolean;
  mcpRiskDescriptors?: readonly unknown[];
}

export interface ToolAuthorizationComposition {
  authorization: ToolAuthorizationGovernanceConfig;
  confirmationStore: AuthorizationConfirmationStore;
  mcpRiskDescriptors: readonly McpToolRiskDescriptorV1[];
}

const unavailableDatabase: Queryable = {
  async query<TResult extends Record<string, unknown>>() {
    throw new Error("Tool authorization persistence is unavailable");
  },
};

function resolveAuthorizationProfile(rawProfile: string): ToolAuthorizationProfile {
  const profile = rawProfile.trim();
  if (profile !== "production" && profile !== "development") {
    throw new Error(`Unknown tool authorization profile: ${profile || "<empty>"}`);
  }
  return profile;
}

function confirmationTimeoutMs(): number {
  const value = Number(
    getEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", "900000")
  );
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error("Invalid TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS");
  }
  return value;
}

function createLocalReadPolicy(toolName: string): ToolRiskPolicy {
  return {
    toolName,
    riskTier: "read",
    actions: ["tool:read"],
    requireConfirmation: false,
    resourceRefResolver: (_input, scope) => ({
      resourceType: "tool",
      resourceId: toolName,
      tenantId: scope.tenantId,
      ownerScopeId: scope.scopeId,
    }),
  };
}

export function createLocalToolRiskPolicies(): ToolRiskPolicy[] {
  return LOCAL_PRODUCTION_TOOL_NAMES.map(createLocalReadPolicy);
}

function readToolName(context: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return typeof context?.toolName === "string" ? context.toolName : undefined;
}

function createPolicyResolver(
  registry: ToolRiskRegistry,
  policyVersion: string
): ToolAuthorizationGovernanceConfig["authorizationEngine"]["authorize"] extends never
  ? never
  : (request: Parameters<AuthorizationEngine["authorize"]>[0]) => AuthorizationPolicy | null {
  return (request) => {
    const toolName = readToolName(request.context);
    if (toolName === undefined) return null;
    const policy = registry.get(toolName);
    if (policy === null) return null;
    return {
      policyId: `${policyVersion}:${toolName}`,
      actions: policy.actions,
      access: policy.riskTier === "read" ? "read" : "write",
    };
  };
}

export function createToolAuthorizationConfig(
  input: CreateToolAuthorizationConfigInput
): ToolAuthorizationGovernanceConfig {
  if (input.profile !== "production" && input.profile !== "development") {
    throw new Error(`Unknown tool authorization profile: ${String(input.profile)}`);
  }
  const policyVersion = input.policyVersion.trim();
  if (policyVersion.length === 0) {
    throw new Error("Tool authorization policyVersion is required");
  }

  const riskRegistry = new ToolRiskRegistry(input.policies, {
    unregisteredToolDefault:
      input.profile === "development" && input.enableDevelopmentReadDefault === true
        ? "read"
        : "deny",
  });
  const grantStore = new PgGrantStore(input.db);
  const authorizationEngine = new AuthorizationEngine({
    grantStore,
    resolvePolicy: createPolicyResolver(riskRegistry, policyVersion),
    resolveScopeAccess: (principal, scope) => {
      if (!isActiveScopePresent(scope) || principal.tenantId !== scope.tenantId) {
        return "none";
      }
      return "writable";
    },
    evaluateToolRisk: (request) => {
      const toolName = readToolName(request.context);
      if (toolName === undefined) return "deny";
      return riskRegistry.classify(toolName, request.action).effect;
    },
  });

  return {
    riskRegistry,
    authorizationEngine,
    decisionStore: new PgDecisionStore(input.db, new DefaultContextRedactor()),
    policyVersion,
    resolveExecutionContext:
      input.profile === "development"
        ? (config) => readDevelopmentExecutionContext(undefined, config)
        : (config) => readExecutionContext(undefined, config, "production"),
    onRequireConfirmation: (decision, request, executionContext) => {
      if (executionContext === undefined) {
        throw new Error("Confirmation requires a canonical ExecutionContext");
      }
      const toolName = readToolName(request.context);
      if (toolName === undefined) {
        throw new Error("Confirmation requires a tool name");
      }
      return createConfirmationRequiredDescriptor({
        decisionId: decision.decisionId,
        executionContext,
        action: request.action,
        toolName,
        resource: request.resource,
        policyVersion,
        timeoutMs: confirmationTimeoutMs(),
      });
    },
  };
}

export function createRuntimeToolAuthorizationComposition(
  input: CreateRuntimeToolAuthorizationCompositionInput = {}
): ToolAuthorizationComposition {
  const profile = resolveAuthorizationProfile(
    input.profile ?? getEnv("TOOL_AUTHORIZATION_PROFILE", "production")
  );
  const mcpRiskDescriptors = parseMcpToolRiskDescriptors(
    input.mcpRiskDescriptors ?? BUILT_IN_MCP_RISK_DESCRIPTORS
  );
  const policies = [
    ...createLocalToolRiskPolicies(),
    ...mcpRiskDescriptors.map(toMcpToolRiskPolicy),
  ];
  const configuredDatabase =
    input.db === undefined ? getPool() : input.db;
  const authorization = createToolAuthorizationConfig({
    profile,
    policyVersion:
      input.policyVersion ?? PRODUCTION_TOOL_AUTHORIZATION_POLICY_VERSION,
    db: configuredDatabase ?? unavailableDatabase,
    policies,
    enableDevelopmentReadDefault:
      input.enableDevelopmentReadDefault ??
      getBooleanEnv("TOOL_AUTHORIZATION_DEVELOPMENT_READ_DEFAULT", false),
  });
  return {
    authorization,
    confirmationStore: new PgAuthorizationConfirmationStore(
      configuredDatabase ?? unavailableDatabase
    ),
    mcpRiskDescriptors,
  };
}
