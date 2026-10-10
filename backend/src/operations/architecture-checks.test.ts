import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { runArchitectureChecks } from "./architecture-checks.js";
import { EXECUTION_PROFILE_ENFORCEMENT_MARKER } from "../runtime/tool-dispatch/execution-profile.js";

const CONTRACT_API_SURFACE = JSON.parse(readFileSync(
  new URL("../../node_modules/@gun-ai/harness-contracts/api-surface.json", import.meta.url),
  "utf8"
)) as { runtime: string[]; types: string[] };

const DELIBERATE_BYPASSES = [
  {
    checkId: "profile-missing-dispatch",
    sources: [{ path: "deliberate-regression.ts", source: "sourceTool.invoke(input)" }],
  },
  {
    checkId: "egress-bypass",
    sources: [{ path: "deliberate-regression.ts", source: "const response = await fetch(url)" }],
  },
  {
    checkId: "secret-into-context",
    sources: [{ path: "deliberate-regression.ts", source: "const secret = configurable.apiKey" }],
  },
  {
    checkId: "direct-protected-tool-invocation",
    sources: [{ path: "deliberate-regression.ts", source: "protectedTool.invoke(input)" }],
  },
  {
    checkId: "mutation-descriptor-missing",
    sources: [{
      path: "deliberate-regression.ts",
      source: "const descriptor = { isReadOnly: false, toolName: 'write' };",
    }],
  },
  {
    checkId: "production-registry-authorization-missing",
    sources: [{
      path: "deliberate-regression.ts",
      source: "createProductionRegistry({ authorization: undefined });",
    }],
  },
  {
    checkId: "unversioned-runtime-event-producer",
    sources: [{
      path: "deliberate-regression.ts",
      source: "const item = { runtimeEvent: true, type: 'run.started' };",
    }],
  },
  {
    checkId: "agent-legacy-context-assembly",
    sources: [{
      path: "deliberate-regression.ts",
      source: "buildConversationContext(messages);",
    }],
  },
  {
    checkId: "client-controlled-trusted-identity",
    sources: [{
      path: "deliberate-regression.ts",
      source: "const principal = configurable.principalId;",
    }],
  },
  {
    checkId: "harness-forbidden-dependency",
    sources: [{
      path: "packages/contracts/src/index.ts",
      source: 'import type { RunnableConfig } from "@langchain/core/runnables";',
    }],
  },
  {
    checkId: "harness-forbidden-dependency",
    sources: [{
      path: "packages/contracts/src/index.ts",
      source: 'import type { AgentTask } from "../../../backend/src/runtime/types.js";',
    }],
  },
  {
    checkId: "harness-cycle",
    sources: [
      {
        path: "packages/contracts/src/index.ts",
        source: 'export type { KernelValue } from "@gun-ai/harness-kernel";',
      },
      {
        path: "packages/kernel/src/index.ts",
        source: 'import type { ExecutionContext } from "@gun-ai/harness-contracts";',
      },
    ],
  },
  {
    checkId: "chat-gun-parallel-local-definition",
    sources: [
      {
        path: "backend/src/consumer.ts",
        source: 'import type { ExecutionContext } from "@gun-ai/harness-contracts/execution";',
      },
      {
        path: "backend/src/runtime/execution-context/execution-context.ts",
        source: "export interface ExecutionContext { runId: string }",
      },
    ],
  },
] as const;

describe("production runtime architecture checks", () => {
  it("does not report the current production Agent/runtime sources", () => {
    const productionPaths = [
      "../agents/chatbot.ts",
      "../agents/math-agent.ts",
      "../agents/mcp-agent.ts",
      "../agents/deep-researcher.ts",
      "../tools/registry.ts",
      "../tools/web-search.ts",
      "../tools/web-fetch.ts",
      "../tools/weather.ts",
      "../tools/mcp-loader.ts",
      "../platform/tool-governance.ts",
      "../runtime/tool-dispatch/pipeline.ts",
      "../runtime/event-envelope.ts",
      "../runtime/event-payloads.ts",
      "../runtime/event-sequence.ts",
      "../runtime/types.ts",
      "../runtime/run-status.ts",
      "../runtime/execution-context/execution-context.ts",
      "../runtime/authorization/principal.ts",
      "../runtime/authorization/scope.ts",
      "../runtime/authorization/consumer-identity.ts",
      "../runtime/authorization/authorization.ts",
      "../runtime/authorization/confirmation.ts",
      "../runtime/side-effect/identity.ts",
      "../runtime/side-effect/governed-outcome.ts",
      "../runtime/retry/error-classification.ts",
      "../runtime/retry/retry-policy.ts",
      "../runtime/retry/backoff.ts",
      "../runtime/retry/retry-budget.ts",
      "../runtime/idempotency/idempotency-key.ts",
      "../runtime/recovery/interrupt-manifest.ts",
      "../runtime/persistence/version-compatibility.ts",
      "../runtime/tool-dispatch/runtime-tool-descriptor.ts",
      "../runtime/tool-dispatch/structured-tool-result.ts",
    ];
    const harnessPaths = [
      "@gun-ai/harness-contracts/src/authorization.ts",
      "@gun-ai/harness-contracts/src/events.ts",
      "@gun-ai/harness-contracts/src/identity.ts",
      "@gun-ai/harness-contracts/src/index.ts",
      "@gun-ai/harness-contracts/src/lifecycle.ts",
      "@gun-ai/harness-contracts/src/recovery.ts",
      "@gun-ai/harness-contracts/src/retry.ts",
      "@gun-ai/harness-contracts/src/side-effect.ts",
      "@gun-ai/harness-contracts/src/tool.ts",
      "@gun-ai/harness-kernel/src/authorization.ts",
      "@gun-ai/harness-kernel/src/events.ts",
      "@gun-ai/harness-kernel/src/idempotency.ts",
      "@gun-ai/harness-kernel/src/index.ts",
      "@gun-ai/harness-kernel/src/retry.ts",
      "@gun-ai/harness-kernel/src/side-effect.ts",
      "@gun-ai/harness-kernel/src/version-compatibility.ts",
      "@gun-ai/harness-testkit/src/deterministic.ts",
      "@gun-ai/harness-testkit/src/failures.ts",
      "@gun-ai/harness-testkit/src/fixtures.ts",
      "@gun-ai/harness-testkit/src/index.ts",
    ];
    const sources = productionPaths.map((path) => ({
      path,
      source: readFileSync(new URL(path, import.meta.url), "utf8"),
    })).concat(harnessPaths.map((path) => ({
      path: `node_modules/${path}`,
      source: readFileSync(
        new URL(`../../node_modules/${path}`, import.meta.url),
        "utf8"
      ),
    }))).concat({
      path: "backend/src/harness-contract-consumer.ts",
      source: `import {
        ${[...CONTRACT_API_SURFACE.runtime, ...CONTRACT_API_SURFACE.types].join(",\n")}
      } from "@gun-ai/harness-contracts";`,
    });

    expect(runArchitectureChecks({
      sources,
      runtimeSymbols: [EXECUTION_PROFILE_ENFORCEMENT_MARKER],
    })).toMatchObject({
      status: "passed",
      findings: [],
    });
  });

  it.each(DELIBERATE_BYPASSES)(
    "fails for deliberate $checkId bypass",
    ({ checkId, sources }) => {
      const result = runArchitectureChecks({
        sources,
      });

      expect(result.status).toBe("failed");
      expect(result.findings).toContainEqual(
        expect.objectContaining({ checkId }),
      );
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
