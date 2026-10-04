import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  applyToolGovernance,
  auditToolLoad,
  type ToolGovernanceOptions,
} from "../platform/tool-governance.js";
import { createRuntimeToolAuthorizationComposition } from "./authorization/tool-authorization.js";
import { loadMcpTools } from "./mcp-loader.js";
import type { AuthorizationConfirmationStore } from "../runtime/authorization/confirmation.js";
import type { InterruptManifestRepository } from "../runtime/recovery/interrupt-manifest-repository.js";
import { createRuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import type { RuntimeToolDispatchPipelineDependencies } from "../runtime/tool-dispatch/pipeline.js";
import { ExecutionProfileEnforcer } from "../runtime/tool-dispatch/execution-profile.js";
import type { SandboxRunnerPort } from "../runtime/tool-dispatch/execution-profile.js";
import { EnvironmentSecretBroker } from "../runtime/tool-dispatch/secret-broker.js";
import {
  createLocalExecutionProfileRegistry,
  createLocalRuntimeToolDescriptorRegistry,
  LOCAL_PRODUCTION_TOOLS,
} from "./production-runtime-tool-descriptors.js";

const PIPELINE_FLAG_BY_SOURCE = {
  math_agent: "TOOL_DISPATCH_PIPELINE_MATH_ENABLED",
  deep_researcher: "TOOL_DISPATCH_PIPELINE_DEEP_RESEARCHER_ENABLED",
  mcp_agent: "TOOL_DISPATCH_PIPELINE_MCP_ENABLED",
} as const;

export interface LoadAgentToolsOptions {
  includeMcp?: boolean;
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
  const descriptorRegistry = createLocalRuntimeToolDescriptorRegistry();
  const profileRegistry = createLocalExecutionProfileRegistry();
  const executionProfileEnforcer =
    options.dispatchPipelineDependencies?.executionProfileEnforcer ??
    new ExecutionProfileEnforcer({
      descriptorRegistry,
      profileRegistry,
      runner: options.sandboxRunner,
      secretBroker: new EnvironmentSecretBroker({
        references: {
          "env:TAVILY_API_KEY": "TAVILY_API_KEY",
          "env:BRAVE_API_KEY": "BRAVE_API_KEY",
        },
      }),
      isEnabled: () =>
        process.env.TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED === "true",
    });
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
