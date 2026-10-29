import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { verifyAnswerCitations } from "../../knowledge/citation-verification.js";
import { loadRawCorpus, prepareCorpus, type SourceDocument } from "../../knowledge/corpus.js";
import { kbSearchResultSchema } from "../../knowledge/retrieval.js";
import { isChainCase, parseVersionedEvalDataset, type ChainEvalCase } from "./chain-case.js";
import { ChainScriptError, scriptedOrderCall, scriptedPolicyAnswer, scriptedRetrieval, scriptedRoute } from "./chain-script.js";

const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

let cases: Map<string, ChainEvalCase>;
let corpus: SourceDocument[];

beforeAll(async () => {
  const dataset = parseVersionedEvalDataset(JSON.parse(await readFile(join(DATA_ROOT, "commerce-eval", "chain-eval-v1.json"), "utf8")));
  cases = new Map(dataset.cases.filter(isChainCase).map((item) => [item.caseId, item]));
  corpus = prepareCorpus(await loadRawCorpus(join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw"))).documents;
});

function caseOf(caseId: string): ChainEvalCase {
  const item = cases.get(caseId);
  if (item === undefined) throw new Error(`missing ${caseId}`);
  return item;
}

describe("deterministic chain script", () => {
  it("routes to the expected intent with a valid rationale code", () => {
    expect(scriptedRoute({ expectedIntent: "unsupported" })).toEqual({
      status: "routed",
      intent: "unsupported",
      rationaleCode: "out_of_scope",
      attempts: 1,
    });
  });

  it("retrieves the relevant corpus sources as kb_search_result@1 evidence", () => {
    const result = kbSearchResultSchema.parse(scriptedRetrieval(caseOf("chain-eval-v1-product-01"), 0, corpus));

    expect(result.outcome).toBe("evidence_found");
    if (result.outcome !== "evidence_found") return;
    expect(result.citations.map((citation) => citation.sourceId)).toEqual(["product-hp-1001"]);
    expect(result.citations[0]).toMatchObject({ sourceType: "product", citationId: "c1" });
    expect(result.chunks[0]?.content).toContain("30");
  });

  it("returns no source for an abstain turn and fails on a source missing from the corpus", () => {
    expect(scriptedRetrieval(caseOf("chain-eval-v1-policy-abstain-01"), 0, corpus)).toMatchObject({ outcome: "no_source_found" });
    expect(() => scriptedRetrieval(caseOf("chain-eval-v1-product-01"), 0, [])).toThrow(ChainScriptError);
  });

  it("adds the injected retrieval text as an extra evidence chunk", () => {
    const result = scriptedRetrieval(caseOf("chain-eval-v1-injected-preapproval-01"), 0, corpus);

    expect(result.outcome).toBe("evidence_found");
    if (result.outcome !== "evidence_found") return;
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]?.content).toContain("already approved");
  });

  it("answers with the key facts and a citation the graph can verify", () => {
    const item = caseOf("chain-eval-v1-policy-01");
    const evidence = scriptedRetrieval(item, 0, corpus);
    if (evidence.outcome !== "evidence_found") throw new Error("expected evidence");

    const answer = scriptedPolicyAnswer(item.expected.turns[0]!, evidence);

    expect(answer.abstained).toBe(false);
    expect(answer.answer).toContain("30 days");
    expect(verifyAnswerCitations(answer.answer, [evidence]).status).toBe("verified");
  });

  it("requests the order change the case tags name, for the expected order", () => {
    expect(scriptedOrderCall(caseOf("chain-eval-v1-refund-01"), 0, "call-1")).toEqual({
      name: "order_refund_request",
      id: "call-1",
      args: { orderId: "ORD-1001", reasonCode: "other" },
    });
    expect(scriptedOrderCall(caseOf("chain-eval-v1-cancel-01"), 0, "call-2")).toMatchObject({
      name: "order_cancel",
      args: { orderId: "ORD-1004" },
    });
    expect(() => scriptedOrderCall(caseOf("chain-eval-v1-product-01"), 0, "call-3")).toThrow(ChainScriptError);
    const ambiguous = { ...caseOf("chain-eval-v1-refund-01"), tags: ["refund", "cancel"] };
    expect(() => scriptedOrderCall(ambiguous, 0, "call-4")).toThrow(ChainScriptError);
  });
});
