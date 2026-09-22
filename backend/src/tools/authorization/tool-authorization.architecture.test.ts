import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("production tool authorization architecture", () => {
  it("injects authorization into every production applyToolGovernance caller", () => {
    const registrySource = readSource("../registry.ts");
    const mcpLoaderSource = readSource("../mcp-loader.ts");

    expect(registrySource).toContain("applyToolGovernance(baseTools, authorization)");
    expect(mcpLoaderSource).toContain("applyToolGovernance(tools, {");
    expect(mcpLoaderSource).toContain("riskRegistry: loadedRiskRegistry");
    expect(registrySource).not.toContain(
      "applyToolGovernance([...baseTools, ...mcpTools])"
    );
  });
});
