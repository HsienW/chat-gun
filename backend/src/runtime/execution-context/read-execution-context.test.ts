import { describe, expect, it } from "vitest";

import {
  readExecutionContext,
  readExecutionCorrelation,
  withExecutionContext,
} from "./read-execution-context.js";

const trustedIdentity = {
  "x-bff-principal-id": "principal-1",
  "x-bff-principal-type": "user",
  "x-bff-tenant-id": "tenant-1",
  "x-bff-roles": "member",
  "x-bff-scopes": "orders:read",
  "x-bff-auth-source": "trusted_gateway",
  "x-bff-authenticated-at": "2026-09-20T00:00:00.000Z",
  "x-bff-scope-id": "scope-1",
  "x-bff-scope-type": "tenant",
};

const legacyConfig = {
  configurable: {
    thread_id: "thread-1",
    run_id: "run-1",
    task_id: "task-1",
    step_id: "step-1",
    tool_call_id: "tool-1",
    "x-request-id": "request-1",
    ...trustedIdentity,
  },
};

describe("readExecutionContext", () => {
  it("maps legacy keys and trusted identity at one boundary", () => {
    expect(readExecutionContext(undefined, legacyConfig, "production")).toMatchObject({
      requestId: "request-1",
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      toolCallId: "tool-1",
      principal: { principalId: "principal-1" },
      scope: { scopeId: "scope-1", tenantId: "tenant-1" },
    });
  });

  it("accepts top-level runId and rejects conflicting locations", () => {
    const { run_id: _runId, ...withoutRunId } = legacyConfig.configurable;
    expect(readExecutionContext(undefined, { runId: "run-1", configurable: withoutRunId }, "production").runId).toBe("run-1");
    expect(() => readExecutionContext(undefined, { ...legacyConfig, runId: "run-2" }, "production")).toThrow();
  });

  it("does not invent taskId from runId or threadId", () => {
    const { task_id: _taskId, ...withoutTaskId } = legacyConfig.configurable;
    expect(() => readExecutionContext(undefined, { configurable: withoutTaskId }, "production")).toThrow();
  });

  it("fails closed for missing identity in production and unknown profiles", () => {
    const config = { configurable: {
      thread_id: "thread-1", run_id: "run-1", task_id: "task-1", "x-request-id": "request-1",
    } };
    expect(() => readExecutionContext(undefined, config, "production")).toThrow();
    expect(() => readExecutionContext(undefined, config, "unknown")).toThrow();
    expect(readExecutionContext(undefined, config, "development").principal.authSource).toBe("development");
  });

  it("does not replace malformed trusted identity with development identity", () => {
    expect(() => readExecutionContext(undefined, {
      configurable: { ...legacyConfig.configurable, "x-bff-principal-type": "invalid" },
    }, "development")).toThrow();
  });

  it.each([
    { "x-bff-scope-id": ["scope-1", "scope-2"] },
    { "x-bff-scope-id": '["scope-1","scope-2"]' },
    { "x-bff-scope-id": "scope-1,scope-2" },
    { "x-bff-scope-type": ["tenant", "team"] },
    { "x-bff-scope-type": '["tenant","team"]' },
    { "x-bff-scope-type": "tenant,team" },
  ])("rejects non-scalar or repeated active scope headers: %o", (override) => {
    expect(() => readExecutionContext(undefined, {
      configurable: { ...legacyConfig.configurable, ...override },
    }, "production")).toThrow();
  });

  it("rejects malformed and oversized IDs before consumers see them", () => {
    expect(() => readExecutionContext(undefined, { configurable: { ...legacyConfig.configurable, run_id: "bad id" } }, "production")).toThrow();
    expect(() => readExecutionContext(undefined, { configurable: { ...legacyConfig.configurable, run_id: "x".repeat(257) } }, "production")).toThrow();
  });

  it("keeps concurrent calls isolated", async () => {
    const configs = ["a", "b"].map((suffix) => ({ configurable: {
      ...legacyConfig.configurable,
      run_id: `run-${suffix}`,
      task_id: `task-${suffix}`,
    } }));
    const [first, second] = await Promise.all(configs.map(async (config) => readExecutionContext(undefined, config, "production")));
    expect(first.runId).toBe("run-a");
    expect(second.runId).toBe("run-b");
  });

  it("stores only JSON execution identity in configurable while signal remains top-level", () => {
    const context = readExecutionContext(undefined, legacyConfig, "production");
    const signal = new AbortController().signal;
    const config = withExecutionContext({ configurable: {}, signal }, context);
    expect(config.signal).toBe(signal);
    expect(config.configurable).toEqual({ execution_context: context });
    const serialized = JSON.stringify(config.configurable);
    for (const forbidden of ["abortSignal", "credential", "client", "stream", "function"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(readExecutionContext(undefined, config, "production")).toEqual(context);
  });

  it("rejects unknown fields in a persisted canonical context", () => {
    const context = readExecutionContext(undefined, legacyConfig, "production");
    expect(() => readExecutionContext(undefined, {
      configurable: { execution_context: { ...context, unexpected: "typo" } },
    }, "production")).toThrow();
  });

  it("exposes legacy partial correlation to compatibility consumers", () => {
    expect(readExecutionCorrelation({
      runId: "run-1",
      configurable: {
        thread_id: "thread-1",
        task_id: "task-1",
        step_id: "step-1",
        "x-request-id": "request-1",
      },
    })).toMatchObject({
      requestId: "request-1",
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
    });
  });
});
