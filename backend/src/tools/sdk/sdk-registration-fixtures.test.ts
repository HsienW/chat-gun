import { MANIFEST_SCHEMA_VERSION } from "@gun-ai/harness-contracts";
import { registerTool, type RegistrationInput } from "@gun-ai/harness-sdk";
import { createSdkRegistrationFailureFixture } from "@gun-ai/harness-testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RuntimeToolDescriptorRegistry } from "../../runtime/tool-dispatch/runtime-tool-descriptor.js";

type FailureKind = "duplicate_tool_id" | "invalid_schema";

function createManualInput(kind: FailureKind): RegistrationInput {
  const manifest = {
    kind: "tool",
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    toolId: "fixture_read_tool",
    toolVersion: "1.0",
    description: "Read fixture value",
    inputSchema: z.object({ value: z.string() }).strict(),
    outputSchema: z.string(),
    sideEffectClass: "read-only",
    requiredCapabilities: ["tool:read"],
    executionProfile: {
      profileId: "fixture-read-profile",
      profileVersion: "1.0",
      egress: { destinations: [], protocols: [] },
    },
    idempotency: { kind: "read_only" },
    approvalPolicyKey: "none",
    timeoutRetryClass: "fixture-read-default",
    compensation: "none",
    dataClassification: "tool:public",
  };
  return kind === "duplicate_tool_id"
    ? { manifest, existingTools: [{ toolId: manifest.toolId, toolVersion: manifest.toolVersion }] }
    : { manifest: { ...manifest, inputSchema: { safeParse: () => ({ success: true }) } } };
}

function createPublishedRegistry(kind: FailureKind): RuntimeToolDescriptorRegistry {
  const registry = new RuntimeToolDescriptorRegistry();
  if (kind === "duplicate_tool_id") {
    registry.register(
      { toolName: "fixture_read_tool", toolVersion: "1.0" },
      {
        toolName: "fixture_read_tool",
        toolVersion: "1.0",
        inputSchema: z.object({ value: z.string() }).strict(),
        outputSchema: z.string(),
        riskTier: "read",
        isReadOnly: true,
        isConcurrencySafe: () => true,
        timeoutPolicy: { timeoutMs: 1_000 },
        retryPolicy: {
          maxAttempts: 1,
          maxElapsedMs: 1_000,
          retryableCategories: [],
          backoffStrategy: "fixed",
          jitter: false,
        },
        interruptBehavior: "cancel_safe",
      }
    );
  }
  return registry;
}

describe("SDK registration fixture parity", () => {
  it.each(["duplicate_tool_id", "invalid_schema"] as const)(
    "keeps identical failure identity and production registry snapshot for %s",
    async (kind) => {
      const shared = createSdkRegistrationFailureFixture(kind);
      const manual = createManualInput(kind);
      const observations = [];
      for (const input of [manual, shared.input]) {
        const registry = createPublishedRegistry(kind);
        const snapshot = () => registry.list().map(({ toolName, toolVersion }) => ({ toolName, toolVersion }));
        const before = snapshot();
        const result = await registerTool(input);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("A failure fixture registered successfully");
        expect(result.error.code).toBe(shared.expectedCode);
        expect(result.error.toolId).toBe("fixture_read_tool");
        const after = snapshot();
        expect(after).toEqual(before);
        observations.push({ error: result.error, before, after });
      }
      expect(observations[1]).toEqual(observations[0]);
    }
  );
});
