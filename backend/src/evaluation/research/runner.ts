import type { LoadedResearchDataset, ResearchEvalCase } from "./dataset.js";
import { scoreCase, summarizeRun, type CaseObservation, type CaseScore, type RunSummary } from "./scoring.js";

export const RESEARCH_EVAL_RUNNER_VERSION = "research-eval-runner-v1";

/** What one graph invocation produced; the runner adds identity, status and latency. */
export type AgentTrace = Omit<CaseObservation, "caseId" | "category" | "stub" | "status" | "error" | "latencyMs">;

export type ResearchAgent = (item: ResearchEvalCase, signal: AbortSignal) => Promise<AgentTrace>;

export interface ResearchRunOptions {
  /** Label of the source ranking strategy under test, e.g. "rule" or "rerank". */
  ranking: string;
  perCaseTimeoutMs?: number;
  caseIds?: readonly string[];
  now?: () => number;
  onCase?: (observation: CaseObservation, index: number, total: number) => void;
}

export interface ResearchRun {
  runnerVersion: typeof RESEARCH_EVAL_RUNNER_VERSION;
  datasetVersion: string;
  datasetSha256: string;
  ranking: string;
  startedAt: string;
  finishedAt: string;
  observations: CaseObservation[];
  scores: CaseScore[];
  summary: RunSummary;
}

const EMPTY_TRACE: AgentTrace = { queries: [], searchResultCount: 0, rankedUrls: [], sources: [], answer: "" };

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function runResearchEvaluation(
  loaded: LoadedResearchDataset,
  agent: ResearchAgent,
  options: ResearchRunOptions
): Promise<ResearchRun> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.perCaseTimeoutMs ?? 180_000;
  const selected = options.caseIds
    ? loaded.dataset.cases.filter((item) => options.caseIds!.includes(item.caseId))
    : loaded.dataset.cases;
  const startedAt = new Date(now()).toISOString();
  const observations: CaseObservation[] = [];

  for (const [index, item] of selected.entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("RESEARCH_EVAL_CASE_TIMEOUT")), timeoutMs);
    const started = now();
    let observation: CaseObservation;
    try {
      const trace = await agent(item, controller.signal);
      observation = { caseId: item.caseId, category: item.category, stub: item.stub, status: "completed", latencyMs: now() - started, ...trace };
    } catch (error) {
      observation = {
        caseId: item.caseId,
        category: item.category,
        stub: item.stub,
        status: controller.signal.aborted ? "timeout" : "failed",
        error: errorMessage(error),
        latencyMs: now() - started,
        ...EMPTY_TRACE,
      };
    } finally {
      clearTimeout(timer);
    }
    observations.push(observation);
    options.onCase?.(observation, index, selected.length);
  }

  const scores = observations.map(scoreCase);
  return {
    runnerVersion: RESEARCH_EVAL_RUNNER_VERSION,
    datasetVersion: loaded.dataset.datasetVersion,
    datasetSha256: loaded.sha256,
    ranking: options.ranking,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    observations,
    scores,
    summary: summarizeRun(observations, scores),
  };
}
