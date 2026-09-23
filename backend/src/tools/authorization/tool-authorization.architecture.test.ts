import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("production tool authorization architecture", () => {
  it("injects authorization into every production applyToolGovernance caller", () => {
    const registrySource = readSource("../registry.ts");
    const mcpLoaderSource = readSource("../mcp-loader.ts");

    expect(registrySource).toContain("createLocalRuntimeToolDescriptorRegistry()");
    expect(registrySource).toContain("createRuntimeToolDispatchPipeline({");
    expect(registrySource).toContain("registry: descriptorRegistry");
    expect(registrySource).toContain("dispatchPipeline.createExecutor(tool.name, defaultExecutor)");
    expect(registrySource).toContain("LOCAL_PRODUCTION_TOOLS");
    expect(mcpLoaderSource).toContain("applyToolGovernance(tools, {");
    expect(mcpLoaderSource).toContain("riskRegistry: loadedRiskRegistry");
    expect(mcpLoaderSource).toContain("registerMcpRuntimeToolDescriptors(");
    expect(mcpLoaderSource).toContain("dispatchPipeline.createExecutor");
    expect(registrySource).not.toContain(
      "applyToolGovernance([...LOCAL_PRODUCTION_TOOLS, ...mcpTools])"
    );
  });

  it("routes math tool execution through the registry boundary", () => {
    const mathAgentSource = readSource("../../agents/math-agent.ts");

    expect(mathAgentSource).toContain("loadMathCalculatorTool");
    expect(mathAgentSource).toContain("instrumentGraphWithExecutionContext");
    expect(mathAgentSource).not.toContain('../tools/calculator.js');
    expect(mathAgentSource).not.toContain("calculatorTool.invoke");
  });

  it("keeps Deep Research and MCP physical execution on governed executor seams", () => {
    const deepResearcherSource = readSource("../../agents/deep-researcher.ts");
    const mcpAgentSource = readSource("../../agents/mcp-agent.ts");
    const confirmationGraphSource = readSource(
      "../../runtime/authorization/confirmation-graph.ts"
    );

    expect(deepResearcherSource).toContain(
      'loadAgentTools("deep_researcher"'
    );
    expect(deepResearcherSource).toContain("selectedTool.invoke(input, toolConfig)");
    expect(mcpAgentSource).toContain(
      'loadAgentToolRuntime("mcp_agent"'
    );
    expect(confirmationGraphSource).toContain("getGovernedToolExecutor(tool)");
    expect(confirmationGraphSource).toContain("executeAuthorizedTyped");
  });

  it("documents that static import checks require runtime dispatcher instrumentation", () => {
    const architectureTestSource = readSource(
      "./tool-authorization.architecture.test.ts"
    );

    expect(architectureTestSource).toContain("toolByName");
    expect(architectureTestSource).toContain("runtime dispatcher instrumentation");
  });
});
