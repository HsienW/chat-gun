import type { StructuredToolInterface } from "@langchain/core/tools";

import { validateManifest } from "@gun-ai/harness-sdk";

import { auditLogger } from "../platform/observability.js";
import {
  applyToolGovernance,
  auditToolLoad,
  type ToolAuthorizationGovernanceConfig,
  type ToolGovernanceOptions,
} from "../platform/tool-governance.js";
import { createRuntimeToolAuthorizationComposition } from "./authorization/tool-authorization.js";
import { loadMcpTools } from "./mcp-loader.js";
import type {
  AuthorizationConfirmationStore,
  AuthorizationConfirmationWithdrawalStore,
} from "../runtime/authorization/confirmation.js";
import type { InterruptManifestRepository } from "../runtime/recovery/interrupt-manifest-repository.js";
import { createRuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import type { RuntimeToolDispatchPipelineDependencies } from "../runtime/tool-dispatch/pipeline.js";
import { ExecutionProfileEnforcer } from "../runtime/tool-dispatch/execution-profile.js";
import type {
  ExecutionProfileEnforcerPort,
  ExecutionProfileRegistry,
  SandboxRunnerPort,
} from "../runtime/tool-dispatch/execution-profile.js";
import type {
  RuntimeToolDescriptor,
  RuntimeToolDescriptorRegistry,
} from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { EnvironmentSecretBroker } from "../runtime/tool-dispatch/secret-broker.js";
import { SHOPPING_ASSISTANT_AGENT_MANIFEST } from "../agents/shopping-assistant/agent-manifest.js";
import type { OrderProvider } from "./orders/mock-order-provider.js";
import {
  createOrderToolRiskPolicies,
  createOrderToolSet,
  registerOrderExecutionProfiles,
  type OrderOperationStatusReader,
} from "./orders/order-tools.js";
import {
  stageOrderToolSdkDescriptor,
  type OrderToolManifestEvidence,
} from "./sdk/order-tool-manifest-adapter.js";
import {
  createLocalExecutionProfileRegistry,
  createLocalRuntimeToolDescriptors,
  createLocalRuntimeToolDescriptorRegistry,
  LOCAL_PRODUCTION_TOOLS,
} from "./production-runtime-tool-descriptors.js";
import { stageCurrentWeatherSdkDescriptor } from "./sdk/current-weather-manifest-adapter.js";
import { stageKbSearchSdkDescriptor } from "./sdk/kb-search-manifest-adapter.js";

const PIPELINE_FLAG_BY_SOURCE = {
  math_agent: "TOOL_DISPATCH_PIPELINE_MATH_ENABLED",
  deep_researcher: "TOOL_DISPATCH_PIPELINE_DEEP_RESEARCHER_ENABLED",
  mcp_agent: "TOOL_DISPATCH_PIPELINE_MCP_ENABLED",
} as const;

export interface LoadAgentToolsOptions {
  includeMcp?: boolean;
  currentWeatherRegistration?: "sdk" | "legacy";
  sandboxRunner?: SandboxRunnerPort;
  dispatchPipelineDependencies?: Omit<
    RuntimeToolDispatchPipelineDependencies,
    "registry"
  >;
}

export interface AgentToolRuntime {
  tools: StructuredToolInterface[];
  confirmationStore: AuthorizationConfirmationStore;
  interruptManifestRepository: InterruptManifestRepository;
}

export function isToolDispatchPipelineEnabled(source: string): boolean {
  const flag = PIPELINE_FLAG_BY_SOURCE[
    source as keyof typeof PIPELINE_FLAG_BY_SOURCE
  ];
  return flag !== undefined && process.env[flag] === "true";
}

async function loadOptionalMcpTools(
  includeMcp: boolean,
  authorization: Parameters<typeof loadMcpTools>[0],
  riskDescriptors: Parameters<typeof loadMcpTools>[1],
  options: Parameters<typeof loadMcpTools>[2]
): Promise<StructuredToolInterface[]> {
  if (!includeMcp || process.env.MCP_LOAD_ON_START !== "true") {
    return [];
  }

  return loadMcpTools(authorization, riskDescriptors, options).catch((error) => {
    console.warn("MCP tools failed to load; continuing with local tools.", error);
    return [];
  });
}

async function stageLocalRuntimeDescriptors(
  authorization: ToolAuthorizationGovernanceConfig,
  profileRegistry: ExecutionProfileRegistry,
  options: Pick<LoadAgentToolsOptions, "currentWeatherRegistration">
): Promise<RuntimeToolDescriptor<unknown, string>[]> {
  const localDescriptors = createLocalRuntimeToolDescriptors();
  return Promise.all(localDescriptors.map(async (descriptor) => {
    if (descriptor.toolName === "kb_search") {
      const tool = LOCAL_PRODUCTION_TOOLS.find((candidate) => candidate.name === descriptor.toolName);
      if (tool === undefined) throw new Error("kb_search implementation is unavailable");
      return stageKbSearchSdkDescriptor({
        tool,
        descriptor,
        riskPolicy: authorization.riskRegistry.get(descriptor.toolName),
        profileRegistry,
      });
    }
    if (descriptor.toolName !== "current_weather" || options.currentWeatherRegistration === "legacy") {
      return descriptor;
    }
    const tool = LOCAL_PRODUCTION_TOOLS.find((candidate) => candidate.name === descriptor.toolName);
    if (tool === undefined) throw new Error("Current weather implementation is unavailable");
    return stageCurrentWeatherSdkDescriptor({
      tool,
      descriptor,
      riskPolicy: authorization.riskRegistry.get(descriptor.toolName),
      profileRegistry,
    });
  }));
}

function createExecutionProfileEnforcer(
  descriptorRegistry: RuntimeToolDescriptorRegistry,
  profileRegistry: ExecutionProfileRegistry,
  options: Pick<LoadAgentToolsOptions, "sandboxRunner" | "dispatchPipelineDependencies">
): ExecutionProfileEnforcerPort {
  return (
    options.dispatchPipelineDependencies?.executionProfileEnforcer ??
    new ExecutionProfileEnforcer({
      descriptorRegistry,
      profileRegistry,
      runner: options.sandboxRunner,
      secretBroker: new EnvironmentSecretBroker({
        references: {
          "env:TAVILY_API_KEY": "TAVILY_API_KEY",
          "env:BRAVE_API_KEY": "BRAVE_API_KEY",
          "env:QWEN_API_KEY": "QWEN_API_KEY",
        },
      }),
      isEnabled: () =>
        process.env.TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED === "true",
    })
  );
}

export async function loadAgentToolRuntime(
  source: string,
  options: LoadAgentToolsOptions = {}
): Promise<AgentToolRuntime> {
  const {
    authorization,
    confirmationStore,
    interruptManifestRepository,
    mcpRiskDescriptors,
  } =
    createRuntimeToolAuthorizationComposition();
  const profileRegistry = createLocalExecutionProfileRegistry();
  const stagedDescriptors = await stageLocalRuntimeDescriptors(
    authorization,
    profileRegistry,
    options
  );
  const descriptorRegistry = createLocalRuntimeToolDescriptorRegistry(stagedDescriptors);
  const executionProfileEnforcer = createExecutionProfileEnforcer(
    descriptorRegistry,
    profileRegistry,
    options
  );
  const dispatchPipeline = isToolDispatchPipelineEnabled(source)
    ? createRuntimeToolDispatchPipeline({
        ...options.dispatchPipelineDependencies,
        registry: descriptorRegistry,
        executionProfileEnforcer,
      })
    : undefined;
  const governanceOptions: ToolGovernanceOptions = {
    executionProfileEnforcer,
    ...(dispatchPipeline
      ? {
        createExecutor: (tool, defaultExecutor) =>
          dispatchPipeline.createExecutor(tool.name, defaultExecutor),
        }
      : {}),
  };
  const localTools = applyToolGovernance(
    [...LOCAL_PRODUCTION_TOOLS],
    authorization,
    governanceOptions
  );
  const mcpTools = await loadOptionalMcpTools(
    options.includeMcp ?? false,
    authorization,
    mcpRiskDescriptors,
    {
      descriptorRegistry,
      profileRegistry,
      dispatchPipeline,
      executionProfileEnforcer,
      isExecutionProfileEnforcementEnabled: () =>
        process.env.TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED === "true",
    }
  );
  const tools = [...localTools, ...mcpTools];
  await auditToolLoad(source, tools);
  return { tools, confirmationStore, interruptManifestRepository };
}

export async function loadAgentTools(
  source: string,
  options: LoadAgentToolsOptions = {}
): Promise<StructuredToolInterface[]> {
  return (await loadAgentToolRuntime(source, options)).tools;
}

export type ShoppingToolRuntimeErrorCode =
  | "AGENT_MANIFEST_INVALID"
  | "AGENT_MANIFEST_TOOL_UNREGISTERED";

export class ShoppingToolRuntimeError extends Error {
  readonly name = "ShoppingToolRuntimeError";

  constructor(
    readonly code: ShoppingToolRuntimeErrorCode,
    readonly toolId?: string
  ) {
    super(toolId ? `${code}: ${toolId}` : code);
  }
}

export interface LoadShoppingAssistantToolsOptions {
  orderProvider: OrderProvider;
  statusReader: OrderOperationStatusReader;
  /** Defaults to the shopping assistant's own manifest; tests pass a broken one. */
  agentManifest?: unknown;
  sandboxRunner?: SandboxRunnerPort;
  dispatchPipelineDependencies?: Omit<
    RuntimeToolDispatchPipelineDependencies,
    "registry" | "emitDeduplicatedOutcome" | "recordReconciliationTasks"
  >;
}

export interface ShoppingAssistantToolRuntime extends AgentToolRuntime {
  /** The same approval store; the shopping graph withdraws approvals on cancel (design §6.2). */
  confirmationWithdrawal: AuthorizationConfirmationWithdrawalStore;
  manifests: readonly OrderToolManifestEvidence[];
}

/**
 * The shopping assistant gets only the tools its agent manifest grants, and
 * always through the dispatch pipeline: there is no feature-flag fallback to
 * the default executor (design §5.4). Order tools exist only in this runtime.
 */
export async function loadShoppingAssistantToolRuntime(
  options: LoadShoppingAssistantToolsOptions
): Promise<ShoppingAssistantToolRuntime> {
  const manifest = validateManifest(options.agentManifest ?? SHOPPING_ASSISTANT_AGENT_MANIFEST);
  if (!manifest.ok || manifest.value.kind !== "agent") {
    throw new ShoppingToolRuntimeError("AGENT_MANIFEST_INVALID");
  }
  const { authorization, confirmationStore, interruptManifestRepository } =
    createRuntimeToolAuthorizationComposition({
      additionalPolicies: createOrderToolRiskPolicies(),
    });
  const profileRegistry = createLocalExecutionProfileRegistry();
  registerOrderExecutionProfiles(profileRegistry);
  const descriptorRegistry = createLocalRuntimeToolDescriptorRegistry(
    await stageLocalRuntimeDescriptors(authorization, profileRegistry, {})
  );
  const orderTools = createOrderToolSet({
    provider: options.orderProvider,
    statusReader: options.statusReader,
  });
  const manifests: OrderToolManifestEvidence[] = [];
  for (const [index, tool] of orderTools.tools.entries()) {
    const descriptor = orderTools.descriptors[index];
    if (descriptor === undefined) throw new Error(`Order tool descriptor is unavailable: ${tool.name}`);
    const staged = await stageOrderToolSdkDescriptor({
      tool,
      descriptor,
      riskPolicy: authorization.riskRegistry.get(tool.name),
      profileRegistry,
    });
    descriptorRegistry.register(
      { toolName: staged.descriptor.toolName, toolVersion: staged.descriptor.toolVersion },
      staged.descriptor
    );
    manifests.push(staged.evidence);
  }

  const implementations = new Map<string, StructuredToolInterface>(
    [...LOCAL_PRODUCTION_TOOLS, ...orderTools.tools].map((tool) => [tool.name, tool])
  );
  const grantedTools = manifest.value.tools.map(({ toolId, toolVersion }) => {
    const descriptor = descriptorRegistry.resolve(toolId);
    const implementation = implementations.get(toolId);
    if (descriptor === null || descriptor.toolVersion !== toolVersion || implementation === undefined) {
      throw new ShoppingToolRuntimeError("AGENT_MANIFEST_TOOL_UNREGISTERED", toolId);
    }
    return implementation;
  });

  const executionProfileEnforcer = createExecutionProfileEnforcer(
    descriptorRegistry,
    profileRegistry,
    options
  );
  const dispatchPipeline = createRuntimeToolDispatchPipeline({
    ...options.dispatchPipelineDependencies,
    registry: descriptorRegistry,
    executionProfileEnforcer,
    emitDeduplicatedOutcome: true,
    recordReconciliationTasks: true,
  });
  const tools = applyToolGovernance(grantedTools, authorization, {
    executionProfileEnforcer,
    createExecutor: (tool, defaultExecutor) =>
      dispatchPipeline.createExecutor(tool.name, defaultExecutor),
  });
  await auditToolLoad(SHOPPING_ASSISTANT_SOURCE, tools);
  for (const evidence of manifests) {
    await auditLogger.record("tool.manifest.registered", {
      source: SHOPPING_ASSISTANT_SOURCE,
      ...evidence,
    });
  }
  return {
    tools,
    confirmationStore,
    confirmationWithdrawal: confirmationStore,
    interruptManifestRepository,
    manifests,
  };
}

const SHOPPING_ASSISTANT_SOURCE = "shopping_assistant";

export async function loadMathCalculatorTool(): Promise<StructuredToolInterface> {
  const calculator = LOCAL_PRODUCTION_TOOLS.find(
    (tool) => tool.name === "calculator_tool"
  );
  if (calculator === undefined) {
    throw new Error("Local calculator descriptor is unavailable");
  }
  if (!isToolDispatchPipelineEnabled("math_agent")) {
    return calculator;
  }

  const runtime = await loadAgentToolRuntime("math_agent");
  const governedCalculator = runtime.tools.find(
    (tool) => tool.name === calculator.name
  );
  if (governedCalculator === undefined) {
    throw new Error("Governed calculator tool is unavailable");
  }
  return governedCalculator;
}
