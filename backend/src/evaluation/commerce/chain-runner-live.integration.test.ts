import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ShoppingIntentRouter } from "../../agents/shopping-assistant/intent-router.js";
import type { PolicyAnswerSynthesizer } from "../../agents/shopping-assistant/policy-answer.js";
import { loadRawCorpus, prepareCorpus, type PreparedCorpus } from "../../knowledge/corpus.js";
import { InMemoryKnowledgeStore } from "../../knowledge/in-memory-store.js";
import { ingestCorpus } from "../../knowledge/ingestion.js";
import type { RecallQuery } from "../../knowledge/store.js";
import { FakeKnowledgeModelGateway, testKnowledgeConfig } from "../../knowledge/testing-fakes.js";
import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import { KB_SEARCH_TOOL_NAME, createKbSearchTool } from "../../tools/kb-search.js";
import { loadSyntheticOrderFixture, type SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { isChainCase, parseVersionedEvalDataset, type ChainEvalCase } from "./chain-case.js";
import { liveCasePrincipalId, liveTenantId } from "./chain-isolation.js";
import { runLiveChainEvaluation, type LiveChainKnowledge, type LiveChainModels } from "./chain-runner.js";
import { scriptedOrderCall, scriptedPolicyAnswer, scriptedRoute } from "./chain-script.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

/**
 * Stand-ins for the models under test. Unlike the deterministic scripts they
 * name their own tool calls, so the runner has to find the operation a turn
 * requested from structured state rather than from an id it chose.
 */
function modelLikeFakes(cases: readonly ChainEvalCase[]) {
  const turnOf = (message: string) => {
    for (const item of cases) {
      const turnIndex = item.input.turns.findIndex((turn) => turn.message === message);
      if (turnIndex !== -1) return { item, turnIndex, expectation: item.expected.turns[turnIndex]! };
    }
    throw new Error(`No case turn for message: ${message}`);
  };
  const lastHuman = (messages: readonly BaseMessage[]) => {
    const human = [...messages].reverse().find((message) => message.getType() === "human");
    return typeof human?.content === "string" ? human.content : "";
  };
  const unbound = async (): Promise<never> => {
    throw new Error("request models are only used through bindTools");
  };
  const requestModel = (calls: (message: string) => AIMessage["tool_calls"]): ChatModelInvoker => ({
    invoke: unbound,
    bindTools: () => ({ invoke: async (messages: BaseMessage[]) => new AIMessage({ content: "", tool_calls: calls(lastHuman(messages)) }) }),
  });
  const routed: string[] = [];
  const intentRouter: ShoppingIntentRouter = {
    promptVersion: "model-like-router",
    route: async (message) => {
      routed.push(message);
      return scriptedRoute(turnOf(message).expectation);
    },
  };
  const policyAnswerSynthesizer: PolicyAnswerSynthesizer = {
    promptVersion: "model-like-policy",
    synthesize: async (question, evidence) => scriptedPolicyAnswer(turnOf(question).expectation, evidence),
  };
  const models: LiveChainModels = {
    intentRouter,
    policyAnswerSynthesizer,
    createProductRequestModel: () =>
      requestModel((message) => {
        const intent = turnOf(message).expectation.expectedIntent;
        return [
          {
            name: KB_SEARCH_TOOL_NAME,
            id: `model-kb-${randomUUID()}`,
            args: { query: message, sourceTypes: intent === "product_lookup" ? ["product"] : ["policy", "faq"] },
          },
        ];
      }),
    createOrderRequestModel: () =>
      requestModel((message) => {
        const { item, turnIndex } = turnOf(message);
        return [scriptedOrderCall(item, turnIndex, `model-order-${randomUUID()}`)];
      }),
  };
  return { models, routed };
}

/** kb_search over an in-memory knowledge store, recording the tenants it reads and purges. */
function inMemoryKnowledge(corpus: PreparedCorpus, options: { failIngestion?: boolean; failPurge?: boolean } = {}) {
  const config = testKnowledgeConfig();
  const store = new InMemoryKnowledgeStore();
  const recalledTenants: string[] = [];
  const recall = store.recall.bind(store);
  store.recall = async (query: RecallQuery) => {
    recalledTenants.push(query.tenantId);
    return recall(query);
  };
  const gateway = new FakeKnowledgeModelGateway({ dimensions: config.embeddingDimensions });
  const ingestedTenants: string[] = [];
  const purgedTenants: string[] = [];
  const knowledge: LiveChainKnowledge = {
    ingest: async (tenantId) => {
      ingestedTenants.push(tenantId);
      if (options.failIngestion) return { status: "failed", errorCode: "KB_PROVIDER_ERROR" };
      const result = await ingestCorpus({ runId: `kb-run-${randomUUID()}`, tenantId, corpus, store, gateway, credential: "test-credential", config });
      return { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
    },
    kbSearch: createKbSearchTool({ config: () => config, store: async () => store, gateway: () => gateway }),
    secretBroker: { resolve: async () => ({ value: "test-credential" }) },
    purge: async (tenantId) => {
      purgedTenants.push(tenantId);
      if (options.failPurge) throw Object.assign(new Error("purge failed"), { code: "KB_STORE_UNAVAILABLE" });
      for (const document of corpus.documents) await store.deleteSource(tenantId, document.sourceId);
    },
  };
  return { knowledge, store, gateway, recalledTenants, ingestedTenants, purgedTenants };
}

describePostgres("live chain evaluation harness against the Postgres runtime (design §20.5 B1)", () => {
  let pool: Pool;
  let cases: ChainEvalCase[];
  let corpus: PreparedCorpus;
  let orderFixture: SyntheticOrderFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const dataset = parseVersionedEvalDataset(JSON.parse(await readFile(join(DATA_ROOT, "commerce-eval", "chain-eval-v1.json"), "utf8")));
    cases = dataset.cases.filter(isChainCase);
    corpus = prepareCorpus(await loadRawCorpus(join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw")));
    orderFixture = await loadSyntheticOrderFixture();
  });

  afterAll(async () => {
    await pool.end();
  });

  const caseOf = (caseId: string) => {
    const item = cases.find((candidate) => candidate.caseId === caseId);
    if (item === undefined) throw new Error(`missing ${caseId}`);
    return item;
  };

  async function leftoverRows(evaluationRunId: string) {
    const tenants = `${evaluationRunId}-%`;
    const counts = await Promise.all(
      [
        "SELECT COUNT(*)::int AS n FROM business_effects WHERE tenant_id LIKE $1",
        "SELECT COUNT(*)::int AS n FROM authorization_confirmations WHERE tenant_id LIKE $1",
        "SELECT COUNT(*)::int AS n FROM permission_grants WHERE resource_tenant_id LIKE $1",
        "SELECT COUNT(*)::int AS n FROM order_operation_requests WHERE tenant_id LIKE $1",
      ].map(async (text) => ((await pool.query(text, [tenants])).rows[0] as { n: number }).n)
    );
    return counts.reduce((sum, n) => sum + n, 0);
  }

  function run(selected: ChainEvalCase[], evaluationRunId: string, knowledge: LiveChainKnowledge, models: LiveChainModels, audit?: Parameters<typeof runLiveChainEvaluation>[0]["audit"]) {
    return runLiveChainEvaluation({
      pool,
      cases: selected,
      corpus: corpus.documents,
      orderFixture,
      datasetVersion: "chain-eval-v1",
      evaluationRunId,
      models,
      knowledge,
      ...(audit ? { audit } : {}),
    });
  }

  it("imports kb-v1 into one dedicated tenant, isolates each case by principal, measures routing and cleans up", async () => {
    const evaluationRunId = `chain-live-it-${Date.now().toString(36)}`;
    const selected = [
      caseOf("chain-eval-v1-policy-01"),
      caseOf("chain-eval-v1-refund-01"),
      caseOf("chain-eval-v1-approval-denied-01"),
      caseOf("chain-eval-v1-concurrent-duplicate-01"),
      caseOf("chain-eval-v1-unsupported-01"),
    ];
    const { models } = modelLikeFakes(selected);
    const knowledge = inMemoryKnowledge(corpus);
    const principalsByCase = new Map<string, Set<string>>();
    const audit = async (_eventName: string, _payload: unknown, context?: { principal?: { principalId: string; tenantId: string } }) => {
      if (context?.principal === undefined) return;
      const owner = selected.find((item) => context.principal!.principalId === liveCasePrincipalId(evaluationRunId, item.caseId));
      const key = owner?.caseId ?? `unexpected:${context.principal.principalId}@${context.principal.tenantId}`;
      principalsByCase.set(key, (principalsByCase.get(key) ?? new Set()).add(context.principal.tenantId));
    };

    const result = await run(selected, evaluationRunId, knowledge.knowledge, models, audit);

    const tenant = liveTenantId(evaluationRunId);
    expect(knowledge.ingestedTenants).toEqual([tenant]);
    expect(knowledge.recalledTenants.length).toBeGreaterThan(0);
    expect(new Set(knowledge.recalledTenants)).toEqual(new Set([tenant]));
    expect([...principalsByCase.keys()].filter((key) => key.startsWith("unexpected:"))).toEqual([]);
    for (const tenants of principalsByCase.values()) expect([...tenants]).toEqual([tenant]);

    expect(result.mode).toBe("live");
    expect(result.status).toBe("completed");
    expect(result.cleanup).toEqual({ status: "completed" });
    const observed = (caseId: string) => {
      const item = result.results.find((candidate) => candidate.caseId === caseId);
      if (item?.status !== "completed") throw new Error(`${caseId} did not complete`);
      return item;
    };
    expect(observed("chain-eval-v1-refund-01")).toMatchObject({ passed: true, observations: [{ operation: { state: "confirmed" } }] });
    expect(observed("chain-eval-v1-refund-01").observations[0]!.operation!.toolCallId).toMatch(/^model-order-/u);
    expect(observed("chain-eval-v1-approval-denied-01")).toMatchObject({ passed: true, observations: [{ providerSubmissions: 0 }] });
    expect(observed("chain-eval-v1-concurrent-duplicate-01")).toMatchObject({
      passed: true,
      observations: [{ operation: { state: "deduplicated", dedupReason: "in_flight_duplicate" }, providerSubmissions: 1 }],
    });
    expect(observed("chain-eval-v1-unsupported-01").passed).toBe(true);
    expect(result.summary.all.routing).toMatchObject({ status: "measured", accuracy: 1 });
    expect(result.summary.all.prohibitedOutcomeViolations).toBe(0);

    expect(knowledge.purgedTenants).toEqual([tenant]);
    expect(await knowledge.store.countChunks(tenant)).toBe(0);
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 180_000);

  it("fails the whole run closed without running any case when the import fails, and still cleans up", async () => {
    const evaluationRunId = `chain-live-it-ingest-${Date.now().toString(36)}`;
    const selected = [caseOf("chain-eval-v1-policy-01"), caseOf("chain-eval-v1-refund-01")];
    const { models, routed } = modelLikeFakes(selected);
    const knowledge = inMemoryKnowledge(corpus, { failIngestion: true });

    const result = await run(selected, evaluationRunId, knowledge.knowledge, models);

    expect(result.status).toBe("incomplete");
    expect(result.failedCases).toEqual(selected.map((item) => item.caseId));
    expect(result.results.every((item) => item.status === "failed" && item.errorCode === "CHAIN_LIVE_KNOWLEDGE_IMPORT_FAILED")).toBe(true);
    expect(routed).toEqual([]);
    expect(knowledge.purgedTenants).toEqual([liveTenantId(evaluationRunId)]);
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 60_000);

  it("reports a failed cleanup instead of passing over it", async () => {
    const evaluationRunId = `chain-live-it-purge-${Date.now().toString(36)}`;
    const selected = [caseOf("chain-eval-v1-unsupported-01")];
    const { models } = modelLikeFakes(selected);
    const knowledge = inMemoryKnowledge(corpus, { failPurge: true });

    const result = await run(selected, evaluationRunId, knowledge.knowledge, models);

    expect(result.cleanup).toEqual({ status: "failed", errorCode: "KB_STORE_UNAVAILABLE" });
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 60_000);

  it("records a model failure as an incomplete case and keeps running the others", async () => {
    const evaluationRunId = `chain-live-it-model-${Date.now().toString(36)}`;
    const selected = [caseOf("chain-eval-v1-refund-01"), caseOf("chain-eval-v1-unsupported-01")];
    const { models } = modelLikeFakes(selected);
    const failing: LiveChainModels = {
      ...models,
      createOrderRequestModel: () => ({
        invoke: async () => {
          throw new Error("unused");
        },
        bindTools: () => ({
          invoke: async () => {
            throw Object.assign(new Error("provider down"), { code: "LLM_PROVIDER_ERROR" });
          },
        }),
      }),
    };

    const result = await run(selected, evaluationRunId, inMemoryKnowledge(corpus).knowledge, failing);

    const refund = result.results.find((item) => item.caseId === "chain-eval-v1-refund-01");
    expect(refund?.status === "failed" || (refund?.status === "completed" && !refund.passed)).toBe(true);
    expect(result.results.find((item) => item.caseId === "chain-eval-v1-unsupported-01")).toMatchObject({ status: "completed", passed: true });
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 60_000);
});
