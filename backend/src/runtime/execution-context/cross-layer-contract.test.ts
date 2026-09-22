import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { executionContextSchema } from "./execution-context.js";
import { readExecutionCorrelation, readExecutionContext } from "./read-execution-context.js";
import {
  confirmationInterruptPayloadSchema,
  confirmationResumeSchema,
} from "../authorization/confirmation.js";
import { SCOPE_TYPES } from "../authorization/scope.js";
import { parseMcpToolRiskDescriptors } from "../../tools/authorization/mcp-risk.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as {
  validContext: Record<string, unknown>;
  legacyConfig: Record<string, unknown>;
  malformedRequestId: string;
  oversizedIdLength: number;
  unknownField: string;
  concurrentRunIds: string[];
  trustedAuthorization: {
    scopeTypes: string[];
    principalHeaders: string[];
    activeScopeHeaders: string[];
    permissionScopes: string[];
    permissionScopesCsv: string;
    mcpRiskDescriptor: Record<string, unknown>;
    confirmation: {
      interrupt: Record<string, unknown>;
      resumeApprove: Record<string, unknown>;
    };
    scenarioMatrix: Record<string, string>;
  };
};

const langGraphConfig = JSON.parse(readFileSync(
  new URL("../../../langgraph.json", import.meta.url),
  "utf8"
)) as { http: { configurable_headers: { includes: string[] } } };

describe("shared execution context contract", () => {
  it("maps legacy header and config aliases from the shared fixture", () => {
    expect(readExecutionCorrelation(fixture.legacyConfig)).toMatchObject({
      requestId: fixture.validContext.requestId,
      threadId: fixture.validContext.threadId,
      runId: fixture.validContext.runId,
      taskId: fixture.validContext.taskId,
      stepId: fixture.validContext.stepId,
    });
  });

  it("rejects shared malformed, oversized, and unknown fields", () => {
    expect(() => readExecutionCorrelation({
      configurable: { "x-request-id": fixture.malformedRequestId },
    })).toThrow();
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      requestId: fixture.malformedRequestId,
    }).success).toBe(false);
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      requestId: "x".repeat(fixture.oversizedIdLength),
    }).success).toBe(false);
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      [fixture.unknownField]: "typo",
    }).success).toBe(false);
  });

  it("isolates concurrent runs with no shared mutable correlation", async () => {
    const contexts = await Promise.all(fixture.concurrentRunIds.map(async (runId) =>
      readExecutionContext(null, {
        configurable: {
          execution_context: { ...fixture.validContext, runId },
        },
      })
    ));
    expect(contexts.map((context) => context.runId)).toEqual(fixture.concurrentRunIds);
    expect(contexts[0]).not.toBe(contexts[1]);
  });

  it("allowlists canonical trusted identity and active-scope headers only", () => {
    const includes = langGraphConfig.http.configurable_headers.includes;
    const canonical = [
      ...fixture.trustedAuthorization.principalHeaders,
      ...fixture.trustedAuthorization.activeScopeHeaders,
    ];
    expect(includes).toEqual(expect.arrayContaining(canonical));
    expect(includes).not.toEqual(expect.arrayContaining(["x-user-id", "x-tenant-id"]));
  });

  it("keeps backend scope types aligned with the shared cross-layer fixture", () => {
    expect([...SCOPE_TYPES]).toEqual(fixture.trustedAuthorization.scopeTypes);
  });

  it("round-trips permission scope CSV with a single scalar active scope", () => {
    const context = readExecutionContext(undefined, {
      configurable: {
        ...fixture.legacyConfig.configurable as Record<string, unknown>,
        "x-bff-principal-id": "principal-1",
        "x-bff-principal-type": "user",
        "x-bff-tenant-id": "tenant-1",
        "x-bff-roles": "member",
        "x-bff-scopes": fixture.trustedAuthorization.permissionScopesCsv,
        "x-bff-auth-source": "trusted_gateway",
        "x-bff-authenticated-at": "2026-09-20T00:00:00.000Z",
        "x-bff-scope-id": "scope-1",
        "x-bff-scope-type": "tenant",
      },
    }, "production");
    expect(context.principal.scopes).toEqual(
      fixture.trustedAuthorization.permissionScopes
    );
    expect(context.scope).toMatchObject({ scopeId: "scope-1", scopeType: "tenant" });
  });

  it("validates the shared MCP and confirmation contract matrix", () => {
    expect(
      parseMcpToolRiskDescriptors([
        fixture.trustedAuthorization.mcpRiskDescriptor,
      ])
    ).toHaveLength(1);
    expect(
      confirmationInterruptPayloadSchema.parse(
        fixture.trustedAuthorization.confirmation.interrupt
      ).schemaVersion
    ).toBe("1.0");
    expect(
      confirmationResumeSchema.parse(
        fixture.trustedAuthorization.confirmation.resumeApprove
      ).decision
    ).toBe("approve");
    expect(Object.keys(fixture.trustedAuthorization.scenarioMatrix).sort()).toEqual(
      ["allow", "confirm", "crossTenant", "deny", "replay", "restart", "timeout"]
    );
  });
});
