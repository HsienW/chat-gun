import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTERED_GRAPH_IDS, USAGE_ATTRIBUTION_KEY, instrumentGraphWithUsageAttribution, readUsageAttribution } from "./attribution.js";

describe("registered graph usage attribution", () => {
  it("has exactly the deployment's registered IDs", () => {
    const deployment = JSON.parse(readFileSync(new URL("../../../langgraph.json", import.meta.url), "utf8"));
    expect(Object.values(REGISTERED_GRAPH_IDS).sort()).toEqual(Object.keys(deployment.graphs).sort());
  });

  for (const graphId of ["chatbot", "deep_researcher", "shopping_assistant", "math_agent", "mcp_agent"] as const) {
    it(`owns the outer invoke and stream attribution for ${graphId}`, async () => {
      const graph = {
        async invoke(input: unknown, config?: unknown) { return { input, attribution: readUsageAttribution(config) }; },
        async *stream(_input: unknown, config?: unknown) { yield readUsageAttribution(config); },
      };
      const wrapped = instrumentGraphWithUsageAttribution(graph, graphId);
      const input = { messages: [], [USAGE_ATTRIBUTION_KEY]: { graphId: "spoofed" } };
      const config = { configurable: { keep: 1, [USAGE_ATTRIBUTION_KEY]: { graphId: "weather" } } };
      expect(await wrapped.invoke(input, config)).toEqual({ input: { messages: [] }, attribution: { graphId } });
      const chunks = [];
      for await (const chunk of wrapped.stream(input, config)) chunks.push(chunk);
      expect(chunks).toEqual([{ graphId }]);
      expect(config.configurable[USAGE_ATTRIBUTION_KEY]).toEqual({ graphId: "weather" });
    });
  }

  it("does not infer attribution from execution context, tracing or arbitrary input", () => {
    expect(readUsageAttribution({ configurable: { execution_context: { agentId: "chatbot" } }, metadata: { graph_id: "chatbot" } })).toBeUndefined();
    expect(readUsageAttribution({ configurable: { [USAGE_ATTRIBUTION_KEY]: { graphId: "unknown" } } })).toBeUndefined();
  });
});
