import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContext } from "../execution-context/execution-context.js";
import { createCheckpointFixture } from "../persistence/checkpoint-fixture.testing.js";
import { isRunTerminalStatus, transitionRunStatus, type RunStatus } from "../run-status.js";
import { createReferenceAdapter } from "./reference-adapter.js";
import type { FrameworkInvocation, FrameworkObservation, FrameworkOutcome } from "./registry.js";

function fixture(execute: (mode: "invoke" | "resume", request: FrameworkInvocation) => Promise<FrameworkOutcome>) {
  const { metadata, policy } = createCheckpointFixture();
  const observations: FrameworkObservation[] = [];
  let status: RunStatus = "running";
  const observe = async (observation: FrameworkObservation) => {
    if (isRunTerminalStatus(status)) return;
    if (observation.kind === "terminal") {
      const transition = transitionRunStatus(status, observation.status);
      if (!transition.accepted) return;
      status = transition.status;
    }
    observations.push(observation);
  };
  const context: ExecutionContext = {
    requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1", stepId: "step-1", attempt: 1,
    principal: { principalId: "principal-1", principalType: "user", tenantId: "tenant-1", roles: [], scopes: [], authSource: "trusted_gateway", authenticatedAt: "2026-10-14T00:00:00.000Z" },
    scope: { scopeId: "scope-1", scopeType: "tenant", tenantId: "tenant-1" },
  };
  const request: FrameworkInvocation & { context: ExecutionContext } = { input: null, context, checkpoint: metadata, signal: new AbortController().signal, observe };
  const adapter = createReferenceAdapter({ adapterId: "reference", timeoutMs: 10, policy: () => policy, execute });
  return { adapter, request, observations, observe };
}

afterEach(() => vi.useRealTimers());

describe("internal reference adapter", () => {
  it("delegates invocation and resume to the same trusted host without owning terminal writes", async () => {
    const execute = vi.fn(async (mode: "invoke" | "resume", request: FrameworkInvocation): Promise<FrameworkOutcome> => {
      await request.observe({ kind: "step", stepId: "step-1", attempt: 1, phase: "started" });
      if (mode === "invoke") {
        await request.observe({ kind: "checkpoint", metadata: request.checkpoint });
        return { status: "waiting", checkpoint: request.checkpoint };
      }
      await request.observe({ kind: "terminal", status: "completed" });
      return { status: "completed", output: "done" };
    });
    const { adapter, request, observations } = fixture(execute);
    expect(await adapter.invoke(request)).toMatchObject({ status: "waiting" });
    expect(await adapter.resume(request)).toEqual({ status: "completed", output: "done" });
    expect(execute.mock.calls.map(([mode]) => mode)).toEqual(["invoke", "resume"]);
    expect(observations.filter((observation) => observation.kind === "terminal")).toHaveLength(1);
  });

  it("parks unknown versions before either execution path and preserves metadata", async () => {
    const execute = vi.fn();
    const { adapter, request } = fixture(execute);
    request.checkpoint.adapterVersion = "9.0.0";
    const before = structuredClone(request.checkpoint);
    await expect(adapter.invoke(request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    await expect(adapter.resume(request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(execute).not.toHaveBeenCalled();
    expect(request.checkpoint).toEqual(before);
  });

  it.each(["product", "native"] as const)("rejects a %s checkpoint binding even when the supplied policy agrees with it", async (binding) => {
    const { metadata, policy } = createCheckpointFixture();
    const execute = vi.fn(async (): Promise<FrameworkOutcome> => ({ status: "completed", output: null }));
    const { request } = fixture(execute);
    const forged = structuredClone(metadata);
    if (binding === "product") forged.productIdentityRef.runId = "other-run";
    else forged.nativeCheckpointRef.threadId = "other-thread";
    request.checkpoint = forged;
    const adapter = createReferenceAdapter({
      adapterId: "reference", timeoutMs: 10,
      policy: () => ({ ...policy, productIdentityRef: forged.productIdentityRef, nativeCheckpointRef: forged.nativeCheckpointRef }),
      execute,
    });
    await expect(adapter.invoke(request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid trusted context before host execution", async () => {
    const execute = vi.fn(async (): Promise<FrameworkOutcome> => ({ status: "completed", output: null }));
    const { adapter, request } = fixture(execute);
    request.context = { ...request.context, scope: { ...request.context.scope, tenantId: "other-tenant" } };
    await expect(adapter.invoke(request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("parks malformed checkpoint input with a typed error before host execution", async () => {
    const execute = vi.fn(async (): Promise<FrameworkOutcome> => ({ status: "completed", output: null }));
    const { adapter, request } = fixture(execute);
    Reflect.set(request, "checkpoint", null);
    await expect(adapter.resume(request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves typed host failure without leaking unexpected errors", async () => {
    const { adapter, request } = fixture(async () => ({ status: "failed", reasonCode: "POLICY_DENIED" }));
    expect(await adapter.invoke(request)).toEqual({ status: "failed", reasonCode: "POLICY_DENIED" });
    const failing = fixture(async () => { throw new Error("private credential"); });
    await expect(failing.adapter.invoke(failing.request)).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED", message: "ADAPTER_OPERATION_FAILED" });
  });

  it.each(["timeout", "cancel", "upstream"])("bounds %s and suppresses late observations", async (mode) => {
    vi.useFakeTimers();
    let runningRequest: FrameworkInvocation | undefined;
    const { adapter, request, observations } = fixture(async (_mode, forwarded) => {
      runningRequest = forwarded;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    request.signal = controller.signal;
    const pending = adapter.invoke(request);
    const rejection = expect(pending).rejects.toMatchObject({ code: mode === "timeout" ? "ADAPTER_OPERATION_TIMEOUT" : "ADAPTER_OPERATION_CANCELLED" });
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(10);
    else if (mode === "cancel") await adapter.cancel("run-1");
    else controller.abort();
    await rejection;
    expect(runningRequest?.signal.aborted).toBe(true);
    await expect(runningRequest?.observe({ kind: "terminal", status: "completed" })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(observations).toEqual([]);
  });

  it.each(["completed", "cancelled"] as const)("uses the existing host terminal guard when %s arrives first", async (winner) => {
    const { adapter, request, observations, observe } = fixture(async (_mode, forwarded) => {
      await forwarded.observe({ kind: "terminal", status: winner });
      await forwarded.observe({ kind: "terminal", status: winner === "completed" ? "cancelled" : "completed" });
      return { status: "completed", output: null };
    });
    await adapter.invoke(request);
    await observe({ kind: "terminal", status: winner });
    expect(observations).toEqual([{ kind: "terminal", status: winner }]);
  });

  it("rejects overlapping execution without disturbing the admitted invocation", async () => {
    const { adapter, request } = fixture(async () => new Promise(() => {}));
    const pending = adapter.invoke(request);
    const rejection = expect(pending).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    await expect(adapter.resume(request)).rejects.toMatchObject({ code: "ADAPTER_DUPLICATE" });
    await adapter.cancel("run-1");
    await rejection;
  });
});
