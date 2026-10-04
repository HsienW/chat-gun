import { createHash } from "node:crypto";

import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { defaultToolPolicy } from "../platform/tool-governance.js";
import {
  ExecutionProfileRegistry,
  type EgressRequirements,
  type ExecutionProfile,
} from "../runtime/tool-dispatch/execution-profile.js";
import type { RuntimeSchema } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import type { SecretReference } from "../runtime/tool-dispatch/secret-broker.js";
import { PRODUCTION_EGRESS_REQUIREMENTS } from "../runtime/tool-dispatch/production-egress-policies.js";
import {
  RuntimeToolDescriptorRegistry,
  type RuntimeToolDescriptor,
} from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { DEFAULT_RETRY_POLICY } from "../runtime/retry/retry-policy.js";
import { calculatorTool } from "./calculator.js";
import {
  createLocalToolRiskPolicies,
  LOCAL_PRODUCTION_TOOL_NAMES,
} from "./authorization/tool-authorization.js";
import {
  findMcpToolRiskDescriptor,
  type McpToolRiskDescriptorV1,
} from "./authorization/mcp-risk.js";
import { weatherForecastTool, weatherTool } from "./weather.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

export const LOCAL_RUNTIME_TOOL_VERSION = "1.0";

const LOCAL_PROFILE_ID_PREFIX = "local-read-only";
const LOCAL_EGRESS_REQUIREMENTS: Readonly<Record<string, EgressRequirements>> =
  PRODUCTION_EGRESS_REQUIREMENTS;

export const TAVILY_SECRET_REFERENCE: SecretReference = {
  secretRef: "env:TAVILY_API_KEY",
  secretName: "TAVILY_API_KEY",
  scope: "tool:web_search",
};

export const LOCAL_PRODUCTION_TOOLS = [
  calculatorTool,
  webSearchTool,
  webFetchTool,
  weatherTool,
  weatherForecastTool,
] as const satisfies readonly StructuredToolInterface[];

function localProfileId(toolName: string): string {
  return `${LOCAL_PROFILE_ID_PREFIX}:${toolName}`;
}

function createTrustedLocalProfile(toolName: string): ExecutionProfile {
  const egressRequirements = LOCAL_EGRESS_REQUIREMENTS[toolName];
  return {
    profileVersion: "1.0",
    mode: "trusted_in_process",
    filesystem: { roots: [], writeMode: "read_only" },
    process: { creation: "deny" },
    resources: {
      cpuTimeMs: 15_000,
      memoryBytes: 256 * 1024 * 1024,
      diskBytes: 0,
      wallClockMs: 30_000,
    },
    egress: {
      destinations: egressRequirements?.destinations ?? [],
      protocols: egressRequirements?.protocols ?? [],
      dns: "resolve_and_connect",
    },
    env: {
      allowedVariables:
        toolName === "web_search" ? ["TAVILY_API_KEY"] : [],
    },
    binaries: { allowed: [], runtimeImages: [] },
    output: { maxBytes: 24_000, artifactHandling: "inline" },
  };
}

export function createLocalExecutionProfileRegistry(): ExecutionProfileRegistry {
  const registry = new ExecutionProfileRegistry();
  for (const tool of LOCAL_PRODUCTION_TOOLS) {
    registry.register(
      { profileId: localProfileId(tool.name), profileVersion: "1.0" },
      createTrustedLocalProfile(tool.name)
    );
  }
  return registry;
}

function isRuntimeSchema(value: unknown): value is RuntimeSchema<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

function requireRuntimeSchema(
  tool: StructuredToolInterface
): RuntimeSchema<unknown> {
  if (!isRuntimeSchema(tool.schema)) {
    throw new Error(`Production tool requires a runtime schema: ${tool.name}`);
  }
  return tool.schema;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createLocalRuntimeToolDescriptors(): RuntimeToolDescriptor<
  unknown,
  string
>[] {
  const policyByToolName = new Map(
    createLocalToolRiskPolicies().map((policy) => [policy.toolName, policy])
  );

  return LOCAL_PRODUCTION_TOOLS.map((tool) => {
    const riskPolicy = policyByToolName.get(tool.name);
    if (riskPolicy === undefined) {
      throw new Error(`Missing local ToolRiskPolicy: ${tool.name}`);
    }
    const governancePolicy = defaultToolPolicy(tool.name);

    return {
      toolName: tool.name,
      toolVersion: LOCAL_RUNTIME_TOOL_VERSION,
      inputSchema: requireRuntimeSchema(tool),
      outputSchema: z.string(),
      riskTier: riskPolicy.riskTier,
      isReadOnly: true,
      isConcurrencySafe: () => true,
      timeoutPolicy: { timeoutMs: governancePolicy.timeoutMs },
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        retryableCategories: [...DEFAULT_RETRY_POLICY.retryableCategories],
      },
      interruptBehavior: "cancel_safe" as const,
      executionProfileRef: {
        profileId: localProfileId(tool.name),
        profileVersion: "1.0" as const,
      },
      ...(LOCAL_EGRESS_REQUIREMENTS[tool.name]
        ? { egressRequirements: LOCAL_EGRESS_REQUIREMENTS[tool.name] }
        : {}),
      ...(tool.name === "web_search"
        ? { secretRequirements: [TAVILY_SECRET_REFERENCE] }
        : {}),
    };
  });
}

export function createLocalRuntimeToolDescriptorRegistry(): RuntimeToolDescriptorRegistry {
  const registry = new RuntimeToolDescriptorRegistry();
  for (const descriptor of createLocalRuntimeToolDescriptors()) {
    registry.register(
      {
        toolName: descriptor.toolName,
        toolVersion: descriptor.toolVersion,
      },
      descriptor
    );
  }

  const registeredNames = new Set(
    registry.list().map(({ toolName }) => toolName)
  );
  if (
    registeredNames.size !== LOCAL_PRODUCTION_TOOL_NAMES.length ||
    LOCAL_PRODUCTION_TOOL_NAMES.some((toolName) => !registeredNames.has(toolName))
  ) {
    throw new Error("Local production runtime tool registry is incomplete");
  }
  return registry;
}

export interface ExposedMcpRuntimeTools {
  serverName: string;
  tools: readonly StructuredToolInterface[];
}

export interface McpServerExecutionPolicy {
  serverName: string;
  profileId: string;
  profile: ExecutionProfile;
  secretRequirements?: readonly SecretReference[];
}

export interface McpRuntimeExecutionRegistration {
  profileRegistry: ExecutionProfileRegistry;
  serverPolicies: readonly McpServerExecutionPolicy[];
}

export function registerMcpRuntimeToolDescriptors(
  registry: RuntimeToolDescriptorRegistry,
  servers: readonly ExposedMcpRuntimeTools[],
  riskDescriptors: readonly McpToolRiskDescriptorV1[],
  execution?: McpRuntimeExecutionRegistration
): void {
  const executionPolicyByServer = new Map<string, McpServerExecutionPolicy>();
  for (const policy of execution?.serverPolicies ?? []) {
    if (policy.profile.mode !== "isolated_process") {
      throw new Error(`MCP server profile must use isolated_process: ${policy.serverName}`);
    }
    if (executionPolicyByServer.has(policy.serverName)) {
      throw new Error(`Duplicate MCP server execution policy: ${policy.serverName}`);
    }
    executionPolicyByServer.set(policy.serverName, policy);
    execution?.profileRegistry.register(
      { profileId: policy.profileId, profileVersion: policy.profile.profileVersion },
      policy.profile
    );
  }

  for (const { serverName, tools } of servers) {
    const executionPolicy = executionPolicyByServer.get(serverName);
    if (execution !== undefined && executionPolicy === undefined) {
      throw new Error(`Missing MCP server execution policy: ${serverName}`);
    }
    for (const tool of tools) {
      const riskDescriptor = findMcpToolRiskDescriptor(
        riskDescriptors,
        serverName,
        tool.name
      );
      if (riskDescriptor === undefined) {
        throw new Error(
          `Missing MCP runtime risk descriptor: ${serverName}/${tool.name}`
        );
      }

      const governancePolicy = defaultToolPolicy(tool.name);
      const isReadOnly = riskDescriptor.riskTier === "read";
      const toolVersion = riskDescriptor.schemaVersion;
      const descriptor: RuntimeToolDescriptor<unknown, string> = {
        toolName: tool.name,
        toolVersion,
        inputSchema: requireRuntimeSchema(tool),
        outputSchema: z.string(),
        riskTier: riskDescriptor.riskTier,
        isReadOnly,
        isConcurrencySafe: () => isReadOnly,
        timeoutPolicy: { timeoutMs: governancePolicy.timeoutMs },
        retryPolicy: {
          ...DEFAULT_RETRY_POLICY,
          retryableCategories: [...DEFAULT_RETRY_POLICY.retryableCategories],
        },
        interruptBehavior: isReadOnly ? "cancel_safe" : "reconcile_first",
        ...(executionPolicy
          ? {
              executionProfileRef: {
                profileId: executionPolicy.profileId,
                profileVersion: executionPolicy.profile.profileVersion,
              },
              egressRequirements: {
                destinations: executionPolicy.profile.egress.destinations,
                protocols: executionPolicy.profile.egress.protocols,
              },
              ...(executionPolicy.secretRequirements
                ? { secretRequirements: executionPolicy.secretRequirements }
                : {}),
            }
          : {}),
        ...(isReadOnly
          ? {}
          : {
              sideEffect: {
                toolName: tool.name,
                toolVersion,
                deriveBusinessEffectKey: (input, scope) =>
                  JSON.stringify(
                    canonicalize({
                      serverName,
                      toolName: tool.name,
                      toolVersion,
                      tenantId: scope.tenantId,
                      scopeId: scope.scopeId,
                      input,
                    })
                  ),
                reconcile: {
                  reconcile: async () => ({
                    state: "unknown" as const,
                    reason: "MCP_RECONCILIATION_QUERY_UNAVAILABLE",
                  }),
                },
                resultReferencePolicy: {
                  toResultRef: (result: string) => ({
                    resultHash: hashValue(result),
                    payloadRef: result,
                  }),
                  resolveResultRef: async (payloadRef: string) => payloadRef,
                  isReusable: (cacheState) => cacheState === "reusable",
                },
              },
            }),
      };

      registry.register(
        { toolName: tool.name, toolVersion },
        descriptor
      );
    }
  }
}
