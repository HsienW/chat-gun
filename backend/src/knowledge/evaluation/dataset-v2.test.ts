import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRawCorpus } from "../corpus.js";
import { parseEvalDataset } from "./eval-case.js";
import { createEvaluationCorpus, readCaseOrigin, validateDatasetV2 } from "./dataset-v2.js";

const v1 = parseEvalDataset(JSON.parse(await readFile("data/knowledge-eval/kb-eval-v1.json", "utf8")));
const corpus = createEvaluationCorpus(await loadRawCorpus("data/knowledge-corpus/kb-v1/raw"));
const rawV2 = JSON.parse(await readFile("data/knowledge-eval/kb-eval-v2.json", "utf8"));
const v2 = parseEvalDataset(rawV2);

describe("v2 dataset validation", () => {
  it("keeps v1 and unknown origins unclassified", () => {
    expect(v1.cases.every((item) => readCaseOrigin(item) === "unclassified")).toBe(true);
    expect(readCaseOrigin({ provenance: { origin: "future" } })).toBe("unclassified");
  });
  it("reports composition shortfalls without a model", () => {
    const issues = validateDatasetV2({ ...v1, datasetVersion: "kb-eval-v2", cases: [] }, corpus, v1);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["ORIGIN_COUNT", "TAG_MINIMUM", "ABSTAIN_MINIMUM", "ADVERSARIAL_MINIMUM", "LANGUAGE_MINIMUM"]));
  });
  it("validates the full corpus-only draft and M1 language allocation", () => {
    expect(validateDatasetV2(v2, corpus, v1)).toEqual([]);
    expect(v2.cases).toHaveLength(90);
    for (const [origin, minimum] of [["template", 2], ["hand_authored", 1]] as const) {
      for (const language of ["zh-TW", "zh-CN"]) expect(v2.cases.filter((item) => item.split === "test" && readCaseOrigin(item) === origin && item.tags.includes("cross_lingual") && item.input.language === language).length).toBeGreaterThanOrEqual(minimum);
    }
  });
  it.each([
    ["KEY_FACT_MISSING", "same_series", (item: typeof v2.cases[number]) => { if (item.expected.kind === "answerable") item.expected.keyFacts = ["not a corpus fact"]; }],
    ["SKU_MISSING", "sku_lookup", (item: typeof v2.cases[number]) => { item.input.question = "What does the target cost?"; }],
    ["SERIES_INVALID", "same_series", (item: typeof v2.cases[number]) => { item.expected.seriesSiblingSourceIds = []; }],
    ["SERIES_NOT_DISTINCT", "same_series", (item: typeof v2.cases[number]) => { if (item.expected.kind === "answerable") item.expected.keyFacts = ["USD"]; }],
    ["MULTI_GROUND_TRUTH", "multi_answer", (item: typeof v2.cases[number]) => { if (item.expected.kind === "answerable") item.expected.relevantSourceIds.pop(); }],
    ["NEAR_MISS_INVALID", "near_miss", (item: typeof v2.cases[number]) => { item.expected.nearMissSourceIds = []; }],
    ["NEAR_MISS_SKU", "near_miss", (item: typeof v2.cases[number]) => { item.expected.fabricatedSku = corpus.products[0].sku; item.input.question += corpus.products[0].sku; }],
    ["CROSS_LINGUAL_INVALID", "cross_lingual", (item: typeof v2.cases[number]) => { item.input.language = "en"; }],
    ["CROSS_SOURCE_INVALID", "cross_source", (item: typeof v2.cases[number]) => { if (item.expected.kind === "answerable") item.expected.relevantSourceIds = item.expected.relevantSourceIds.filter((id) => id.startsWith("product-")); }],
    ["SOURCE_MISSING", "sku_lookup", (item: typeof v2.cases[number]) => { if (item.expected.kind === "answerable") item.expected.relevantSourceIds.push("missing"); }],
    ["V1_QUESTION_DUPLICATE", "sku_lookup", (item: typeof v2.cases[number]) => { item.input.question = "  " + v1.cases[0].input.question + "  "; }],
    ["ORIGIN_INVALID", "sku_lookup", (item: typeof v2.cases[number]) => { item.provenance.origin = "unknown"; }],
    ["AUTHOR_MISSING", "sku_lookup", (item: typeof v2.cases[number]) => { item.provenance.origin = "hand_authored"; delete item.provenance.authoredBy; }],
  ])("rejects %s", (code, tag, mutate) => {
    const draft = structuredClone(v2);
    const item = draft.cases.find((item) => item.tags.includes(tag))!;
    mutate(item);
    expect(validateDatasetV2(draft, corpus, v1).map((issue) => issue.code)).toContain(code);
  });
  it("rejects ambiguous identical titles unless every SKU is relevant", () => {
    const draft = structuredClone(v2);
    const duplicates = corpus.products.filter((product) => corpus.products.filter((other) => other.title === product.title).length > 1);
    const item = draft.cases.find((item) => item.expected.kind === "answerable")!;
    item.input.question = "What can you tell me about " + duplicates[0].title + "?";
    item.expected = { kind: "answerable", relevantSourceIds: [duplicates[0].sourceId], keyFacts: [duplicates[0].title] };
    expect(validateDatasetV2(draft, corpus, v1).map((issue) => issue.code)).toContain("TITLE_GROUND_TRUTH");
  });
  it("rejects direct and transitive same-series split leakage", () => {
    for (const tag of ["sku_lookup", "same_series"]) {
      const draft = structuredClone(v2);
      const item = structuredClone(draft.cases.find((item) => item.split === "test" && item.tags.includes(tag))!);
      item.caseId += "-other";
      item.split = "dev";
      if (tag === "same_series") {
        const siblings = item.expected.seriesSiblingSourceIds;
        if (!Array.isArray(siblings) || typeof siblings[0] !== "string") throw new Error("missing fixture sibling");
        item.expected = { kind: "answerable", relevantSourceIds: [siblings[0]], keyFacts: ["USD"] };
        item.tags = [];
      }
      draft.cases.push(item);
      expect(validateDatasetV2(draft, corpus, v1).map((issue) => issue.code)).toContain("SOURCE_SPLIT_LEAK");
    }
  });
  it("rejects calibrated v1 dev sources in test", () => {
    const draft = structuredClone(v2);
    draft.cases[0].split = "test";
    draft.cases[0].expected = { kind: "answerable", relevantSourceIds: ["policy-return-window"], keyFacts: ["30 days"] };
    expect(validateDatasetV2(draft, corpus, v1).map((issue) => issue.code)).toContain("V1_DEV_LEAK");
  });
});
