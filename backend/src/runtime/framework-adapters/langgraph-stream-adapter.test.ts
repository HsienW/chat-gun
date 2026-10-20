import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { createExecutionContextFixture } from "@gun-ai/harness-testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitEnvelope } from "../emit-envelope.js";
import { RunSequenceAllocator } from "../event-sequence.js";
import type { RuntimeEventPayload, RuntimeEventType } from "../event-payloads.js";

import { projectExecutionEventContext, type RuntimeEventEnvelope } from "../event-envelope.js";
import { type JsonValue } from "../event-payloads.js";
import { transitionRunStatus, type RunStatus } from "../run-status.js";
import { createCheckpointFixture } from "../persistence/checkpoint-fixture.testing.js";
import { createLangGraphStreamAdapter, guardLangGraphNode } from "./langgraph-stream-adapter.js";
import type { FrameworkInvocation, FrameworkObservation, FrameworkOutcome } from "./registry.js";

const context = createExecutionContextFixture({ stepId: "step-1", toolCallId: "call-1" });
const eventContext = projectExecutionEventContext(context);
function event(sequence: number, type = "model.stream", payload: JsonValue = { delta: "token" }): RuntimeEventEnvelope<string, JsonValue> {
  return { schemaVersion: "1.0.0", eventId: `event-${sequence}`, sequence, type, payload, emittedAt: "2026-10-20T00:00:00.000Z", context: eventContext };
}
function setup(source: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>, initialStatus: RunStatus = "completed", sequence = 0) {
  const { metadata, policy } = createCheckpointFixture("langgraph");
  let status = initialStatus;
  const observations: FrameworkObservation[] = [];
  const request: FrameworkInvocation = { input: {}, context, checkpoint: metadata, signal: new AbortController().signal,
    observe: async (observation) => { observations.push(observation); } };
  const outcome = vi.fn(async (): Promise<FrameworkOutcome> => status === "needs_user"
    ? { status: "waiting", checkpoint: metadata }
    : status === "completed" ? { status: "completed", output: "done" } : { status: "failed", reasonCode: "HOST_TERMINAL" });
  const authorizeResume = vi.fn(async () => true);
  const adapter = createLangGraphStreamAdapter({ adapterId: "langgraph", timeoutMs: 1000, maxEvents: 20, maxBufferedEvents: 4, maxEventBytes: 4096,
    policy: () => policy, initialSequence: () => sequence, authorizeResume, open: (_mode, request) => source(request.signal),
    readStatus: async () => status, outcome });
  return { adapter, request, observations, outcome, authorizeResume, changeStatus: (next: RunStatus) => { const transition = transitionRunStatus(status, next); if (transition.accepted) status = transition.status; } };
}
async function* events(...items: unknown[]) { yield* items; }
const terminal = () => event(4, "run.terminal", { status: "completed", reasonCode: "RUN_COMPLETED" });
afterEach(() => vi.useRealTimers());

describe("private LangGraph canonical stream adapter", () => {
  it.each(["completed", "cancelled"] as const)("retains the host %s winner when the opposite terminal and late progress arrive", async (winner) => {
    const loser = winner === "completed" ? "cancelled" : "completed";
    const fixture = setup(async () => events(
      event(1, "run.terminal", { status: winner, reasonCode: "HOST_DECIDED" }),
      event(2, "run.terminal", { status: loser, reasonCode: "LATE_RESULT" }), event(3),
    ), winner);
    fixture.changeStatus(loser);
    await expect(fixture.adapter.invoke(fixture.request)).resolves.toMatchObject({ status: winner === "completed" ? "completed" : "failed" });
    expect(fixture.observations.filter((item) => item.kind === "terminal")).toEqual([{ kind: "terminal", status: winner }]);
    expect(fixture.observations.filter((item) => item.kind === "event")).toHaveLength(1);
  });

  it("preserves additive canonical execution events without assigning them terminal authority", async () => {
    const execution = event(1, "run.execution", { normalizedInputKind: "prompt", toolName: "fixture", dispatchOutcomeType: "succeeded", governedContextExceeded: false });
    const fixture = setup(async () => events(execution, event(2, "run.terminal", { status: "completed", reasonCode: "RUN_COMPLETED" })));
    await expect(fixture.adapter.invoke(fixture.request)).resolves.toMatchObject({ status: "completed" });
    expect(fixture.observations[0]).toEqual({ kind: "event", event: execution });
    expect(fixture.observations.filter((item) => item.kind === "terminal")).toHaveLength(1);
  });

  it("projects a real native custom stream with normalization and terminal persistence occurring once at X19", async () => {
    const State = Annotation.Root({ value: Annotation<number>() });
    const sequenceAllocator = new RunSequenceAllocator();
    const persisted = vi.fn(async (item) => item);
    const publish = async (config: LangGraphRunnableConfig, type: RuntimeEventType, payload: RuntimeEventPayload) => {
      const envelope = await emitEnvelope({ type, payload, executionContext: context, sequenceAllocator, runtimeEventEnvelopeEnabled: true,
        eventId: `native-${type}`, legacyEvent: { taskId: context.taskId, eventId: `native-${type}`, eventType: "task_completed", createdAt: "2026-10-20T00:00:00Z" },
        eventRepository: { append: persisted, findByTaskId: async () => [], async *streamByTaskId() {} } });
      config.writer?.(envelope);
    };
    const graph = new StateGraph(State)
      .addNode("model", async (_state, config) => { await publish(config, "model.stream", { delta: "token" }); return { value: 1 }; })
      .addNode("tool", async (_state, config) => { await publish(config, "tool.start", { toolName: "fixture", toolCallId: "call-1" }); return {}; })
      .addNode("terminal", async (_state, config) => { fixture.changeStatus("completed"); await publish(config, "run.terminal", { status: "completed", reasonCode: "RUN_COMPLETED" }); return {}; })
      .addEdge(START, "model").addEdge("model", "tool").addEdge("tool", "terminal").addEdge("terminal", END).compile();
    const fixture = setup(async (signal) => graph.stream({}, { signal, streamMode: "custom" }), "running");
    await expect(fixture.adapter.invoke(fixture.request)).resolves.toMatchObject({ status: "completed" });
    const projected = fixture.observations.filter((item) => item.kind === "event").map((item) => item.event);
    expect(projected.map(({ eventId, sequence }) => ({ eventId, sequence }))).toEqual([
      { eventId: "native-model.stream", sequence: 1 }, { eventId: "native-tool.start", sequence: 2 }, { eventId: "native-run.terminal", sequence: 3 },
    ]);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ payload: { runtimeEventIdentity: expect.objectContaining({ eventId: "native-run.terminal", sequence: 3 }) } }));
  });

  it("requires the existing durable approval gate before resume and retains the producer sequence", async () => {
    const open = vi.fn(async () => events(event(6, "run.terminal", { status: "completed", reasonCode: "RUN_COMPLETED" })));
    const fixture = setup(open, "completed", 5);
    fixture.authorizeResume.mockResolvedValueOnce(false);
    await expect(fixture.adapter.resume(fixture.request)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(open).not.toHaveBeenCalled();
    await expect(fixture.adapter.resume(fixture.request)).resolves.toMatchObject({ status: "completed" });
    expect(fixture.observations[0]).toMatchObject({ kind: "event", event: { sequence: 6 } });
  });

  it("rejects oversized payloads before observing them", async () => {
    const fixture = setup(async () => events(event(1, "model.stream", { delta: "x".repeat(4096) })));
    await expect(fixture.adapter.invoke(fixture.request)).rejects.toMatchObject({ code: "ADAPTER_EVENT_LIMIT" });
    expect(fixture.observations).toEqual([]);
  });

  it("keeps producer identity and sequence across duplicate, out-of-order, model/tool and terminal events", async () => {
    const first = event(1);
    const second = event(2, "tool.start", { toolName: "fixture", toolCallId: "call-1" });
    const third = event(3, "tool.success", { toolName: "fixture", toolCallId: "call-1", durationMs: 1 });
    const fixture = setup(async () => events(second, first, first, event(5), terminal(), third, terminal(), event(5)));
    await expect(fixture.adapter.invoke(fixture.request)).resolves.toEqual({ status: "completed", output: "done" });
    const projected = fixture.observations.filter((item) => item.kind === "event").map((item) => item.event);
    expect(projected).toEqual([first, second, third, terminal()]);
    expect(fixture.observations.filter((item) => item.kind === "terminal")).toEqual([{ kind: "terminal", status: "completed" }]);
  });

  it.each(["gap", "missing_terminal", "forged_terminal", "identity", "duplicate_conflict", "overflow"] as const)("fails closed for %s without publishing a product terminal", async (mode) => {
    const items = mode === "gap" ? [event(2)]
      : mode === "forged_terminal" ? [event(1, "run.terminal", { status: "completed", reasonCode: "RUN_COMPLETED" })]
      : mode === "identity" ? [{ ...event(1), context: { ...eventContext, runId: "forged" } }]
      : mode === "duplicate_conflict" ? [event(1), { ...event(1), payload: { delta: "changed" } }]
      : mode === "overflow" ? [event(6)] : [event(1)];
    const fixture = setup(async () => events(...items), mode === "forged_terminal" ? "running" : "completed");
    const pending = fixture.adapter.invoke(fixture.request);
    await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^ADAPTER_(STREAM|EVENT)/) });
    expect(fixture.observations.some((item) => item.kind === "terminal")).toBe(false);
  });

  it("leaves interrupt waiting under host authority and resumes with the persisted sequence", async () => {
    const fixture = setup(async () => events(event(1, "run.status", { status: "needs_user", reasonCode: "AWAITING_CONFIRMATION" })), "needs_user");
    await expect(fixture.adapter.invoke(fixture.request)).resolves.toMatchObject({ status: "waiting" });
    expect(fixture.observations.some((item) => item.kind === "terminal")).toBe(false);
  });

  it.each(["node", "limit", "initialization"] as const)("preserves a typed %s cause with a real LangGraph execution", async (mode) => {
    const State = Annotation.Root({ value: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }) });
    const graph = new StateGraph(State)
      .addNode("work", guardLangGraphNode(async () => { if (mode === "node") throw new Error("private provider detail"); return { value: 1 }; }))
      .addEdge(START, "work").addEdge("work", mode === "limit" ? "work" : END).compile();
    const fixture = setup(async (signal) => {
      if (mode === "initialization") throw new Error("private init detail");
      return graph.stream({}, { signal, streamMode: "custom", recursionLimit: 2 });
    });
    await expect(fixture.adapter.invoke(fixture.request)).rejects.toMatchObject({ code: mode === "node" ? "ADAPTER_NODE_FAILED" : mode === "limit" ? "ADAPTER_STEP_LIMIT" : "ADAPTER_INITIALIZATION_FAILED" });
    expect(fixture.observations.some((item) => item.kind === "terminal")).toBe(false);
  });

  it.each(["cancel", "timeout"] as const)("propagates %s into an active graph and its child signal without late observations", async (mode) => {
    vi.useFakeTimers();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let childSignal: AbortSignal | undefined;
    const State = Annotation.Root({ value: Annotation<number>() });
    const graph = new StateGraph(State).addNode("child", async (_state, config: LangGraphRunnableConfig) => {
      childSignal = config.signal;
      started();
      await new Promise<void>((resolve) => config.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { value: 1 };
    }).addEdge(START, "child").addEdge("child", END).compile();
    const fixture = setup(async (signal) => graph.stream({}, { signal, streamMode: "custom" }));
    const pending = fixture.adapter.invoke(fixture.request);
    const rejection = expect(pending).rejects.toMatchObject({ code: mode === "cancel" ? "ADAPTER_OPERATION_CANCELLED" : "ADAPTER_OPERATION_TIMEOUT" });
    await entered;
    if (mode === "cancel") await fixture.adapter.cancel(context.runId);
    else await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(childSignal?.aborted).toBe(true);
    expect(fixture.observations).toEqual([]);
  });
});
