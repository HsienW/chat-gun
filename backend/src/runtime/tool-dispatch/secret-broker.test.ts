import { describe, expect, it } from "vitest";

import {
  EnvironmentSecretBroker,
  readResolvedSecret,
  secretReferenceSchema,
} from "./secret-broker.js";

const executionContext = {
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  toolCallId: "call-1",
  attempt: 1,
  principal: {
    principalId: "principal-1",
    principalType: "user" as const,
    tenantId: "tenant-1",
    roles: [],
    scopes: [],
    authSource: "development" as const,
    authenticatedAt: "2026-10-03T00:00:00.000Z",
  },
  scope: {
    scopeId: "scope-1",
    scopeType: "principal" as const,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
  },
};

const reference = secretReferenceSchema.parse({
  secretRef: "env:TAVILY_API_KEY",
  secretName: "TAVILY_API_KEY",
  scope: "tool:web_search",
});
describe("EnvironmentSecretBroker", () => {
  it("resolves an allowlisted reference at the final execution edge", async () => {
    const broker = new EnvironmentSecretBroker({
      references: { "env:TAVILY_API_KEY": "TAVILY_API_KEY" },
      readEnvironment: (name) =>
        name === "TAVILY_API_KEY" ? "test-secret-value" : undefined,
    });

    await expect(broker.resolve(reference, executionContext)).resolves.toEqual({
      value: "test-secret-value",
    });
  });

  it("fails closed for an unresolvable reference", async () => {
    const broker = new EnvironmentSecretBroker({
      references: {},
      readEnvironment: () => undefined,
    });

    await expect(broker.resolve(reference, executionContext)).rejects.toMatchObject({
      code: "SECRET_REFERENCE_UNRESOLVABLE",
    });
  });

  it("actively rejects an expired lease", async () => {
    const broker = new EnvironmentSecretBroker({
      references: { "env:TAVILY_API_KEY": "TAVILY_API_KEY" },
      readEnvironment: () => "test-secret-value",
      now: () => new Date("2026-10-03T12:00:00.000Z"),
    });

    await expect(
      broker.resolve(
        {
          ...reference,
          lease: {
            leaseId: "lease-1",
            expiresAt: "2026-10-03T11:59:59.000Z",
          },
        },
        executionContext
      )
    ).rejects.toMatchObject({ code: "SECRET_REFERENCE_UNRESOLVABLE" });
  });

  it("does not expose undeclared secrets from execution config", () => {
    expect(readResolvedSecret({}, reference.secretRef)).toBeUndefined();
  });
});
