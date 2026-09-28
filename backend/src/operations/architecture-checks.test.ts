import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { runArchitectureChecks } from "./architecture-checks.js";

const DELIBERATE_BYPASSES = [
  ["direct-protected-tool-invocation", "protectedTool.invoke(input)"],
  [
    "mutation-descriptor-missing",
    "const descriptor = { isReadOnly: false, toolName: 'write' };",
  ],
  [
    "production-registry-authorization-missing",
    "createProductionRegistry({ authorization: undefined });",
  ],
  [
    "unversioned-runtime-event-producer",
    "const item = { runtimeEvent: true, type: 'run.started' };",
  ],
  ["agent-legacy-context-assembly", "buildConversationContext(messages);"],
  [
    "client-controlled-trusted-identity",
    "const principal = configurable.principalId;",
  ],
] as const;

describe("production runtime architecture checks", () => {
  it("does not report the current production Agent/runtime sources", () => {
    const sources = [
      "../agents/chatbot.ts",
      "../agents/math-agent.ts",
      "../agents/mcp-agent.ts",
      "../agents/deep-researcher.ts",
      "../tools/registry.ts",
      "../runtime/tool-dispatch/pipeline.ts",
      "../runtime/event-envelope.ts",
    ].map((path) => ({
      path,
      source: readFileSync(new URL(path, import.meta.url), "utf8"),
    }));

    expect(runArchitectureChecks({ sources })).toMatchObject({
      status: "passed",
      findings: [],
    });
  });

  it.each(DELIBERATE_BYPASSES)(
    "fails for deliberate %s bypass",
    (checkId, source) => {
      const result = runArchitectureChecks({
        sources: [{ path: "deliberate-regression.ts", source }],
      });

      expect(result.status).toBe("failed");
      expect(result.findings).toEqual([
        expect.objectContaining({ checkId, path: "deliberate-regression.ts" }),
      ]);
    }
  );

  it("keeps mutation registration fail-closed without a side-effect descriptor", () => {
    const registry = new RuntimeToolDescriptorRegistry();

    expect(() =>
      registry.register(
        { toolName: "mutation", toolVersion: "1.0" },
        {
          toolName: "mutation",
          toolVersion: "1.0",
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          riskTier: "write",
          isReadOnly: false,
          isConcurrencySafe: () => false,
          timeoutPolicy: { timeoutMs: 1_000 },
          retryPolicy: {
            maxAttempts: 1,
            maxElapsedMs: 1_000,
            retryableCategories: [],
            backoffStrategy: "fixed",
            jitter: false,
          },
          interruptBehavior: "reconcile_first",
        }
      )
    ).toThrow("Mutation runtime tool descriptor requires sideEffect");
  });

  it("applies a bounded override and records an audit entry", () => {
    const result = runArchitectureChecks({
      sources: [
        {
          path: "agent.ts",
          source: "buildConversationContext(messages);",
        },
      ],
      overrideConfig:
        "agent-legacy-context-assembly:APPROVED_FALSE_POSITIVE:2026-09-28T12:00:00.000Z",
      now: new Date("2026-09-28T11:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "passed",
      findings: [],
      overrideAudit: [
        {
          checkId: "agent-legacy-context-assembly",
          reasonCode: "APPROVED_FALSE_POSITIVE",
          expiry: "2026-09-28T12:00:00.000Z",
          outcome: "applied",
        },
      ],
    });
  });

  it.each([
    ["expired", "2026-09-28T10:00:00.000Z"],
    ["beyond maximum TTL", "2026-09-30T11:00:00.000Z"],
  ])("fails for an %s override", (_label, expiry) => {
    const result = runArchitectureChecks({
      sources: [
        {
          path: "agent.ts",
          source: "buildConversationContext(messages);",
        },
      ],
      overrideConfig: `agent-legacy-context-assembly:APPROVED_FALSE_POSITIVE:${expiry}`,
      now: new Date("2026-09-28T11:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toHaveLength(1);
    expect(result.overrideAudit[0]?.outcome).toMatch(/expired|invalid/);
  });
});
