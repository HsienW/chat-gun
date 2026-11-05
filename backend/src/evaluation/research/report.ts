import type { ResearchRun } from "./runner.js";
import type { LatencySummary, Rate } from "./scoring.js";

export interface ResearchEvalProvenance {
  datasetVersion: string;
  datasetSha256: string;
  runnerVersion: string;
  rankings: string[];
  llmProvider: string;
  plannerModel: string;
  synthesisModel: string;
  searchProvider: string;
  rerankModel: string | null;
  caseCount: number;
  runCount: number;
  date: string;
  commit: string;
  notes: string[];
}

function pct(value: Rate): string {
  return value.rate === null ? "n/a (0)" : `${(value.rate * 100).toFixed(1)}% (${value.passed}/${value.n})`;
}

function seconds(value: number | null): string {
  return value === null ? "n/a" : `${(value / 1000).toFixed(1)}s`;
}

function latency(value: LatencySummary | undefined): string {
  return value ? `${seconds(value.p50Ms)} / ${seconds(value.p90Ms)} (n=${value.n})` : "n/a";
}

export const METRIC_DEFINITIONS = [
  "- **Citation verification pass rate**: among completed answerable answers that cite at least once, the share whose every `[n]` marker resolves to an extracted source marked `usable` (fetched without error and ≥ 200 characters) and whose every raw URL belongs to a usable source. Answers that cite nothing are counted separately, not as passes.",
  "- **Citation precision**: across those answers, cited items (markers + URLs) that resolve to a usable source / all cited items.",
  "- **No-source refusal rate**: among no_source cases (search stubbed empty, or every fetch stubbed to fail), the share where the run had zero usable sources, the answer states the limitation (keyword detector, see `scoring.ts`), and the answer cites no `[n]` evidence marker. Raw URLs are listed, not failed; whether the answer asserts unsupported facts is judged per case in `manual-inspection.json`.",
  "- **Clarify rate**: clarify cases routed by the planner to `answerMode=clarify`.",
  "- **Fetched usable ratio**: usable sources / fetched sources over answerable cases (the top-N sources the ranking selected).",
  "- **Latency**: wall-clock time of one graph invocation, sequential execution, nearest-rank P50 / P90.",
];

export function renderReport(runs: readonly ResearchRun[], provenance: ResearchEvalProvenance): string {
  const lines: string[] = [
    `# Deep Researcher evaluation — ${provenance.datasetVersion}`,
    "",
    `Date: ${provenance.date} · Cases: ${provenance.caseCount} · Runs: ${provenance.runCount} · LLM: ${provenance.llmProvider}/${provenance.plannerModel} · Search: ${provenance.searchProvider}${provenance.rerankModel ? ` · Rerank: ${provenance.rerankModel}` : ""} · Commit: ${provenance.commit}`,
    "",
    "Small sample, single run per arm: treat differences of one or two cases as noise.",
    "",
    "## Metric definitions",
    "",
    ...METRIC_DEFINITIONS,
    "",
    "## Summary",
    "",
    `| Metric | ${runs.map((run) => run.ranking).join(" | ")} |`,
    `|---|${runs.map(() => "---").join("|")}|`,
  ];
  const row = (label: string, value: (run: ResearchRun) => string) =>
    lines.push(`| ${label} | ${runs.map(value).join(" | ")} |`);
  row("Completed / cases", (run) => `${run.summary.completed}/${run.summary.cases}`);
  row("Citation verification pass rate", (run) => pct(run.summary.citation.answerPassRate));
  row("Citation precision", (run) => pct(run.summary.citation.citationPrecision));
  row("Answerable answers with usable sources but no citation", (run) => String(run.summary.citation.answerableWithoutCitation));
  row("Answerable cases with zero usable sources", (run) => String(run.summary.citation.answerableWithZeroUsableSources));
  row("No-source refusal rate", (run) => pct(run.summary.refusal));
  row("No-source stub effective (0 usable)", (run) => `${run.summary.refusal.stubEffective}/${run.summary.refusal.n}`);
  row("Clarify rate", (run) => pct(run.summary.clarify));
  row("Fetched usable ratio (answerable)", (run) => pct(run.summary.fetchedUsable));
  row("Latency P50 / P90 — all", (run) => latency(run.summary.latency.all));
  row("Latency P50 / P90 — answerable", (run) => latency(run.summary.latency.answerable));
  row("Latency P50 / P90 — no_source", (run) => latency(run.summary.latency.no_source));
  row("Latency P50 / P90 — clarify", (run) => latency(run.summary.latency.clarify));

  for (const run of runs) {
    lines.push("", `## Cases — ${run.ranking}`, "", "| Case | Status | Mode | Latency | Usable/Fetched | Cited | Unresolved | Result |", "|---|---|---|---|---|---|---|---|");
    for (const observation of run.observations) {
      const score = run.scores.find((candidate) => candidate.caseId === observation.caseId)!;
      const usable = observation.sources.filter((source) => source.usable).length;
      const result =
        observation.category === "no_source"
          ? score.refusal?.pass ? "refusal pass" : "refusal fail"
          : observation.category === "clarify"
            ? score.clarifyPass ? "clarify pass" : "clarify fail"
            : score.citation.pass === null ? "no citation" : score.citation.pass ? "citation pass" : "citation fail";
      lines.push(
        `| ${observation.caseId} | ${observation.status} | ${observation.answerMode ?? "-"} | ${seconds(observation.latencyMs)} | ${usable}/${observation.sources.length} | ${score.citation.citedCount} | ${score.citation.unresolved.join(" ") || "-"} | ${result} |`
      );
    }
    lines.push("", `Routing: ${Object.entries(run.summary.routing).map(([key, count]) => `${key}=${count}`).join(", ")}`);
  }

  if (provenance.notes.length) lines.push("", "## Notes", "", ...provenance.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
