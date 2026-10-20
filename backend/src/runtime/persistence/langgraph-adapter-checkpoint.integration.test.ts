import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAdapterCheckpointBoundary, type AdapterCheckpoint } from "./adapter-checkpoint-boundary.js";
import { createCheckpointFixture } from "./checkpoint-fixture.testing.js";

describe("private LangGraph checkpoint projection", () => {
  it("gates real native resume with the shared metadata policy and retains the original checkpoint", async () => {
    let beforeWait = 0;
    let afterWait = 0;
    const State = Annotation.Root({ cursor: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }) });
    const graph = new StateGraph(State)
      .addNode("before", () => { beforeWait += 1; return { cursor: 1 }; })
      .addNode("wait", () => { interrupt({ kind: "approval" }); return {}; })
      .addNode("after", () => { afterWait += 1; return { cursor: 2 }; })
      .addEdge(START, "before").addEdge("before", "wait").addEdge("wait", "after").addEdge("after", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "thread-1" } };
    await graph.invoke({}, config);
    const paused = await graph.getState(config);
    const checkpointId = z.string().parse(paused.config.configurable?.checkpoint_id);
    const { metadata, policy } = createCheckpointFixture("langgraph");
    const saved = { metadata: { ...metadata, nativeCheckpointRef: { ...metadata.nativeCheckpointRef, checkpointId } }, state: { cursor: paused.values.cursor } };
    const before = structuredClone(saved);
    const readPolicy = { ...policy, nativeCheckpointRef: saved.metadata.nativeCheckpointRef };
    const boundary = createAdapterCheckpointBoundary({
      store: { read: async () => saved, append: async () => { throw new Error("Unexpected append during resume"); } },
      stateSchema: z.object({ cursor: z.number().int() }).strict(), containsSecret: () => false, maxBytes: 1024, maxDepth: 4,
    });
    const incompatible = await boundary.read({ ...readPolicy, supportedAdapters: [] }, { timeoutMs: 1000 });
    expect(incompatible).toMatchObject({ status: "parked" });
    expect((await graph.getState(config)).config).toEqual(paused.config);
    expect(afterWait).toBe(0);
    const compatible = await boundary.read(readPolicy, { timeoutMs: 1000 });
    if (compatible.status !== "ready") throw new Error("Expected compatible checkpoint");
    await graph.invoke(new Command({ resume: "approved" }), { configurable: { ...config.configurable, checkpoint_id: compatible.checkpoint.metadata.nativeCheckpointRef.checkpointId } });
    expect([beforeWait, afterWait]).toEqual([1, 1]);
    expect(saved).toEqual(before);
    expect(await boundary.read(readPolicy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: before });
  });

  it("stores only declared state with native correlation and leaves older checkpoints readable", async () => {
    const State = Annotation.Root({
      cursor: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
    });
    const graph = new StateGraph(State)
      .addNode("advance", (state) => ({ cursor: state.cursor + 1 }))
      .addEdge(START, "advance")
      .addEdge("advance", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "thread-1" } };
    await graph.invoke({ cursor: 1 }, config);
    const first = await graph.getState(config);
    await graph.invoke({ cursor: 2 }, config);
    const second = await graph.getState(config);
    const firstId = z.string().min(1).parse(first.config.configurable?.checkpoint_id);
    const secondId = z.string().min(1).parse(second.config.configurable?.checkpoint_id);
    expect(secondId).not.toBe(firstId);

    const { metadata, policy } = createCheckpointFixture("langgraph");
    const firstMetadata = { ...metadata, nativeCheckpointRef: { ...metadata.nativeCheckpointRef, checkpointId: firstId } };
    const secondMetadata = { ...metadata, nativeCheckpointRef: { ...metadata.nativeCheckpointRef, checkpointId: secondId } };
    const checkpoints = new Map<string, AdapterCheckpoint<unknown>>([
      [firstId, { metadata: firstMetadata, state: { cursor: first.values.cursor } }],
    ]);
    const boundary = createAdapterCheckpointBoundary({
      store: {
        read: async ({ checkpointId }) => checkpoints.get(checkpointId),
        append: async ({ parent, checkpoint }) => {
          if (!checkpoints.has(parent.checkpointId)) throw new Error("parent missing");
          checkpoints.set(checkpoint.metadata.nativeCheckpointRef.checkpointId, checkpoint);
        },
      },
      stateSchema: z.object({ cursor: z.number().int().nonnegative() }).strict(),
      containsSecret: () => false,
      maxBytes: 1024,
      maxDepth: 4,
    });
    const firstPolicy = { ...policy, nativeCheckpointRef: firstMetadata.nativeCheckpointRef };
    const secondPolicy = { ...policy, nativeCheckpointRef: secondMetadata.nativeCheckpointRef };
    expect(await boundary.append({ metadata: secondMetadata, state: { cursor: second.values.cursor } }, firstPolicy, { timeoutMs: 1000 })).toMatchObject({ status: "saved" });
    expect(await boundary.read(firstPolicy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: first.values.cursor } } });
    expect(await boundary.read(secondPolicy, { timeoutMs: 1000 })).toMatchObject({ status: "ready", checkpoint: { state: { cursor: second.values.cursor } } });
    expect(await boundary.read({ ...secondPolicy, supportedAdapters: [] }, { timeoutMs: 1000 })).toMatchObject({ status: "parked" });
    expect(checkpoints).toHaveProperty("size", 2);
  });
});
