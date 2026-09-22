import type { StructuredToolInterface } from "@langchain/core/tools";

import { applyToolGovernance, auditToolLoad } from "../platform/tool-governance.js";
import { calculatorTool } from "./calculator.js";
import { createRuntimeToolAuthorizationComposition } from "./authorization/tool-authorization.js";
import { loadMcpTools } from "./mcp-loader.js";
import { weatherForecastTool, weatherTool } from "./weather.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import type { AuthorizationConfirmationStore } from "../runtime/authorization/confirmation.js";

const baseTools = [calculatorTool, webSearchTool, webFetchTool, weatherTool, weatherForecastTool];

export interface LoadAgentToolsOptions {
  includeMcp?: boolean;
}

export interface AgentToolRuntime {
  tools: StructuredToolInterface[];
  confirmationStore: AuthorizationConfirmationStore;
}

async function loadOptionalMcpTools(
  includeMcp: boolean,
  authorization: Parameters<typeof loadMcpTools>[0],
  riskDescriptors: Parameters<typeof loadMcpTools>[1]
): Promise<StructuredToolInterface[]> {
  if (!includeMcp || process.env.MCP_LOAD_ON_START !== "true") {
    return [];
  }

  return loadMcpTools(authorization, riskDescriptors).catch((error) => {
    console.warn("MCP tools failed to load; continuing with local tools.", error);
    return [];
  });
}

export async function loadAgentToolRuntime(
  source: string,
  options: LoadAgentToolsOptions = {}
): Promise<AgentToolRuntime> {
  const { authorization, confirmationStore, mcpRiskDescriptors } =
    createRuntimeToolAuthorizationComposition();
  const localTools = applyToolGovernance(baseTools, authorization);
  const mcpTools = await loadOptionalMcpTools(
    options.includeMcp ?? false,
    authorization,
    mcpRiskDescriptors
  );
  const tools = [...localTools, ...mcpTools];
  await auditToolLoad(source, tools);
  return { tools, confirmationStore };
}

export async function loadAgentTools(
  source: string,
  options: LoadAgentToolsOptions = {}
): Promise<StructuredToolInterface[]> {
  return (await loadAgentToolRuntime(source, options)).tools;
}
