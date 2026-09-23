import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import type { McpToolRiskDescriptorV1 } from "./authorization/mcp-risk.js";
import { registerMcpRuntimeToolDescriptors } from "./production-runtime-tool-descriptors.js";

function createTool(name: string) {
  return tool(async () => "ok", {
    name,
    description: `${name} test tool`,
    schema: z.object({ path: z.string(), content: z.string().optional() }).strict(),
  });
}

function riskDescriptor(
  toolName: string,
  riskTier: McpToolRiskDescriptorV1["riskTier"]
): McpToolRiskDescriptorV1 {
  return {
    schemaVersion: "1.0",
    serverName: "filesystem",
    toolName,
    riskTier,
    actions: [riskTier === "read" ? "tool:read" : "tool:write"],
    requireConfirmation: riskTier !== "read",
    resource: { strategy: "scope_tool", resourceType: "mcp_tool" },
  };
}

describe("MCP runtime tool descriptors", () => {
  it("registers read tools without side effects and mutation tools with them", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    registerMcpRuntimeToolDescriptors(
      registry,
      [
        {
          serverName: "filesystem",
          tools: [createTool("read_file"), createTool("write_file")],
        },
      ],
      [riskDescriptor("read_file", "read"), riskDescriptor("write_file", "sensitive")]
    );

    expect(registry.resolve("read_file")).toMatchObject({ isReadOnly: true });
    expect(registry.resolve("read_file")?.sideEffect).toBeUndefined();
    expect(registry.resolve("write_file")).toMatchObject({
      isReadOnly: false,
      riskTier: "sensitive",
      interruptBehavior: "reconcile_first",
    });
    expect(registry.resolve("write_file")?.sideEffect).toBeDefined();
  });

  it("derives a stable business-effect key independent of input object key order", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    registerMcpRuntimeToolDescriptors(
      registry,
      [{ serverName: "filesystem", tools: [createTool("write_file")] }],
      [riskDescriptor("write_file", "sensitive")]
    );
    const sideEffect = registry.resolve("write_file")?.sideEffect;
    const scope = {
      scopeId: "scope-1",
      tenantId: "tenant-1",
      principalId: "principal-1",
    };

    expect(
      sideEffect?.deriveBusinessEffectKey(
        { path: "a.txt", content: "x" },
        scope
      )
    ).toBe(
      sideEffect?.deriveBusinessEffectKey(
        { content: "x", path: "a.txt" },
        scope
      )
    );
  });

  it("parks ambiguous mutations when MCP exposes no reconciliation query", async () => {
    const registry = new RuntimeToolDescriptorRegistry();
    registerMcpRuntimeToolDescriptors(
      registry,
      [{ serverName: "filesystem", tools: [createTool("write_file")] }],
      [riskDescriptor("write_file", "sensitive")]
    );

    const reconciliation = await registry
      .resolve("write_file")
      ?.sideEffect?.reconcile?.reconcile({
        toolExecutionId: "execution-1",
        businessEffectKey: "effect-key" as never,
      });

    expect(reconciliation).toEqual({
      state: "unknown",
      reason: "MCP_RECONCILIATION_QUERY_UNAVAILABLE",
    });
  });

  it("fails closed when an exposed MCP tool has no risk descriptor", () => {
    const registry = new RuntimeToolDescriptorRegistry();

    expect(() =>
      registerMcpRuntimeToolDescriptors(
        registry,
        [{ serverName: "filesystem", tools: [createTool("unknown_mutation")] }],
        []
      )
    ).toThrow("Missing MCP runtime risk descriptor");
  });
});
