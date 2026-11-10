import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { datePartition } from "../platform/usage/ledger.js";
import type { createUsageRuntime } from "../platform/usage/runtime.js";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function";
}

describe("registered graph provider accounting", () => {
  for (const { graphId, streaming } of [
    { graphId: "chatbot", streaming: false }, { graphId: "chatbot", streaming: true },
    { graphId: "math_agent", streaming: false }, { graphId: "mcp_agent", streaming: false },
    { graphId: "deep_researcher", streaming: false }, { graphId: "shopping_assistant", streaming: false },
  ] as const) {
    describe(`${graphId} ${streaming ? "stream" : "invoke"}`, () => {
      let graph: unknown;
      let providerCalls = 0;
      let runtime: ReturnType<typeof createUsageRuntime>;
      // Cold module compilation is fixture setup; the graph invocation keeps the original test timeout.
      beforeAll(async () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("LLM_PROVIDER", "qwen");
      vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
      vi.stubEnv("USAGE_LEDGER_REDIS_URI", "");
      vi.stubEnv("USAGE_LEDGER_TIME_ZONE", "UTC");
      vi.stubEnv("USAGE_PRICE_TABLE_JSON", "[]");
      vi.stubEnv("SHOPPING_ORDER_BINDING_ENABLED", "false");
      vi.resetModules();
      const admission = await import("../runtime/execution-context/graph-task-admission.js");
      vi.spyOn(admission.PgGraphTaskAdmission.prototype, "admit").mockImplementation(async c => c.taskId);
      vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
        expect(String(url)).toContain("provider.fixture.test");
        providerCalls++;
        const content = graphId === "shopping_assistant"
          ? JSON.stringify({ intent: "unsupported", rationaleCode: "out_of_scope" })
          : graphId === "deep_researcher" && providerCalls === 1
            ? JSON.stringify({ question: "fixture", answerMode: "direct", rationale: "fixture", queries: [], urls: [], requiredSourceCount: 1 })
            : "fixture answer";
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200 });
      }));
      const deployment = JSON.parse(readFileSync(new URL("../../langgraph.json", import.meta.url), "utf8"));
      const registeredPath: string = deployment.graphs[graphId];
      const [file, exportName] = registeredPath.split(":");
      const module: Record<string, unknown> = await import(new URL(file.replace(".ts", ".js"), new URL("../../", import.meta.url)).href);
      graph = module[exportName];
      const { getUsageRuntime } = await import("../platform/usage/runtime.js");
      runtime = getUsageRuntime();
      });

      afterAll(async () => {
        await runtime?.close();
        vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
      });

      it(`attributes every provider response in an exported ${graphId} run`, async () => {
      if (graph === null || typeof graph !== "object" || !("invoke" in graph) || typeof graph.invoke !== "function") throw new Error("registered graph has no invoke");
      const threadId = crypto.randomUUID();
      const input = { messages: [new HumanMessage("fixture question")] };
      const options = {
        configurable: {
          thread_id: threadId, run_id: crypto.randomUUID(), "x-request-id": crypto.randomUUID(),
          "x-bff-principal-id": "principal-fixture", "x-bff-principal-type": "service",
          "x-bff-tenant-id": "tenant-fixture", "x-bff-roles": "member", "x-bff-scopes": "search:read",
          "x-bff-auth-source": "trusted_gateway", "x-bff-authenticated-at": "2026-11-02T00:00:00.000Z",
          "x-bff-scope-id": "tenant-fixture", "x-bff-scope-type": "tenant",
          __server_usage_attribution: { graphId: "spoofed" },
        },
      };
      if (streaming) {
        if (!("stream" in graph) || typeof graph.stream !== "function") throw new Error("registered graph has no stream");
        const events: unknown = await graph.stream(input, options);
        if (!isAsyncIterable(events)) throw new Error("graph stream is not async iterable");
        for await (const event of events) void event;
      } else await graph.invoke(input, options);
      await runtime.writer.flush();
      const summary = await runtime.store.read(datePartition(new Date(), "UTC"));
      expect(providerCalls).toBeGreaterThan(0);
      expect(summary.unpricedCount).toBe(providerCalls);
      expect(Object.values(summary.byGraphAndKind).map(row => row.graphId)).toEqual([graphId]);
      });
    });
  }
});
