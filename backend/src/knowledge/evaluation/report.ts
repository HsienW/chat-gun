import { createHash } from "node:crypto";

import { z } from "zod";

import type { CaseResult, EvaluationRun, EvidenceBlock, SplitSummary } from "./runner.js";

export const MANUAL_INSPECTION_MINIMUM = 10;

export interface EvaluationProvenance {
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

function row(label: string, run: EvaluationRun, summary: SplitSummary, inspection: ManualInspectionStatus): string {
  const degraded = run.results.filter((result) => result.status === "completed" && result.retrievalMode === "vector_only_degraded").length;
  const faithfulness = summary.faithfulness === null ? "n/a" : inspection.complete ? formatRate(summary.faithfulness) : `${formatRate(summary.faithfulness)} (pending manual inspection)`;
  return `| ${label}${degraded > 0 ? ` (degraded ${degraded})` : ""} | ${formatRate(summary.recallAt5)} | ${formatRate(summary.mrr)} | ${formatRate(summary.citationAccuracy)} | ${faithfulness} | ${formatRate(summary.abstentionAccuracy)} | ${formatRate(summary.falseAbstentionRate)} | ${formatMs(summary.latencyP50Ms)} | ${formatMs(summary.latencyP95Ms)} |`;
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
    "| Configuration | Recall@5 | MRR | Citation accuracy | Faithfulness | Abstention accuracy | False abstention | P50 ms | P95 ms |",
    "|---|---|---|---|---|---|---|---|---|",
    ...runs.map((run) => row(run.strategy, run, run.summary[split], inspection)),
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
    `dataset ${provenance.datasetVersion}, corpus ${provenance.corpusVersion} (**synthetic**), split ${split};`,
    `embedding ${provenance.embeddingModel} (${provenance.embeddingSpaceId}), rerank ${provenance.rerankModel}, generation ${provenance.generationModel}, judge ${provenance.judgeModel ?? "none"};`,
    `prompts ${provenance.answerPromptVersion}${provenance.judgePromptVersion ? ` / ${provenance.judgePromptVersion}` : ""}; threshold ${provenance.thresholdVersion}; config ${provenance.configVersion};`,
    `runs ${provenance.runCount}; date ${provenance.date};`,
    `manual inspection ${inspection.inspected}/${MANUAL_INSPECTION_MINIMUM}${inspection.agreementRate === null ? "" : `, judge agreement ${formatRate(inspection.agreementRate)}`}.`,
    "Figures show method efficacy on a synthetic, controlled dataset, not production performance.",
  ];
  return [...header, ...definitions, ...provenanceBlock, ""].join("\n");
}

export function isPublishable(runs: readonly EvaluationRun[]): boolean {
  return runs.every((run) => run.status === "completed");
}

export type { CaseResult };
