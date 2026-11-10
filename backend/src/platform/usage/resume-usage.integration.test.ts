import { afterEach, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it("preserves trusted attribution across an actual approval Command resume and bills its provider response once", async () => {
  vi.stubEnv("LLM_PROVIDER", "qwen"); vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
  vi.stubEnv("USAGE_LEDGER_REDIS_URI", ""); vi.stubEnv("USAGE_LEDGER_TIME_ZONE", "UTC");
  vi.stubEnv("USAGE_PRICE_TABLE_JSON", JSON.stringify([{ provider: "qwen", model: "resume-fixture", callKind: "chat", currency: "USD", inputPerMillion: "1", outputPerMillion: "2", source: "https://example.test/fixture", verifiedAt: "2026-11-02" }]));
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "approved fixture" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200 })));
  const { llmGateway } = await import("../llm-gateway.js");
  const { instrumentGraphWithUsageAttribution, readUsageAttribution, REGISTERED_GRAPH_IDS } = await import("./attribution.js");
  const { getUsageRuntime } = await import("./runtime.js");
  const graph = instrumentGraphWithUsageAttribution(new StateGraph(MessagesAnnotation)
    .addNode("approval", async (_state, config: RunnableConfig) => {
      interrupt({ kind: "approval-fixture" });
      const answer = await llmGateway.createChatModel({ model: "resume-fixture", maxRetries: 0 }).invoke("fixture", { attribution: readUsageAttribution(config) });
      return { messages: [answer] };
    }).addEdge(START, "approval").addEdge("approval", END).compile({ checkpointer: new MemorySaver() }), REGISTERED_GRAPH_IDS.shoppingAssistant);
  const config = { configurable: { thread_id: crypto.randomUUID(), __server_usage_attribution: { graphId: "forged" } } };
  await graph.invoke({ messages: [new HumanMessage("fixture")] }, config);
  expect(fetch).not.toHaveBeenCalled();
  await graph.invoke(new Command({ resume: { approved: true } }), config);
  expect(fetch).toHaveBeenCalledOnce();
  const runtime = getUsageRuntime(); await runtime.writer.flush();
  const { datePartition } = await import("./ledger.js");
  const summary = await runtime.store.read(datePartition(new Date(), "UTC"));
  expect(summary).toMatchObject({ amountMicros: 7, unpricedCount: 0 });
  expect(Object.values(summary.byGraphAndKind)).toEqual([{ graphId: "shopping_assistant", callKind: "chat", amountMicros: 7, unpricedCount: 0 }]);
  await runtime.close();
});
