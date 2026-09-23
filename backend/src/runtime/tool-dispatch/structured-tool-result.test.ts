import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import {
  createStructuredToolResultEnvelope,
  structuredToolResultEnvelopeSchema,
  toLegacyToolResult,
  tryToLegacyToolResult,
} from "./structured-tool-result.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "tool-call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: "2026-09-23T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "principal" as const,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
  },
};

const descriptor: RuntimeToolDescriptor<unknown, string> = {
  toolName: "read_tool",
  toolVersion: "1.0",
  inputSchema: z.unknown(),
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
};

describe("StructuredToolResultEnvelope", () => {
  it("keeps successful output and canonical correlation structured", () => {
    const envelope = createStructuredToolResultEnvelope({
      executionContext,
      descriptor,
      outcome: { type: "succeeded", result: "ok" },
      emittedAt: "2026-09-23T01:00:00.000Z",
    });

    expect(envelope).toEqual({
      schemaVersion: "1.0",
      kind: "tool_result",
      correlation: {
        requestId: "request-1",
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "tool-call-1",
        stepId: "step-1",
      },
      tool: {
        name: "read_tool",
        version: "1.0",
        riskTier: "read",
        readOnly: true,
      },
      outcome: { type: "succeeded", result: "ok" },
      emittedAt: "2026-09-23T01:00:00.000Z",
    });
    expect(structuredToolResultEnvelopeSchema.safeParse(envelope).success).toBe(
      true
    );
  });

  it("keeps non-success state typed and only derives legacy text in the adapter", () => {
    const envelope = createStructuredToolResultEnvelope({
      executionContext,
      descriptor,
      outcome: {
        type: "denied_by_authorization",
        errorCode: "AUTHORIZATION_DENIED",
        decisionId: "decision-1",
      },
    });

    expect(envelope.outcome).toEqual({
      type: "denied_by_authorization",
      errorCode: "AUTHORIZATION_DENIED",
      decisionId: "decision-1",
    });
    expect(toLegacyToolResult(envelope)).toContain("AUTHORIZATION_DENIED");
    expect(tryToLegacyToolResult(envelope)).toContain("AUTHORIZATION_DENIED");
    expect(tryToLegacyToolResult("legacy-result")).toBeUndefined();
  });

  it("does not create an envelope without a canonical toolCallId", () => {
    expect(() =>
      createStructuredToolResultEnvelope({
        executionContext: { ...executionContext, toolCallId: undefined },
        descriptor,
        outcome: { type: "succeeded", result: "ok" },
      })
    ).toThrow("Structured tool result requires toolCallId");
  });
});
