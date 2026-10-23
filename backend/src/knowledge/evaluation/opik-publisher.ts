import { getAgentRuntimeConfig } from "../../platform/runtime-config.js";
import type { EvalCase } from "./eval-case.js";
import type { EvaluationProvenance } from "./report.js";
import type { CaseResult, EvaluationRun } from "./runner.js";

export type OpikPublication =
  | { status: "published"; datasetName: string; experiments: { strategy: string; experimentId: string; experimentName: string }[] }
  | { status: "skipped"; reason: "disabled" | "redaction_required" | "missing_api_key" | "incomplete_run" };

const SCORE_KEYS = ["recall_at_5", "mrr", "citation_accuracy", "faithfulness", "abstention_correct"] as const;

type DatasetItem = {
  caseId: string;
  datasetVersion: string;
  split: string;
  question: string;
  expectedKind: string;
  relevantSourceIds: string[];
};

/** Flattens a case result into the task output that Opik scores; absent metrics stay absent. */
export function caseScores(result: CaseResult): Record<string, unknown> {
  if (result.status !== "completed") return { status: "failed", errorCode: result.errorCode };
  return {
    status: "completed",
    kbOutcome: result.kbOutcome,
    retrievalMode: result.retrievalMode,
    abstained: result.abstained,
    answer: result.answer ?? "",
    rankedSourceIds: result.rankedSourceIds,
    latencyMs: result.latencyMs,
    ...(result.recallAt5 !== undefined ? { recall_at_5: result.recallAt5 } : {}),
    ...(result.reciprocalRank !== undefined ? { mrr: result.reciprocalRank } : {}),
    ...(result.citationAccuracy !== undefined ? { citation_accuracy: result.citationAccuracy } : {}),
    ...(result.faithfulness !== undefined ? { faithfulness: result.faithfulness } : {}),
    ...(result.expectedKind === "abstain" ? { abstention_correct: result.abstained ? 1 : 0 } : {}),
  };
}

/**
 * Mirrors locally computed scores into an Opik experiment. The task returns the precomputed case
 * result, so Opik shows exactly the published numbers without re-running any model.
 */
export async function publishEvaluationToOpik(
  runs: readonly EvaluationRun[],
  cases: readonly EvalCase[],
  provenance: EvaluationProvenance
): Promise<OpikPublication> {
  if (runs.some((run) => run.status !== "completed")) return { status: "skipped", reason: "incomplete_run" };
  const config = getAgentRuntimeConfig();
  if (!config.opikEnabled) return { status: "skipped", reason: "disabled" };
  if (!config.opikRedactEnabled) return { status: "skipped", reason: "redaction_required" };
  if (!config.opikApiKey) return { status: "skipped", reason: "missing_api_key" };

  const sdk = await import("opik");
  const client = new sdk.Opik({
    apiKey: config.opikApiKey,
    apiUrl: config.opikHost,
    projectName: config.opikProjectName,
    ...(config.opikWorkspace ? { workspaceName: config.opikWorkspace } : {}),
  });
  const datasetName = `chat-gun-${provenance.datasetVersion}`;
  const dataset = await client.getOrCreateDataset<DatasetItem>(
    datasetName,
    `Synthetic X42 retrieval evaluation set ${provenance.datasetVersion} over corpus ${provenance.corpusVersion}`
  );
  const existing = new Set((await dataset.getItems()).map((item) => item.caseId));
  const missing = cases
    .filter((item) => !existing.has(item.caseId))
    .map((item) => ({
      caseId: item.caseId,
      datasetVersion: item.datasetVersion,
      split: item.split,
      question: item.input.question,
      expectedKind: item.expected.kind,
      relevantSourceIds: item.expected.kind === "answerable" ? item.expected.relevantSourceIds : [],
    }));
  if (missing.length > 0) await dataset.insert(missing);

  class PrecomputedScore extends sdk.BaseMetric {
    readonly validationSchema = sdk.z.object({}).passthrough();

    constructor(private readonly key: (typeof SCORE_KEYS)[number]) {
      super(key);
    }

    score(input: unknown) {
      const value = (input as Record<string, unknown>)[this.key];
      return typeof value === "number" ? { name: this.key, value } : [];
    }
  }

  const experiments: { strategy: string; experimentId: string; experimentName: string }[] = [];
  for (const run of runs) {
    const byCase = new Map(run.results.map((result) => [result.caseId, caseScores(result)]));
    const experimentName = `${provenance.datasetVersion}-${run.strategy}-${provenance.date}`;
    const evaluation = await sdk.evaluate<DatasetItem>({
      dataset,
      client,
      experimentName,
      experimentConfig: { ...provenance, strategy: run.strategy },
      task: (item) => byCase.get(item.caseId) ?? { status: "missing" },
      scoringMetrics: SCORE_KEYS.map((key) => new PrecomputedScore(key)),
    });
    experiments.push({ strategy: run.strategy, experimentId: evaluation.experimentId, experimentName });
  }
  await client.flush();
  return { status: "published", datasetName, experiments };
}
