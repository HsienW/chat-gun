import { z } from "zod";
import { prepareCorpus, type SourceDocument } from "../corpus.js";
import type { EvalCase, ParsedEvalDataset } from "./eval-case.js";

export const REQUIRED_EVALUATION_TAGS = ["sku_lookup", "same_series", "multi_answer", "near_miss", "cross_lingual", "cross_source"] as const;
const originSchema = z.enum(["template", "hand_authored"]);
export type CaseOrigin = z.infer<typeof originSchema> | "unclassified";
export function readCaseOrigin(input: unknown): CaseOrigin {
  const parsed = z.object({ provenance: z.object({ origin: originSchema }) }).safeParse(input);
  return parsed.success ? parsed.data.provenance.origin : "unclassified";
}

const productSchema = z.object({
  sourceId: z.string(), sku: z.string(), brand: z.string(), category: z.string(), title: z.string(),
  priceUsd: z.number(), features: z.array(z.string()), specs: z.record(z.string()), finalSale: z.boolean(),
});
export type EvaluationProduct = z.infer<typeof productSchema>;
export interface EvaluationCorpus {
  documents: SourceDocument[];
  products: EvaluationProduct[];
  language: "en";
}
/** Only records accepted by prepareCorpus participate; first accepted source wins. */
export function createEvaluationCorpus(raw: Parameters<typeof prepareCorpus>[0]): EvaluationCorpus {
  const documents = prepareCorpus(raw).documents;
  const accepted = new Set(documents.filter((doc) => doc.sourceType === "product").map((doc) => doc.sourceId));
  const products: EvaluationProduct[] = [];
  for (const record of raw.products) {
    const parsed = productSchema.safeParse(record);
    if (parsed.success && accepted.delete(parsed.data.sourceId)) products.push(parsed.data);
  }
  if (accepted.size) throw new Error("EVAL_CORPUS_PRODUCT_METADATA_INVALID");
  return { documents, products, language: "en" };
}
export function seriesKey(product: EvaluationProduct): string {
  return JSON.stringify([product.brand, product.category, product.title.slice(0, product.title.lastIndexOf(" "))]);
}
export const groundTruthRuleSchema = z.object({
  category: z.string().min(1), feature: z.string().min(1), maxPriceUsd: z.number().nonnegative(),
}).strict();
export type GroundTruthRule = z.infer<typeof groundTruthRuleSchema>;
export function matchGroundTruthRule(products: readonly EvaluationProduct[], rule: GroundTruthRule): EvaluationProduct[] {
  return products.filter((product) => product.category === rule.category && product.features.includes(rule.feature) && product.priceUsd <= rule.maxPriceUsd);
}
const sourceIdsSchema = z.array(z.string().min(1)).min(1);
const normalizeQuestion = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size && left.length === right.length && left.every((id) => right.includes(id));
}
export interface DatasetIssue { code: string; caseIds: string[]; detail: string }
/** Independent of the builder: recomputes composition, ground truth and source connectivity. */
export function validateDatasetV2(dataset: ParsedEvalDataset, corpus: EvaluationCorpus, v1: ParsedEvalDataset): DatasetIssue[] {
  const issues: DatasetIssue[] = [];
  const add = (code: string, detail: string, caseIds: string[] = []) => issues.push({ code, caseIds, detail });
  const documents = new Map(corpus.documents.map((doc) => [doc.sourceId, doc]));
  const products = new Map(corpus.products.map((product) => [product.sourceId, product]));
  const count = (predicate: (item: EvalCase) => boolean) => dataset.cases.filter(predicate).length;
  if (dataset.datasetVersion !== "kb-eval-v2" || dataset.corpusVersion !== "kb-v1" || dataset.rejected.length > 0) add("DATASET_CONTRACT", "Expected kb-eval-v2 bound to kb-v1 without rejected cases");
  for (const [origin, lower, upper] of [["template", 55, 65], ["hand_authored", 27, 33]] as const) {
    const n = count((item) => readCaseOrigin(item) === origin);
    if (n < lower || n > upper) add("ORIGIN_COUNT", `${origin}: ${n}, expected ${lower}..${upper}`);
  }
  for (const tag of REQUIRED_EVALUATION_TAGS) {
    for (const [split, minimum, handOnly] of [["dev", 3, false], ["test", 10, false], ["test", 5, true]] as const) {
      const n = count((item) => item.split === split && item.tags.includes(tag) && (!handOnly || readCaseOrigin(item) === "hand_authored"));
      if (n < minimum) add("TAG_MINIMUM", `${tag}/${split}/hand=${handOnly}: ${n}<${minimum}`);
    }
  }
  for (const [split, minimum] of [["dev", 5], ["test", 10]] as const) {
    if (count((item) => item.split === split && item.expected.kind === "abstain") < minimum) add("ABSTAIN_MINIMUM", split);
  }
  if (count((item) => item.tags.includes("adversarial")) < 2) add("ADVERSARIAL_MINIMUM", "Need two adversarial cases");
  for (const language of ["zh-TW", "zh-CN"] as const) {
    if (count((item) => item.split === "test" && item.tags.includes("cross_lingual") && item.input.language === language) < 3) add("LANGUAGE_MINIMUM", language);
  }
  const v1Questions = new Set(v1.cases.map((item) => normalizeQuestion(item.input.question)));
  const seenQuestions = new Set<string>();
  const v1Dev = new Set(v1.cases.filter((item) => item.split === "dev" && item.expected.kind === "answerable").flatMap((item) => item.expected.kind === "answerable" ? item.expected.relevantSourceIds : []));
  const parent = new Map(corpus.documents.map((doc) => [doc.sourceId, doc.sourceId]));
  const find = (id: string): string => {
    const ancestor = parent.get(id) ?? id;
    if (ancestor === id) return id;
    const root = find(ancestor);
    parent.set(id, root);
    return root;
  };
  const union = (ids: readonly string[]) => { for (const id of ids.slice(1)) parent.set(find(id), find(ids[0])); };
  const series = new Map<string, string[]>();
  for (const product of corpus.products) series.set(seriesKey(product), [...(series.get(seriesKey(product)) ?? []), product.sourceId]);
  for (const ids of series.values()) union(ids);
  const caseSources = new Map<string, string[]>();
  for (const item of dataset.cases) {
    const fail = (code: string, detail: string) => add(code, detail, [item.caseId]);
    if (readCaseOrigin(item) === "unclassified") fail("ORIGIN_INVALID", "Missing or unknown origin");
    if (readCaseOrigin(item) === "hand_authored" && !z.string().min(1).safeParse(item.provenance.authoredBy).success) fail("AUTHOR_MISSING", "Actual author required");
    const normalized = normalizeQuestion(item.input.question);
    if (v1Questions.has(normalized)) fail("V1_QUESTION_DUPLICATE", normalized);
    if (seenQuestions.has(normalized)) fail("QUESTION_DUPLICATE", normalized);
    seenQuestions.add(normalized);
    const relevant = item.expected.kind === "answerable" ? item.expected.relevantSourceIds : [];
    const siblingResult = sourceIdsSchema.safeParse(item.expected.seriesSiblingSourceIds);
    const nearResult = sourceIdsSchema.safeParse(item.expected.nearMissSourceIds);
    const siblings = siblingResult.success ? siblingResult.data : [];
    const near = nearResult.success ? nearResult.data : [];
    const ids = [...new Set([...relevant, ...siblings, ...near])];
    caseSources.set(item.caseId, ids);
    union(ids);
    for (const id of ids) if (!documents.has(id)) fail("SOURCE_MISSING", id);
    if (item.split === "test") for (const id of ids) if (v1Dev.has(id)) fail("V1_DEV_LEAK", id);
    if (item.expected.kind === "answerable") {
      for (const fact of item.expected.keyFacts) {
        if (!relevant.some((id) => documents.get(id)?.body.includes(fact) || documents.get(id)?.title.includes(fact))) fail("KEY_FACT_MISSING", fact);
      }
    }
    const targets = relevant.flatMap((id) => products.has(id) ? [products.get(id)!] : []);
    if (item.tags.includes("sku_lookup") && !targets.some((product) => item.input.question.includes(product.sku))) fail("SKU_MISSING", "Relevant SKU must occur in question");
    if (item.tags.includes("same_series")) {
      const target = targets[0];
      const expectedSiblings = target ? (series.get(seriesKey(target)) ?? []).filter((id) => id !== target.sourceId) : [];
      if (!target || !expectedSiblings.length || !sameSet(siblings, expectedSiblings) || !item.input.question.includes(target.sku)) fail("SERIES_INVALID", "Must identify target and every series sibling");
      if (item.expected.kind !== "answerable" || !item.expected.keyFacts.some((fact) => relevant.some((id) => documents.get(id)?.body.includes(fact)) && expectedSiblings.some((id) => !documents.get(id)?.body.includes(fact)))) fail("SERIES_NOT_DISTINCT", "Need a discriminating fact");
    }
    if (item.tags.includes("multi_answer")) {
      const rule = groundTruthRuleSchema.safeParse(item.expected.groundTruthRule);
      const matches = rule.success ? matchGroundTruthRule(corpus.products, rule.data).map((product) => product.sourceId) : [];
      if (!rule.success || matches.length < 2 || matches.length > 5 || !sameSet(relevant, matches)) fail("MULTI_GROUND_TRUTH", "Relevant sources must equal the full query result (2..5)");
    }
    if (item.tags.includes("near_miss")) {
      if (item.expected.kind !== "abstain" || !nearResult.success) fail("NEAR_MISS_INVALID", "Abstain and closest sources required");
      if (readCaseOrigin(item) === "template") {
        const sku = z.string().min(1).safeParse(item.expected.fabricatedSku);
        if (!sku.success || !item.input.question.includes(sku.data) || corpus.products.some((product) => product.sku === sku.data)) fail("NEAR_MISS_SKU", "Template SKU must be absent from corpus");
      }
    }
    if (item.tags.includes("cross_lingual") && (!ids.length || item.input.language === corpus.language)) fail("CROSS_LINGUAL_INVALID", "Question and source languages must differ");
    if (item.tags.includes("cross_source") && new Set(relevant.map((id) => documents.get(id)?.sourceType).filter(Boolean)).size < 2) fail("CROSS_SOURCE_INVALID", "Need two source types");
    for (const product of corpus.products) {
      if (item.input.question.includes(product.title) && !item.input.question.includes(product.sku)) {
        const matches = corpus.products.filter((other) => other.title === product.title);
        if (matches.length > 1 && !matches.every((other) => relevant.includes(other.sourceId))) fail("TITLE_GROUND_TRUTH", product.title);
      }
    }
  }
  const components = new Map<string, { splits: Set<string>; cases: string[]; sources: Set<string> }>();
  for (const item of dataset.cases) for (const id of caseSources.get(item.caseId) ?? []) {
    const root = find(id);
    const component = components.get(root) ?? { splits: new Set<string>(), cases: [], sources: new Set<string>() };
    component.splits.add(item.split);
    component.cases.push(item.caseId);
    component.sources.add(id);
    components.set(root, component);
  }
  for (const [root, component] of components) {
    if (component.splits.size > 1) add("SOURCE_SPLIT_LEAK", [...component.sources].join(","), [...new Set(component.cases)]);
    if (component.splits.has("test") && [...v1Dev].some((id) => find(id) === root)) add("V1_DEV_LEAK", [...component.sources].join(","), [...new Set(component.cases)]);
  }
  return issues;
}
