import { z } from "zod";

import {
  TOOL_RISK_TIERS,
  type ToolRiskPolicy,
} from "../../runtime/authorization/tool-risk.js";

export const MCP_TOOL_RISK_DESCRIPTOR_VERSION = "1.0" as const;

const mcpToolRiskDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(MCP_TOOL_RISK_DESCRIPTOR_VERSION),
    serverName: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    riskTier: z.enum(TOOL_RISK_TIERS),
    actions: z.array(z.string().trim().min(1)).min(1),
    requireConfirmation: z.boolean(),
    resource: z
      .object({
        strategy: z.literal("scope_tool"),
        resourceType: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export type McpToolRiskDescriptorV1 = z.infer<
  typeof mcpToolRiskDescriptorV1Schema
>;

export interface ExposedMcpToolNames {
  serverName: string;
  toolNames: readonly string[];
}

export function assertUniqueExposedMcpToolNames(
  servers: readonly ExposedMcpToolNames[]
): void {
  const ownerByToolName = new Map<string, string>();
  for (const server of servers) {
    for (const toolName of server.toolNames) {
      const owner = ownerByToolName.get(toolName);
      if (owner !== undefined) {
        throw new Error(
          `Duplicate exposed MCP tool name: ${toolName} (${owner}, ${server.serverName})`
        );
      }
      ownerByToolName.set(toolName, server.serverName);
    }
  }
}

function descriptorKey(
  descriptor: Pick<McpToolRiskDescriptorV1, "serverName" | "toolName">
): string {
  return `${descriptor.serverName}\u0000${descriptor.toolName}`;
}

export function parseMcpToolRiskDescriptors(
  candidates: readonly unknown[]
): McpToolRiskDescriptorV1[] {
  const descriptors: McpToolRiskDescriptorV1[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const parsed = mcpToolRiskDescriptorV1Schema.safeParse(candidate);
    if (!parsed.success) continue;
    const identity = descriptorKey(parsed.data);
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate MCP risk descriptor: ${parsed.data.serverName}/${parsed.data.toolName}`
      );
    }
    identities.add(identity);
    descriptors.push(parsed.data);
  }
  return descriptors;
}

export function findMcpToolRiskDescriptor(
  descriptors: readonly McpToolRiskDescriptorV1[],
  serverName: string,
  toolName: string
): McpToolRiskDescriptorV1 | undefined {
  const identity = descriptorKey({ serverName, toolName });
  return descriptors.find((descriptor) => descriptorKey(descriptor) === identity);
}

export function toMcpToolRiskPolicy(
  descriptor: McpToolRiskDescriptorV1
): ToolRiskPolicy {
  return {
    toolName: descriptor.toolName,
    riskTier: descriptor.riskTier,
    actions: [...descriptor.actions],
    requireConfirmation: descriptor.requireConfirmation,
    resourceRefResolver: (_input, scope) => ({
      resourceType: descriptor.resource.resourceType,
      resourceId: `${descriptor.serverName}:${descriptor.toolName}`,
      tenantId: scope.tenantId,
      ownerScopeId: scope.scopeId,
    }),
  };
}

export function createMcpToolRiskPoliciesForExposedTools(
  servers: readonly ExposedMcpToolNames[],
  descriptors: readonly McpToolRiskDescriptorV1[]
): ToolRiskPolicy[] {
  return servers.flatMap(({ serverName, toolNames }) =>
    toolNames.flatMap((toolName) => {
      const descriptor = findMcpToolRiskDescriptor(
        descriptors,
        serverName,
        toolName
      );
      return descriptor === undefined ? [] : [toMcpToolRiskPolicy(descriptor)];
    })
  );
}
