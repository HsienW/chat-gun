import { afterEach, describe, expect, it, vi } from "vitest";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { JsonValue } from "@gun-ai/harness-contracts";

import { RunSequenceAllocator } from "../runtime/event-sequence.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { createReferenceAdapter } from "../runtime/framework-adapters/reference-adapter.js";
import { FRAMEWORK_ADAPTER_CAPABILITIES, type FrameworkInvocation, type FrameworkObservation, type FrameworkOutcome } from "../runtime/framework-adapters/registry.js";
import { createCheckpointFixture } from "../runtime/persistence/checkpoint-fixture.testing.js";
import { isRunTerminalStatus } from "../runtime/run-status.js";
import { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import { RuntimeComposition, type RuntimeCompositionCandidate } from "./runtime-composition.js";

const versions = { schemaVersion: "20", eventVersion: "1.0.0", packageVersion: "0.1.0" };

function candidate(): RuntimeCompositionCandidate<string> {
  return {
    versions,
    services: {
      identity: vi.fn(),
      persistence: { read: vi.fn(), append: vi.fn() },
      policy: { authorize: vi.fn() },
      providers: { createChatModel: vi.fn(), createChatModelWithFallback: vi.fn() },
      toolRegistry: new RuntimeToolDescriptorRegistry(),
      sandbox: { capabilities: vi.fn(() => ({ executionModes: ["isolated_process" as const], supportsProcessIsolation: true, supportsFilesystemIsolation: true, supportsEgressIsolation: true, supportsResourceLimits: true })), run: vi.fn() },
      secretBroker: { resolve: vi.fn() },
      scheduling: { schedule: vi.fn() },
      dispatchPipeline: { createExecutor: vi.fn(), hasCompensation: vi.fn(), compensate: vi.fn() },
      sequenceAllocator: new RunSequenceAllocator(),
      eventPublication: { recordAuthoritative: vi.fn(), rebuild: vi.fn() },
      usage: vi.fn(),
    },
    execution: { selectTool: vi.fn(), recovery: { recover: vi.fn() }, outputSchema: z.string() },
    adapters: [async () => ({
      descriptor: { adapterId: "reference", contractVersion: "1.0.0", capabilities: [...FRAMEWORK_ADAPTER_CAPABILITIES] },
      invoke: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    })],
  };
}

afterEach(() => vi.useRealTimers());

describe("trusted runtime composition publication", () => {
  it.each(["supportsProcessIsolation", "supportsFilesystemIsolation", "supportsEgressIsolation", "supportsResourceLimits"] as const)("refuses sandbox without %s and preserves its previous snapshot", async (capability) => {
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => candidate(), { timeoutMs: 100 });
    const previous = root.current();
    const input = candidate();
    const capabilities = input.services.sandbox.capabilities();
    input.services.sandbox.capabilities = () => ({ ...capabilities, [capability]: false });
    await expect(root.install(async () => input, { timeoutMs: 100 })).rejects.toMatchObject({ code: "COMPOSITION_DEPENDENCY_UNAVAILABLE" });
    expect(root.current()).toBe(previous);
  });

  it("runs the existing canonical execution path with the injected identity, dispatch, usage and event owners", async () => {
    const input = candidate();
    const identity = vi.fn(() => ({ requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1", stepId: "step-1", toolCallId: "call-1", attempt: 1 }));
    input.services.identity = identity;
    const executeTyped = vi.fn(async () => ({ type: "rejected_before_dispatch" as const, errorCode: "POLICY_DENIED" }));
    input.services.dispatchPipeline.createExecutor = vi.fn(() => ({ executeTyped }));
    input.services.usage = vi.fn(() => ({ duplicateEffectCount: 0 }));
    input.execution.selectTool = () => ({ toolName: "fixture", input: {}, sourceExecutor: { executeTyped: vi.fn() } });
    input.execution.recovery.recover = async () => ({ terminal: "failed", output: "denied" });
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => input, { timeoutMs: 100 });
    const result = await root.current()?.execution.execute({
      executionManifest: { runtimeBuildId: "build-1", graphVersion: "graph-1", promptVersion: "prompt-1", modelRouteVersion: "route-1", toolSchemaVersion: "tool-1", policyVersion: "policy-1" },
      principal: { principalId: "principal-1", principalType: "service", tenantId: "tenant-1", roles: [], scopes: [], authSource: "service_token", authenticatedAt: "2026-10-14T00:00:00Z" },
      scope: { scopeId: "scope-1", scopeType: "tenant", tenantId: "tenant-1" },
      input: { kind: "prompt", text: "fixture", attachments: [] },
    });
    expect(result).toMatchObject({ runId: "run-1", terminal: "failed", output: "denied" });
    expect(identity).toHaveBeenCalledOnce();
    expect(executeTyped).toHaveBeenCalledOnce();
    expect(input.services.usage).toHaveBeenCalledOnce();
    expect(input.services.eventPublication.recordAuthoritative).toHaveBeenCalledOnce();
  });

  it.each(["reference", "langgraph"] as const)("runs %s through the same dispatch, event and terminal owners", async (framework) => {
    const input = candidate();
    const { metadata, policy } = createCheckpointFixture();
    const context: ExecutionContext = {
      requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1",
      stepId: "step-1", attempt: 1,
      principal: { principalId: "principal-1", principalType: "service", tenantId: "tenant-1", roles: [], scopes: [], authSource: "service_token", authenticatedAt: "2026-10-14T00:00:00Z" },
      scope: { scopeId: "scope-1", scopeType: "tenant", tenantId: "tenant-1" },
    };
    input.services.identity = () => ({ requestId: context.requestId, threadId: context.threadId, runId: context.runId, taskId: context.taskId, stepId: context.stepId, toolCallId: "call-1", attempt: 1 });
    const executeTyped = vi.fn(async () => ({ type: "rejected_before_dispatch" as const, errorCode: "POLICY_DENIED" }));
    input.services.dispatchPipeline.createExecutor = vi.fn(() => ({ executeTyped }));
    input.services.usage = vi.fn(() => ({ duplicateEffectCount: 0 }));
    input.execution.selectTool = () => ({ toolName: "fixture", input: {}, sourceExecutor: { executeTyped: vi.fn() } });
    input.execution.recovery.recover = async () => ({ terminal: "failed", output: "denied" });
    const root = new RuntimeComposition<string>([versions]);
    const execute = async (_mode: "invoke" | "resume", request: FrameworkInvocation): Promise<FrameworkOutcome> => {
      const result = await root.current()?.execution.execute(request.input);
      if (!result) throw new Error("composition unavailable");
      const payload: Record<string, JsonValue> = { ...result.executionEvent.payload };
      await request.observe({ kind: "event", event: { ...result.executionEvent, payload } });
      if (!isRunTerminalStatus(result.terminal)) throw new Error("execution is non-terminal");
      await request.observe({ kind: "terminal", status: result.terminal });
      return { status: "failed", reasonCode: "POLICY_DENIED" };
    };
    input.adapters = [async () => createReferenceAdapter({
      adapterId: "reference", timeoutMs: 100, policy: () => policy, execute,
    })];
    await root.install(async () => input, { timeoutMs: 100 });
    const observations: FrameworkObservation[] = [];
    const request: FrameworkInvocation = {
      input: {
        executionManifest: { runtimeBuildId: "build-1", graphVersion: "graph-1", promptVersion: "prompt-1", modelRouteVersion: "route-1", toolSchemaVersion: "tool-1", policyVersion: "policy-1" },
        principal: { principalId: "principal-1", principalType: "service", tenantId: "tenant-1", roles: [], scopes: [], authSource: "service_token", authenticatedAt: "2026-10-14T00:00:00Z" },
        scope: { scopeId: "scope-1", scopeType: "tenant", tenantId: "tenant-1" },
        input: { kind: "prompt", text: "fixture", attachments: [] },
      },
      context, checkpoint: metadata, signal: new AbortController().signal,
      observe: async (observation) => { observations.push(observation); },
    };
    let result: FrameworkOutcome | undefined;
    if (framework === "reference") {
      result = await root.current()?.adapter("reference")?.invoke(request);
    } else {
      const State = Annotation.Root({ outcome: Annotation<FrameworkOutcome>() });
      const graph = new StateGraph(State)
        .addNode("governed_tool", async () => ({ outcome: await execute("invoke", request) }))
        .addEdge(START, "governed_tool")
        .addEdge("governed_tool", END)
        .compile();
      result = (await graph.invoke({}, { signal: request.signal })).outcome;
    }
    expect(result).toEqual({ status: "failed", reasonCode: "POLICY_DENIED" });
    expect(executeTyped).toHaveBeenCalledOnce();
    expect(input.services.eventPublication.recordAuthoritative).toHaveBeenCalledOnce();
    expect(observations.map(({ kind }) => kind)).toEqual(["event", "terminal"]);
    expect(observations[0]).toMatchObject({ kind: "event", event: { sequence: 1, context: { runId: "run-1", taskId: "task-1", stepId: "step-1" } } });
    expect(observations[1]).toEqual({ kind: "terminal", status: "failed" });
    expect(input.services.eventPublication.recordAuthoritative).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", terminalResult: { status: "failed" } }));
  });

  it("shares the exact host services and existing canonical executor without parallel owners", async () => {
    const root = new RuntimeComposition<string>([versions]);
    const input = candidate();
    const loader = input.adapters[0];
    const capture = vi.fn(loader);
    input.adapters = [capture];
    await root.install(async () => input, { timeoutMs: 100 });
    const published = root.current();
    expect(published?.services.policy).toBe(input.services.policy);
    expect(published?.services.dispatchPipeline).toBe(input.services.dispatchPipeline);
    expect(capture).toHaveBeenCalledWith(published?.services, expect.any(AbortSignal));
    expect(published?.adapter("reference")).toBeDefined();
    expect(published?.execution.execute).toBeTypeOf("function");
    expect(Object.isFrozen(published?.services)).toBe(true);
    expect(input.services.identity).not.toHaveBeenCalled();
    expect(input.services.usage).not.toHaveBeenCalled();
    expect(input.services.eventPublication.recordAuthoritative).not.toHaveBeenCalled();
  });

  it.each(["identity", "persistence", "policy", "providers", "toolRegistry", "sandbox", "secretBroker", "scheduling", "dispatchPipeline", "sequenceAllocator", "eventPublication", "usage"])("rejects missing %s before loading or publishing", async (name) => {
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => candidate(), { timeoutMs: 100 });
    const previous = root.current();
    const invalid = candidate();
    const load = vi.fn();
    invalid.adapters = [load];
    Reflect.deleteProperty(invalid.services, name);
    await expect(root.install(async () => invalid, { timeoutMs: 100 })).rejects.toMatchObject({ code: "COMPOSITION_DEPENDENCY_UNAVAILABLE" });
    expect(load).not.toHaveBeenCalled();
    expect(root.current()).toBe(previous);
  });

  it("rejects unknown runtime versions and invalid adapter batches atomically", async () => {
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => candidate(), { timeoutMs: 100 });
    const previous = root.current();
    const input = candidate();
    input.versions = { ...versions, packageVersion: "9.0.0" };
    await expect(root.install(async () => input, { timeoutMs: 100 })).rejects.toMatchObject({ code: "COMPOSITION_VERSION_UNSUPPORTED" });
    input.versions = versions;
    input.adapters = [...input.adapters, async () => ({})];
    await expect(root.install(async () => input, { timeoutMs: 100 })).rejects.toMatchObject({ code: "ADAPTER_INVALID" });
    expect(root.current()).toBe(previous);
  });

  it.each(["timeout", "cancel"])("retains the old snapshot after %s and late initialization", async (mode) => {
    vi.useFakeTimers();
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => candidate(), { timeoutMs: 100 });
    const previous = root.current();
    let finish!: (value: RuntimeCompositionCandidate<string>) => void;
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const pending = root.install((forwarded) => { signal = forwarded; return new Promise((resolve) => { finish = resolve; }); }, { timeoutMs: 10, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: mode === "timeout" ? "ADAPTER_OPERATION_TIMEOUT" : "ADAPTER_OPERATION_CANCELLED" });
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(10);
    else controller.abort();
    await rejection;
    expect(signal?.aborted).toBe(true);
    finish(candidate());
    await Promise.resolve();
    expect(root.current()).toBe(previous);
  });

  it("rejects concurrent deployments and preserves pinned snapshots across replacement", async () => {
    const root = new RuntimeComposition<string>([versions]);
    await root.install(async () => candidate(), { timeoutMs: 100 });
    const pinned = root.current();
    let finish!: (value: RuntimeCompositionCandidate<string>) => void;
    const pending = root.install(() => new Promise((resolve) => { finish = resolve; }), { timeoutMs: 1000 });
    await expect(root.install(async () => candidate(), { timeoutMs: 100 })).rejects.toMatchObject({ code: "COMPOSITION_BUSY" });
    expect(root.current()).toBe(pinned);
    finish(candidate());
    await pending;
    expect(root.current()).not.toBe(pinned);
    expect(pinned?.adapter("reference")).toBeDefined();
    expect(pinned?.services.policy).not.toBe(root.current()?.services.policy);
  });

  it("never publishes empty adapter collections or leaking initializer failures", async () => {
    const root = new RuntimeComposition<string>([versions]);
    const input = candidate();
    input.adapters = [];
    await expect(root.install(async () => input, { timeoutMs: 100 })).rejects.toMatchObject({ code: "COMPOSITION_DEPENDENCY_UNAVAILABLE" });
    await expect(root.install(async () => { throw new Error("private host detail"); }, { timeoutMs: 100 })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED", message: "ADAPTER_OPERATION_FAILED" });
    expect(root.current()).toBeUndefined();
  });
});
