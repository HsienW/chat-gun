import { describe, expect, it } from "vitest";

import { executionContextSchema } from "./execution-context.js";

const validContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user",
    tenantId: "tenant-1",
    roles: ["member"],
    scopes: ["orders:read"],
    authSource: "trusted_gateway",
    authenticatedAt: "2026-09-20T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "tenant",
    tenantId: "tenant-1",
  },
};

describe("executionContextSchema", () => {
  it("accepts a complete context without optional execution identifiers", () => {
    expect(executionContextSchema.parse(validContext)).toEqual(validContext);
  });

  it.each(["requestId", "threadId", "runId", "taskId", "principal", "scope"])(
    "rejects a missing mandatory %s",
    (field) => {
      const context = { ...validContext } as Record<string, unknown>;
      delete context[field];
      expect(executionContextSchema.safeParse(context).success).toBe(false);
    }
  );

  it("rejects malformed and oversized identifiers", () => {
    expect(executionContextSchema.safeParse({ ...validContext, runId: "bad id" }).success).toBe(false);
    expect(executionContextSchema.safeParse({ ...validContext, requestId: "x".repeat(257) }).success).toBe(false);
  });

  it("rejects unknown top-level and nested fields", () => {
    expect(executionContextSchema.safeParse({ ...validContext, runID: "typo" }).success).toBe(false);
    expect(executionContextSchema.safeParse({
      ...validContext,
      principal: { ...validContext.principal, token: "unexpected" },
    }).success).toBe(false);
  });

  it("rejects invalid attempt and principal or scope shapes", () => {
    expect(executionContextSchema.safeParse({ ...validContext, attempt: 0 }).success).toBe(false);
    expect(executionContextSchema.safeParse({ ...validContext, scope: { ...validContext.scope, scopeId: "" } }).success).toBe(false);
  });

  it("rejects a scope from another tenant", () => {
    expect(executionContextSchema.safeParse({
      ...validContext,
      scope: { ...validContext.scope, tenantId: "other-tenant" },
    }).success).toBe(false);
  });
});
