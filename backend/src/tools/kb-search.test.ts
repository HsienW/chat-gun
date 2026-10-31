import { describe, expect, it } from "vitest";

import { createSystemExecutionContext } from "../knowledge/connection.js";
import { prepareCorpus } from "../knowledge/corpus.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { InMemoryKnowledgeStore } from "../knowledge/in-memory-store.js";
import { ingestCorpus } from "../knowledge/ingestion.js";
import { kbSearchResultSchema } from "../knowledge/retrieval.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "../knowledge/testing-fakes.js";
import { withExecutionContext } from "../runtime/execution-context/read-execution-context.js";
import { withResolvedSecrets } from "../runtime/tool-dispatch/secret-broker.js";
import { createKbSearchTool, KB_SEARCH_SECRET_REFERENCE } from "./kb-search.js";

const config = testKnowledgeConfig();
const CREDENTIAL = "kb-test-credential";

async function setup() {
  const store = new InMemoryKnowledgeStore();
  const ingestionGateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
  for (const [tenantId, body] of [
    ["public", "Most items can be returned within 30 days of the delivery date."],
    ["tenant-other", "Other tenant: returns are accepted within 90 days of the delivery date."],
  ] as const) {
    await ingestCorpus({
      runId: `seed-${tenantId}`,
      tenantId,
      corpus: prepareCorpus({
        products: [],
        policyMarkdown: [{
          origin: "policy",
          markdown: `---\nsynthetic: true\ncorpusVersion: kb-test\ngeneratedAt: 2026-10-23\nsourceId: policy-return-window\nsourceType: policy\ntitle: Return Window\n---\n\n${body}`,
        }],
      }),
      store,
      gateway: ingestionGateway,
      credential: CREDENTIAL,
      config,
    });
  }
  const gateway = new FakeKnowledgeModelGateway({ dimensions: 64 });
  const tool = createKbSearchTool({ config: () => config, store: async () => store, gateway: () => gateway });
  const context = createSystemExecutionContext("kb-tool-test");
  const runnableConfig = withResolvedSecrets(withExecutionContext({}, context), { [KB_SEARCH_SECRET_REFERENCE.secretRef]: CREDENTIAL });
  return { tool, gateway, context, runnableConfig };
}

describe("kb_search tool", () => {
  it("returns schema-valid evidence for the execution-context tenant only", async () => {
    const { tool, gateway, runnableConfig } = await setup();
    const output = JSON.parse(await tool.invoke({ query: "How many days do I have to return items after delivery?" }, runnableConfig) as string);

    expect(kbSearchResultSchema.safeParse(output).success).toBe(true);
    expect(output.outcome).toBe("evidence_found");
    expect(JSON.stringify(output)).not.toContain("90 days");
    expect(gateway.credentials.every((credential) => credential === CREDENTIAL)).toBe(true);
    expect(JSON.stringify(output)).not.toContain(CREDENTIAL);
  });

  it.each([["tenantId"], ["principalId"], ["approved"]])("rejects model-supplied %s before any retrieval", async (field) => {
    const { tool, gateway, runnableConfig } = await setup();
    await expect(tool.invoke({ query: "returns", [field]: "tenant-other" }, runnableConfig)).rejects.toThrow();
    expect(gateway.embedCalls).toHaveLength(0);
  });

  it("fails with SECRET_REFERENCE_UNRESOLVABLE when the broker did not inject a credential", async () => {
    const { tool, gateway, context } = await setup();
    const output = JSON.parse(await tool.invoke({ query: "returns" }, withExecutionContext({}, context)) as string);
    expect(output).toMatchObject({ outcome: "error", errorCode: "SECRET_REFERENCE_UNRESOLVABLE", retryable: false });
    expect(gateway.embedCalls).toHaveLength(0);
  });

  it("fails closed without a server-side execution context", async () => {
    const { tool, gateway } = await setup();
    const output = JSON.parse(
      await tool.invoke({ query: "returns" }, withResolvedSecrets({}, { [KB_SEARCH_SECRET_REFERENCE.secretRef]: CREDENTIAL })) as string
    );
    expect(output).toMatchObject({ outcome: "error", errorCode: "KB_CONFIG_INVALID" });
    expect(gateway.embedCalls).toHaveLength(0);
  });

  it.each([
    ["EGRESS_DENIED", "PRIVATE_ADDRESS"],
    ["EGRESS_POLICY_UNAVAILABLE", "DNS_RESOLUTION_FAILED"],
  ] as const)("returns a typed %s failure instead of an empty result when the query embedding fails at egress", async (code, reason) => {
    const { runnableConfig } = await setup();
    const failingGateway = new FakeKnowledgeModelGateway({
      dimensions: 64,
      failEmbeddingFor: () => new KnowledgeError(code, "egress failed", reason),
    });
    const tool = createKbSearchTool({ config: () => config, store: async () => new InMemoryKnowledgeStore(), gateway: () => failingGateway });
    const output = JSON.parse(await tool.invoke({ query: "returns" }, runnableConfig) as string);

    expect(output).toEqual({ schemaVersion: "kb_search_result@1", outcome: "error", errorCode: code, retryable: false, egressReasonCode: reason });
  });

  it("reports cancellation as a typed outcome", async () => {
    const { tool, runnableConfig } = await setup();
    const controller = new AbortController();
    controller.abort();
    const output = JSON.parse(await tool.invoke({ query: "returns" }, { ...runnableConfig, signal: controller.signal }) as string);
    expect(output).toMatchObject({ outcome: "error", errorCode: "KB_CANCELLED" });
  });
});
