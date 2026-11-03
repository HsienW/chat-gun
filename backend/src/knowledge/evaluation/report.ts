import { createHash } from "node:crypto";

import { z } from "zod";

import { summarize, summarizeStrata, type CaseResult, type EvaluationRun, type EvidenceBlock, type SplitSummary } from "./runner.js";
import { EVALUATION_STAGES, retrievalLatency } from "./stage-latency.js";

export const MANUAL_INSPECTION_MINIMUM = 10;
export const MIN_CLAIMABLE_STRATUM_CASES = 5;

export interface EvaluationProvenance {
  datasetSha256?: string;
  queryMode?: "raw_question";
  datasetVersion: string;
  corpusVersion: string;
  split: "dev" | "test" | "all";
  embeddingModel: string;
  embeddingSpaceId: string;
  rerankModel: string;
  generationModel: string;
  judgeModel: string | null;
  answerPromptVersion: string;
  judgePromptVersion: string | null;
  thresholdVersion: string;
  configVersion: string;
  runCount: number;
  date: string;
  synthetic: true;
}

const manualInspectionSchema = z.object({
  inspector: z.string().min(1),
  inspectedAt: z.string().min(1),
  items: z.array(
    z.object({
      caseId: z.string(),
      strategy: z.string(),
      judgeScore: z.number(),
      humanAgrees: z.boolean().nullable(),
      note: z.string().optional(),
    })
  ),
});

export type ManualInspection = z.infer<typeof manualInspectionSchema>;

export interface ManualInspectionStatus {
  complete: boolean;
  inspected: number;
  agreementRate: number | null;
}

export function readManualInspection(input: unknown): ManualInspectionStatus {
  const parsed = manualInspectionSchema.safeParse(input);
  if (!parsed.success) return { complete: false, inspected: 0, agreementRate: null };
  const decided = parsed.data.items.filter((item) => item.humanAgrees !== null);
  return {
    complete: decided.length >= MANUAL_INSPECTION_MINIMUM,
    inspected: decided.length,
    agreementRate: decided.length === 0 ? null : decided.filter((item) => item.humanAgrees).length / decided.length,
  };
}

export type EvidenceSource = "recorded" | "reconstructed_verified" | "reconstruction_mismatch" | "unavailable";

export interface InspectionEvidence {
  blocks: EvidenceBlock[];
  source: EvidenceSource;
}

export interface ManualInspectionTemplateOptions {
  sampleSize?: number;
  /** Questions by caseId, for results recorded before questions were stored. */
  questions?: ReadonlyMap<string, string>;
  /** Evidence by `${strategy}:${caseId}`, for results recorded before evidence was stored. */
  evidence?: ReadonlyMap<string, InspectionEvidence>;
}

export function inspectionKey(strategy: string, caseId: string): string {
  return `${strategy}:${caseId}`;
}

function hashOrder<T extends { strategy: string; caseId: string }>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: createHash("sha256").update(inspectionKey(item.strategy, item.caseId)).digest("hex") }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ item }) => item);
}

/** Alternates strategies so a sample is not dominated by one configuration. */
function interleaveStrategies<T extends { strategy: string }>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.strategy, [...(groups.get(item.strategy) ?? []), item]);
  const queues = [...groups.values()];
  const result: T[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined) result.push(next);
    }
  }
  return result;
}

/**
 * Stratified, deterministic sample of judged cases for the Master's manual review: judged cases
 * below a full score are always included (up to half the sample), the rest are full-score cases
 * spread across strategies. Each item carries the question and the exact evidence the answer used.
 */
export function manualInspectionTemplate(runs: readonly EvaluationRun[], options: ManualInspectionTemplateOptions = {}) {
  const sampleSize = options.sampleSize ?? MANUAL_INSPECTION_MINIMUM;
  const judged = runs.flatMap((run) =>
    run.results.flatMap((result) =>
      result.status === "completed" && result.faithfulness !== undefined ? [{ strategy: run.strategy, caseId: result.caseId, result, judgeScore: result.faithfulness }] : []
    )
  );
  const below = hashOrder(judged.filter((item) => item.judgeScore < 1)).sort((left, right) => left.judgeScore - right.judgeScore);
  const full = interleaveStrategies(hashOrder(judged.filter((item) => item.judgeScore >= 1)));
  const lowQuota = Math.min(below.length, Math.ceil(sampleSize / 2));
  const sample = [...below.slice(0, lowQuota), ...full.slice(0, sampleSize - lowQuota)];

  const items = sample.map(({ strategy, caseId, result, judgeScore }) => {
    const recorded = result.evidence;
    const evidence: InspectionEvidence = recorded
      ? { blocks: recorded, source: "recorded" }
      : options.evidence?.get(inspectionKey(strategy, caseId)) ?? { blocks: [], source: "unavailable" };
    return {
      caseId,
      strategy,
      question: result.question ?? options.questions?.get(caseId) ?? "",
      answer: result.answer ?? "",
      evidence: evidence.blocks,
      evidenceSource: evidence.source,
      judgeScore,
      unsupportedClaims: result.unsupportedClaims ?? [],
      humanAgrees: null as boolean | null,
      note: "",
    };
  });
  return {
    inspector: "",
    inspectedAt: "",
    instructions:
      "For each item, read the question, the answer and the evidence. Set humanAgrees to true when judgeScore and unsupportedClaims correctly describe which answer claims the evidence supports, false otherwise, and explain disagreements in note.",
    items,
  };
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value));
}

function row(label: string, summary: SplitSummary, inspection: ManualInspectionStatus): string {
  const degraded = summary.degradedCases ?? 0;
  const faithfulness = summary.faithfulness === null ? "n/a" : inspection.complete ? formatRate(summary.faithfulness) : `${formatRate(summary.faithfulness)} (pending manual inspection)`;
  return `| ${label}${degraded > 0 ? ` (degraded ${degraded})` : ""} | ${summary.answerableCases} | ${summary.abstainCases} | ${formatRate(summary.recallAt5)} | ${formatRate(summary.mrr)} | ${formatRate(summary.citationAccuracy)} | ${faithfulness} | ${formatRate(summary.abstentionAccuracy)} | ${formatRate(summary.falseAbstentionRate)} | ${formatMs(summary.latencyP50Ms)} | ${formatMs(summary.latencyP95Ms)} |`;
}

const SCORE_HEADER = [
  "| Configuration | Answerable n | Abstain n | Recall@5 | MRR | Citation accuracy | Faithfulness | Abstention accuracy | False abstention | Total P50 ms (generation + Judge) | Total P95 ms (generation + Judge) |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];
function scopeResults(run: EvaluationRun, split: EvaluationProvenance["split"]): CaseResult[] {
  return run.results.filter((result) => split === "all" || result.split === split);
}
function renderImprovement(runs: readonly EvaluationRun[], split: EvaluationProvenance["split"], inspection: ManualInspectionStatus): string[] {
  const lines = ["", "### Improvement — hand_authored only", ""];
  const baseline = runs[0];
  if (!baseline || runs.length < 2) return [...lines, "No configuration pair available."];
  const tags = [...new Set(runs.flatMap((run) => scopeResults(run, split).filter((result) => result.origin === "hand_authored").flatMap((result) => result.tags ?? [])))].sort();
  for (const run of runs.slice(1)) {
    if (run.status !== "completed" || baseline.status !== "completed") {
      lines.push(`- ${run.strategy}: comparison refused — incomplete run.`);
      continue;
    }
    if (!baseline.datasetVersion || !baseline.datasetSha256 || baseline.datasetVersion !== run.datasetVersion || baseline.datasetSha256 !== run.datasetSha256) {
      lines.push(`- ${run.strategy}: comparison refused — missing or different dataset version/content hash.`);
      continue;
    }
    for (const tag of [undefined, ...tags]) {
      const select = (candidate: EvaluationRun) => scopeResults(candidate, split).filter((result) => result.origin === "hand_authored" && (tag === undefined || result.tags?.includes(tag)));
      const before = select(baseline);
      const after = select(run);
      const label = `${run.strategy} vs ${baseline.strategy} / hand_authored${tag ? ` / tag:${tag}` : ""}`;
      if (before.length === 0 || after.length === 0) { lines.push(`- ${label}: no human stratum; n=0.`); continue; }
      if (before.length !== after.length || before.some((item) => !after.some((other) => item.caseId === other.caseId && item.expectedKind === other.expectedKind))) {
        lines.push(`- ${label}: comparison refused — case population differs.`); continue;
      }
      const metrics = ["recallAt5", "mrr", "citationAccuracy", "faithfulness", "abstentionAccuracy", "falseAbstentionRate"] as const;
      const beforeSummary = summarize(before);
      const afterSummary = summarize(after);
      for (const metric of metrics) {
        const sampleSize = (results: CaseResult[]) => results.filter((result) => result.status === "completed" && (
          metric === "abstentionAccuracy" ? result.expectedKind === "abstain" :
          metric === "citationAccuracy" ? result.expectedKind === "answerable" && !result.abstained :
          metric === "faithfulness" ? result.expectedKind === "answerable" && !result.abstained && result.faithfulness !== undefined :
          result.expectedKind === "answerable"
        )).length;
        const beforeN = sampleSize(before);
        const afterN = sampleSize(after);
        const n = Math.min(beforeN, afterN);
        const prefix = `- ${label} / ${metric} (n=${beforeN}/${afterN})`;
        if (n < MIN_CLAIMABLE_STRATUM_CASES || beforeSummary[metric] === null || afterSummary[metric] === null) { lines.push(`${prefix}: insufficient sample.`); continue; }
        if (metric === "faithfulness" && !inspection.complete) { lines.push(`${prefix}: pending manual inspection.`); continue; }
        const delta = afterSummary[metric]! - beforeSummary[metric]!;
        const direction = metric === "falseAbstentionRate" ? -delta : delta;
        const verdict = delta === 0 ? "no improvement" : Math.abs(delta) + Number.EPSILON < 1 / n ? "within one-case resolution" : direction > 0 ? "improved" : "regressed";
        lines.push(`${prefix}: ${verdict}; delta=${delta.toFixed(3)}, resolution=${(1 / n).toFixed(3)}.`);
      }
    }
  }
  return lines;
}
function renderStageLatency(runs: readonly EvaluationRun[], split: EvaluationProvenance["split"]): string[] {
  const lines = ["", "### Stage latency", "", isPublishable(runs) ? "Completed runs: stage measurements may be published." : "Not publishable: incomplete runs.", "",
    "| Configuration / stage | Completed n | Failed | Not run | Unmeasured | P50 ms | P95 ms |",
    "|---|---|---|---|---|---|---|"];
  for (const run of runs) {
    const results = scopeResults(run, split);
    const summary = summarize(results);
    for (const stage of EVALUATION_STAGES) {
      const timing = summary.stageLatency![stage];
      const state = timing.unmeasured === results.length ? "unmeasured" : timing.completed === 0 && timing.failed === 0 ? "not run" : "";
      lines.push(`| ${run.strategy} / ${stage}${state ? ` (${state})` : ""} | ${timing.completed} | ${timing.failed} | ${timing.notRun} | ${timing.unmeasured} | ${formatMs(timing.p50Ms)} | ${formatMs(timing.p95Ms)} |`);
    }
    const n = results.filter((result) => result.status === "completed").flatMap((result) => retrievalLatency(result.stageLatency)).length;
    lines.push(`| ${run.strategy} / retrieval total | ${n} | — | — | — | ${formatMs(summary.retrievalP50Ms ?? null)} | ${formatMs(summary.retrievalP95Ms ?? null)} |`);
  }
  lines.push("", "Rerank P50/P95 use completed rerank calls only; failed rerank waiting time remains in retrieval total. Embedding/recall failures are excluded from retrieval total. Unmeasured and not-run stages are never inferred as zero.",
    "Sequential runs include connection cold starts and local network conditions; these are evaluation-environment timings, not production latency.");
  return lines;
}

export function renderComparisonMarkdown(
  runs: readonly EvaluationRun[],
  provenance: EvaluationProvenance,
  inspection: ManualInspectionStatus
): string {
  const split = provenance.split;
  const incomplete = runs.filter((run) => run.status === "incomplete");
  const header = [
    `## Retrieval comparison — ${provenance.datasetVersion} (${split} split)`,
    "",
    incomplete.length > 0
      ? `> **Not publishable:** ${incomplete.map((run) => `${run.strategy} has ${run.failedCases.length} failed case(s)`).join("; ")}. Incomplete runs are never scored on the successful subset.`
      : "> All cases completed.",
    "",
    ...renderImprovement(runs, split, inspection),
    "",
    "### Origin strata",
    "",
    "template scores are diagnostic only. hand_authored records the actual author; unclassified is never inferred to mean human.",
    ...SCORE_HEADER,
    ...runs.flatMap((run) => {
      const strata = summarizeStrata(scopeResults(run, split));
      return ["hand_authored", "template", "unclassified"].map((origin) => row(`${run.strategy} / origin:${origin}`, strata[`origin:${origin}`], inspection));
    }),
    "",
    `Authors: ${JSON.stringify(runs.map((run) => ({ strategy: run.strategy, authors: Object.fromEntries([...new Set(scopeResults(run, split).filter((result) => result.origin === "hand_authored").map((result) => result.authoredBy ?? "unrecorded"))].map((author) => [author, scopeResults(run, split).filter((result) => result.origin === "hand_authored" && (result.authoredBy ?? "unrecorded") === author).length])) })))}`,
    "",
    "### Tag strata",
    "",
    "Tag strata overlap; their sample counts do not sum to the total.",
    ...SCORE_HEADER,
    ...runs.flatMap((run) => Object.entries(summarizeStrata(scopeResults(run, split))).filter(([key]) => key.startsWith("tag:")).map(([key, summary]) => row(`${run.strategy} / ${key}`, summary, inspection))),
    "",
    "### Mixed aggregate — not a basis for improvement",
    "",
    ...SCORE_HEADER,
    ...runs.map((run) => row(run.strategy, summarize(scopeResults(run, split)), inspection)),
    ...renderStageLatency(runs, split),
  ];
  const definitions = [
    "",
    "**Definitions.** Recall@5 and MRR rank unique sources before the evidence threshold (answerable cases).",
    "Citation accuracy is the share of answer citations that resolve to returned evidence and belong to a relevant source (answered, answerable cases).",
    "Faithfulness is model-assisted (share of supported claims) and is published only with a manual inspection of at least 10 cases.",
    "Abstention accuracy counts abstain cases where the system declined; false abstention counts answerable cases where it declined.",
  ];
  const provenanceBlock = [
    "",
    "**Provenance.**",
    `dataset SHA-256 ${provenance.datasetSha256 ?? "unrecorded"}; queryMode ${provenance.queryMode ?? "unrecorded"};`,
    `dataset ${provenance.datasetVersion}, corpus ${provenance.corpusVersion} (**synthetic**), split ${split};`,
    `embedding ${provenance.embeddingModel} (${provenance.embeddingSpaceId}), rerank ${provenance.rerankModel}, generation ${provenance.generationModel}, judge ${provenance.judgeModel ?? "none"};`,
    `prompts ${provenance.answerPromptVersion}${provenance.judgePromptVersion ? ` / ${provenance.judgePromptVersion}` : ""}; threshold ${provenance.thresholdVersion}; config ${provenance.configVersion};`,
    `runs ${provenance.runCount}; date ${provenance.date};`,
    `manual inspection ${inspection.inspected}/${MANUAL_INSPECTION_MINIMUM}${inspection.agreementRate === null ? "" : `, judge agreement ${formatRate(inspection.agreementRate)}`}.`,
    "Figures show method efficacy on a synthetic, controlled dataset, not production performance.",
    "Evaluation sends the raw_question unchanged with default topK and no source-type filter. Online kb_search uses a model-assembled query and parameters, with a different answer prompt. These scores are not online end-to-end quality and do not measure query construction or tool parameter selection.",
    "cross_lingual scores use untranslated original questions against English sources; they do not establish online multilingual quality. Offline scores imply no fixed direction of online bias.",
  ];
  return [...header, ...definitions, ...provenanceBlock, ""].join("\n");
}

export function isPublishable(runs: readonly EvaluationRun[]): boolean {
  return runs.every((run) => run.status === "completed");
}

export type { CaseResult };
