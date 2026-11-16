import type { LangGraphRunnableConfig, StreamMode } from "@langchain/langgraph";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import { applyInteractionGovernance, type InteractionOrchestrator } from "../platform/interaction-runtime.js";
import { REGISTERED_GRAPH_IDS, instrumentGraphWithUsageAttribution } from "../platform/usage/attribution.js";

// stream-chat-answer-text Task 1.2 (design D4 gate): a custom event written inside a node must reach
// the Agent Server's stream consumer before that node returns, through both production wrappers.

type StreamEvent = { event: string; run_id?: string; data?: { chunk?: unknown } };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function buildWrappedGraph(release: Promise<void>, nodeReturned: { value: boolean }) {
  const node = async (_state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) => {
    config.writer?.({ gate: "before-return" });
    await release;
    nodeReturned.value = true;
    return { messages: [] };
  };
  const compiled = new StateGraph(MessagesAnnotation)
    .addNode("chat_response", node)
    .addEdge(START, "chat_response")
    .addEdge("chat_response", END)
    .compile();
  // A configured orchestrator so the governance Proxy path is exercised, not the unconfigured no-op.
  const orchestrator: InteractionOrchestrator = {
    isConfigured: true,
    beforeRun: vi.fn(async () => ({ configured: true, events: [] })),
    afterRun: vi.fn(async () => undefined),
  } as unknown as InteractionOrchestrator;
  // Same wrapping order as chatbotGraph.
  const wrapped = instrumentGraphWithUsageAttribution(applyInteractionGovernance(compiled, orchestrator), REGISTERED_GRAPH_IDS.chatbot);
  return { wrapped, orchestrator };
}

// Mirrors @langchain/langgraph-api stream.mjs: streamEvents v2 with the run's streamMode, reading
// `on_chain_stream` chunks of the root run as [mode, payload].
function rootStreamChunk(event: StreamEvent, runId: string): [string, unknown] | undefined {
  if (event.event !== "on_chain_stream" || event.run_id !== runId) return undefined;
  const chunk = event.data?.chunk;
  return Array.isArray(chunk) && typeof chunk[0] === "string" ? [chunk[0], chunk[1]] : undefined;
}

describe("stream-chat-answer-text Task 1.2 custom writer bridge", () => {
  it.each<[StreamMode[]]>([
    [["values", "updates", "custom"]],
    [["messages", "values", "updates", "custom"]],
  ])("delivers custom before the node returns and keeps existing modes (streamMode=%j)", async (streamMode) => {
    const release = deferred();
    const nodeReturned = { value: false };
    const { wrapped, orchestrator } = buildWrappedGraph(release.promise, nodeReturned);
    const runId = "00000000-0000-4000-8000-000000000012";
    const modes: string[] = [];
    let customSeenBeforeReturn = false;

    const events = wrapped.streamEvents(
      { messages: [] },
      { version: "v2", runId, streamMode, configurable: { thread_id: "gate-thread" } },
    ) as unknown as AsyncIterable<StreamEvent>;
    for await (const event of events) {
      const chunk = rootStreamChunk(event, runId);
      if (!chunk) continue;
      modes.push(chunk[0]);
      if (chunk[0] === "custom") {
        expect(chunk[1]).toEqual({ gate: "before-return" });
        customSeenBeforeReturn = !nodeReturned.value;
        release.resolve();
      }
    }

    expect(customSeenBeforeReturn).toBe(true);
    expect(nodeReturned.value).toBe(true);
    // The initial `values` snapshot precedes the node; the node's own `updates` must follow custom.
    expect(modes.indexOf("custom")).toBeGreaterThanOrEqual(0);
    expect(modes.indexOf("custom")).toBeLessThan(modes.indexOf("updates"));
    expect(modes).toContain("values");
    expect(orchestrator.beforeRun).toHaveBeenCalledOnce();
    expect(orchestrator.afterRun).toHaveBeenCalledOnce();
  });

  it("does not emit custom chunks when custom is not requested", async () => {
    const release = deferred();
    release.resolve();
    const { wrapped } = buildWrappedGraph(release.promise, { value: false });
    const runId = "00000000-0000-4000-8000-000000000013";
    const modes: string[] = [];
    const events = wrapped.streamEvents(
      { messages: [] },
      { version: "v2", runId, streamMode: ["values", "updates"], configurable: { thread_id: "gate-thread" } },
    ) as unknown as AsyncIterable<StreamEvent>;
    for await (const event of events) {
      const chunk = rootStreamChunk(event, runId);
      if (chunk) modes.push(chunk[0]);
    }
    expect(modes).not.toContain("custom");
    expect(modes).toEqual(expect.arrayContaining(["values", "updates"]));
  });
});
