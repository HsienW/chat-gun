import { describe, expect, it } from "vitest";

import {
  assertUniqueExposedMcpToolNames,
  createMcpToolRiskPoliciesForExposedTools,
  parseMcpToolRiskDescriptors,
  toMcpToolRiskPolicy,
} from "./mcp-risk.js";
import { ToolRiskRegistry } from "../../runtime/authorization/tool-risk.js";

const validDescriptor = {
  schemaVersion: "1.0",
  serverName: "filesystem",
  toolName: "read_file",
  riskTier: "read",
  actions: ["filesystem:read"],
  requireConfirmation: false,
  resource: { strategy: "scope_tool", resourceType: "mcp_tool" },
};

describe("McpToolRiskDescriptorV1", () => {
  it("strictly parses a versioned descriptor and derives tenant only from scope", () => {
    const [descriptor] = parseMcpToolRiskDescriptors([validDescriptor]);
    const policy = toMcpToolRiskPolicy(descriptor!);

    expect(policy.resourceRefResolver({}, {
      scopeId: "scope-1",
      scopeType: "tenant",
      tenantId: "tenant-1",
    })).toEqual({
      resourceType: "mcp_tool",
      resourceId: "filesystem:read_file",
      tenantId: "tenant-1",
      ownerScopeId: "scope-1",
    });
  });

  it.each([
    [{ ...validDescriptor, schemaVersion: "2.0" }],
    [{ ...validDescriptor, actions: [] }],
    [{ ...validDescriptor, annotations: { destructiveHint: false } }],
    [{ ...validDescriptor, resource: { strategy: "server_metadata", resourceType: "x" } }],
  ])("rejects invalid, unknown-version, or metadata-extended descriptors", (candidate) => {
    expect(parseMcpToolRiskDescriptors([candidate])).toEqual([]);
  });

  it("rejects duplicate server/tool descriptor identities", () => {
    expect(() =>
      parseMcpToolRiskDescriptors([validDescriptor, validDescriptor])
    ).toThrow("Duplicate MCP risk descriptor");
  });

  it("rejects duplicate exposed tool names across MCP servers", () => {
    expect(() =>
      assertUniqueExposedMcpToolNames([
        { serverName: "filesystem", toolNames: ["search"] },
        { serverName: "brave_search", toolNames: ["search"] },
      ])
    ).toThrow("Duplicate exposed MCP tool name");
  });

  it("does not inherit a same-name policy from a different MCP server", () => {
    const descriptors = parseMcpToolRiskDescriptors([validDescriptor]);
    const policies = createMcpToolRiskPoliciesForExposedTools(
      [{ serverName: "custom_server", toolNames: ["read_file"] }],
      descriptors
    );
    const registry = new ToolRiskRegistry(policies, {
      unregisteredToolDefault: "deny",
    });

    expect(policies).toEqual([]);
    expect(registry.classify("read_file", "filesystem:read")).toMatchObject({
      effect: "deny",
      reasonCode: "UNREGISTERED_TOOL_DENIED",
    });
  });

  it("creates a policy only for an exact server and tool descriptor match", () => {
    const descriptors = parseMcpToolRiskDescriptors([validDescriptor]);
    const policies = createMcpToolRiskPoliciesForExposedTools(
      [{ serverName: "filesystem", toolNames: ["read_file", "unknown"] }],
      descriptors
    );

    expect(policies.map(({ toolName }) => toolName)).toEqual(["read_file"]);
  });
});
