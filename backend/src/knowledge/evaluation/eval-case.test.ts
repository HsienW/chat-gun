import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadRawCorpus, prepareCorpus } from "../corpus.js";
import { parseEvalDataset } from "./eval-case.js";

const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

async function loadDataset() {
  return parseEvalDataset(JSON.parse(await readFile(join(DATA_ROOT, "knowledge-eval", "kb-eval-v1.json"), "utf8")));
}

function validCase(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "eval_case@1",
    caseId: "case-1",
    datasetVersion: "kb-eval-test",
    split: "dev",
    input: { question: "How long is the return window?", language: "en" },
    expected: { kind: "answerable", relevantSourceIds: ["policy-return-window"], keyFacts: ["30 days"] },
    prohibitedOutcomes: ["unresolvable_citation"],
    scoring: { scorers: ["recall_at_5"] },
    provenance: { synthetic: true, createdAt: "2026-10-23", method: "test" },
    sensitivityClass: "internal-synthetic",
    tags: ["policy"],
    ...overrides,
  };
}

function datasetOf(cases: unknown[]) {
  return { datasetVersion: "kb-eval-test", corpusVersion: "kb-v1", synthetic: true, createdAt: "2026-10-23", cases };
}

describe("eval_case@1 contract", () => {
  it("accepts a valid case and preserves unknown fields for forward compatibility", () => {
    const parsed = parseEvalDataset(datasetOf([validCase({ futureField: { weight: 2 } })]));
    expect(parsed.rejected).toEqual([]);
    expect((parsed.cases[0] as Record<string, unknown>).futureField).toEqual({ weight: 2 });
  });

  it("rejects an unknown expected kind with a typed failure instead of skipping it silently", () => {
    const parsed = parseEvalDataset(datasetOf([validCase({ caseId: "case-x", expected: { kind: "partial_credit" } })]));
    expect(parsed.cases).toEqual([]);
    expect(parsed.rejected).toEqual([{ index: 0, caseId: "case-x", code: "EVAL_CASE_UNKNOWN_EXPECTED_KIND" }]);
  });

  it.each([
    ["an invalid case", validCase({ split: "holdout" }), "EVAL_CASE_INVALID"],
    ["a case from another dataset version", validCase({ datasetVersion: "kb-eval-other" }), "EVAL_CASE_DATASET_MISMATCH"],
  ])("reports %s", (_name, raw, code) => {
    expect(parseEvalDataset(datasetOf([raw])).rejected[0]?.code).toBe(code);
  });

  it("reports a duplicate case id", () => {
    const parsed = parseEvalDataset(datasetOf([validCase(), validCase()]));
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.rejected).toEqual([{ index: 1, caseId: "case-1", code: "EVAL_CASE_DUPLICATE_ID" }]);
  });

  it("rejects an eval_case@1.1 chain case as an unknown expected kind instead of skipping it", () => {
    const chain = validCase({
      schemaVersion: "eval_case@1.1",
      caseId: "chain-1",
      input: { question: "Hi", language: "en", turns: [{ message: "Hi" }] },
      expected: { kind: "chain", turns: [{ expectedIntent: "clarify" }] },
    });

    const parsed = parseEvalDataset(datasetOf([chain]));

    expect(parsed.cases).toEqual([]);
    expect(parsed.rejected).toEqual([{ index: 0, caseId: "chain-1", code: "EVAL_CASE_UNKNOWN_EXPECTED_KIND" }]);
  });

  it("requires synthetic provenance on every case", () => {
    const parsed = parseEvalDataset(datasetOf([validCase({ provenance: { synthetic: false, createdAt: "x", method: "x" } })]));
    expect(parsed.rejected[0]?.code).toBe("EVAL_CASE_INVALID");
  });
});

describe("dataset kb-eval-v1", () => {
  it("has the required composition and fixed splits", async () => {
    const dataset = await loadDataset();
    expect(dataset.rejected).toEqual([]);
    expect(dataset.corpusVersion).toBe("kb-v1");
    expect(dataset.cases).toHaveLength(40);
    const count = (predicate: (item: (typeof dataset.cases)[number]) => boolean) => dataset.cases.filter(predicate).length;
    expect(count((item) => item.expected.kind === "abstain")).toBeGreaterThanOrEqual(10);
    expect(count((item) => item.tags.includes("adversarial"))).toBeGreaterThanOrEqual(1);
    expect(count((item) => item.tags.includes("cross_lingual"))).toBeGreaterThanOrEqual(1);
    expect(count((item) => item.split === "dev")).toBe(12);
    expect(count((item) => item.split === "test")).toBe(28);
    // Both splits must exercise abstention, or a threshold tuned on dev could not be checked on test.
    expect(count((item) => item.split === "dev" && item.expected.kind === "abstain")).toBeGreaterThan(0);
    expect(count((item) => item.split === "test" && item.expected.kind === "abstain")).toBeGreaterThan(0);
  });

  it("grounds every answerable case in sources and facts that exist in corpus kb-v1", async () => {
    const dataset = await loadDataset();
    const corpus = prepareCorpus(await loadRawCorpus(join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw")));
    const bodies = new Map(corpus.documents.map((document) => [document.sourceId, `${document.title}\n${document.body}`.toLowerCase()]));
    const problems: string[] = [];
    for (const item of dataset.cases) {
      if (item.expected.kind !== "answerable") continue;
      const sources = item.expected.relevantSourceIds;
      for (const sourceId of sources) {
        if (!bodies.has(sourceId)) problems.push(`${item.caseId}: unknown source ${sourceId}`);
      }
      for (const fact of item.expected.keyFacts) {
        if (!sources.some((sourceId) => bodies.get(sourceId)?.includes(fact.toLowerCase()))) {
          problems.push(`${item.caseId}: fact "${fact}" not found in its relevant sources`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
