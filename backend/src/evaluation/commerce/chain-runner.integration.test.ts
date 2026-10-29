import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRawCorpus, prepareCorpus, type SourceDocument } from "../../knowledge/corpus.js";
import { loadSyntheticOrderFixture, type SyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { isChainCase, parseVersionedEvalDataset, type ChainEvalCase } from "./chain-case.js";
import { runDeterministicChainEvaluation } from "./chain-runner.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

describePostgres("deterministic chain evaluation against the Postgres runtime", () => {
  let pool: Pool;
  let cases: ChainEvalCase[];
  let corpus: SourceDocument[];
  let orderFixture: SyntheticOrderFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const dataset = parseVersionedEvalDataset(JSON.parse(await readFile(join(DATA_ROOT, "commerce-eval", "chain-eval-v1.json"), "utf8")));
    cases = dataset.cases.filter(isChainCase);
    corpus = prepareCorpus(await loadRawCorpus(join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw"))).documents;
    orderFixture = await loadSyntheticOrderFixture();
  });

  afterAll(async () => {
    await pool.end();
  });

  const run = (selected: ChainEvalCase[], evaluationRunId: string) =>
    runDeterministicChainEvaluation({ pool, cases: selected, corpus, orderFixture, datasetVersion: "chain-eval-v1", evaluationRunId });

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

  it("runs every chain-eval-v1 case through the real graph, scores it and cleans up its tenants", async () => {
    const evaluationRunId = `chain-it-all-${Date.now().toString(36)}`;

    const result = await run(cases, evaluationRunId);

    const failures = result.results.filter((item) => item.status !== "completed" || !item.passed);
    expect(failures).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.results).toHaveLength(15);
    expect(result.summary.all).toMatchObject({ cases: 15, passedCases: 15, operationTerminalAccuracy: 1, prohibitedOutcomeViolations: 0 });
    expect(result.summary.all.routing).toEqual({ status: "not_measured", reason: "scripted_routing" });
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 120_000);

  it("observes the duplicate, the lost responses and the expiry from structured state", async () => {
    const result = await run(
      [
        caseOf("chain-eval-v1-concurrent-duplicate-01"),
        caseOf("chain-eval-v1-response-lost-committed-01"),
        caseOf("chain-eval-v1-approval-expired-01"),
        caseOf("chain-eval-v1-cancel-before-effect-01"),
      ],
      `chain-it-faults-${Date.now().toString(36)}`
    );
    const observed = (caseId: string) => {
      const item = result.results.find((candidate) => candidate.caseId === caseId);
      if (item?.status !== "completed") throw new Error(`${caseId} did not complete`);
      return item.observations[0]!;
    };

    expect(observed("chain-eval-v1-concurrent-duplicate-01")).toMatchObject({
      operation: { state: "deduplicated", dedupReason: "in_flight_duplicate" },
      providerSubmissions: 1,
    });
    expect(observed("chain-eval-v1-response-lost-committed-01")).toMatchObject({
      operation: { state: "confirmed" },
      providerSubmissions: 1,
      providerLookups: 1,
    });
    expect(observed("chain-eval-v1-approval-expired-01")).toMatchObject({
      operation: { state: "approval_expired" },
      humanDecisionSent: "expire",
      providerSubmissions: 0,
    });
    expect(observed("chain-eval-v1-cancel-before-effect-01")).toMatchObject({
      operation: { state: "cancelled_before_effect" },
      providerSubmissions: 0,
    });
  }, 60_000);

  it("scores a wrong expectation as failed instead of passing it", async () => {
    const denied = caseOf("chain-eval-v1-approval-denied-01");
    const wrong: ChainEvalCase = {
      ...denied,
      caseId: "chain-eval-v1-approval-denied-wrong",
      expected: {
        ...denied.expected,
        turns: [{ ...denied.expected.turns[0]!, operation: { ...denied.expected.turns[0]!.operation!, expectedTerminalState: "confirmed" } }],
      },
    };

    const result = await run([wrong], `chain-it-wrong-${Date.now().toString(36)}`);

    expect(result.status).toBe("completed");
    expect(result.results[0]).toMatchObject({ status: "completed", passed: false });
  }, 30_000);

  it("marks the whole run incomplete when a case cannot be run", async () => {
    const refund = caseOf("chain-eval-v1-refund-01");
    const unscriptable: ChainEvalCase = { ...refund, caseId: "chain-eval-v1-unscriptable", tags: ["refund", "cancel"] };
    const evaluationRunId = `chain-it-incomplete-${Date.now().toString(36)}`;

    const result = await run([caseOf("chain-eval-v1-policy-01"), unscriptable], evaluationRunId);

    expect(result.status).toBe("incomplete");
    expect(result.failedCases).toEqual(["chain-eval-v1-unscriptable"]);
    expect(result.results[1]).toMatchObject({ status: "failed", errorCode: "CHAIN_SCRIPT_AMBIGUOUS_OPERATION" });
    expect(await leftoverRows(evaluationRunId)).toBe(0);
  }, 30_000);
});
