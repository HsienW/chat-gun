import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, MemorySaver, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { createKbSearchTool, KB_SEARCH_SECRET_REFERENCE } from "../tools/kb-search.js";
import { withExecutionContext } from "../runtime/execution-context/read-execution-context.js";
import { withResolvedSecrets } from "../runtime/tool-dispatch/secret-broker.js";
import { createSystemExecutionContext } from "./connection.js";
import { prepareCorpus } from "./corpus.js";
import { InMemoryKnowledgeStore } from "./in-memory-store.js";
import { ingestCorpus } from "./ingestion.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "./testing-fakes.js";

const CREDENTIAL = "sk-leakage-canary-7c1e9a4b2d6f";
const config = testKnowledgeConfig();

/** Every byte the checkpointer persisted, decoded, so symbol-keyed values cannot hide behind JSON. */
function persistedText(checkpointer: MemorySaver): string {
  const internal = checkpointer as unknown as { storage: unknown; writes: unknown };
  const decoder = new TextDecoder();
  const collect = (value: unknown): string => {
    if (value instanceof Uint8Array) return decoder.decode(value);
    if (Array.isArray(value)) return value.map(collect).join("\n");
    if (value !== null && typeof value === "object") return Object.values(value).map(collect).join("\n");
    return typeof value === "string" ? value : "";
  };
  return `${collect(internal.storage)}\n${collect(internal.writes)}`;
}

describe("credential leakage through checkpoints", () => {
  it("persists the kb_search result but never the resolved credential", async () => {
    const store = new InMemoryKnowledgeStore();
    const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
    await ingestCorpus({
      runId: "seed",
      tenantId: "public",
      corpus: prepareCorpus({
        products: [],
        policyMarkdown: [{
          origin: "policy",
          markdown: "---\nsynthetic: true\ncorpusVersion: kb-test\ngeneratedAt: 2026-10-23\nsourceId: policy-return-window\nsourceType: policy\ntitle: Return Window\n---\n\nMost items can be returned within 30 days of the delivery date.",
        }],
      }),
      store,
      gateway,
      credential: CREDENTIAL,
      config,
    });
    const tool = createKbSearchTool({ config: () => config, store: async () => store, gateway: () => gateway });

    const graph = new StateGraph(Annotation.Root({ ...MessagesAnnotation.spec }))
      .addNode("search", async (_state: typeof MessagesAnnotation.State, runnableConfig: RunnableConfig) => {
        const output = await tool.invoke({ query: "How many days can items be returned after delivery?" }, runnableConfig);
        return {
          messages: [
            new AIMessage({ content: "", tool_calls: [{ id: "call-1", name: "kb_search", args: {} }] }),
            new ToolMessage({ content: output as string, tool_call_id: "call-1", name: "kb_search" }),
          ],
        };
      })
      .addEdge("__start__", "search")
      .compile({ checkpointer: new MemorySaver() });

    const checkpointer = graph.checkpointer as MemorySaver;
    const context = createSystemExecutionContext("kb-leakage-test");
    const runnableConfig = withResolvedSecrets(
      withExecutionContext({ configurable: { thread_id: "leakage-thread" } }, context),
      { [KB_SEARCH_SECRET_REFERENCE.secretRef]: CREDENTIAL }
    );
    const state = await graph.invoke({ messages: [] }, runnableConfig);

    // The tool really received the credential through the injected config...
    expect(gateway.credentials.at(-1)).toBe(CREDENTIAL);
    const toolOutput = String(state.messages.at(-1)?.content);
    expect(toolOutput).toContain("evidence_found");
    // ...and the persisted checkpoint holds the result, but not the credential.
    const persisted = persistedText(checkpointer);
    expect(persisted).toContain("evidence_found");
    expect(persisted).not.toContain(CREDENTIAL);
    expect(toolOutput).not.toContain(CREDENTIAL);
  });
});
