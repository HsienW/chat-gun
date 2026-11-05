import { z } from "zod";

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
  /** Short commit each ranking arm ran at. */
  commits: Record<string, string>;
  notes: string[];
}

const manualInspectionSchema = z.object({
  inspector: z.string(),
  run: z.string(),
  criterion: z.string(),
  items: z.array(z.object({ caseId: z.string(), pass: z.boolean(), unsupportedClaims: z.array(z.string()).default([]) })),
});

function renderManualInspection(input: unknown): string[] {
  const parsed = manualInspectionSchema.safeParse(input);
  if (!parsed.success) return [];
  const { items } = parsed.data;
  return [
    "",
    `## Manual inspection (no_source) — ${parsed.data.run}`,
    "",
    `Inspector: ${parsed.data.inspector}`,
    "",
    `Criterion: ${parsed.data.criterion}`,
    "",
    `No unsupported claims: ${items.filter((item) => item.pass).length}/${items.length}`,
    "",
    "| Case | Pass | Unsupported claims |",
    "|---|---|---|",
    ...items.map((item) => `| ${item.caseId} | ${item.pass ? "yes" : "no"} | ${item.unsupportedClaims.join("; ") || "-"} |`),
  ];
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
  "- **Citation guard (guard arms only)**: answers are scored after the guard; \"answers modified\" counts research answers where the guard removed at least one marker or URL, i.e. answers that would have failed citation verification without the deterministic step.",
  "- **Rerank (rerank arm only)**: one rerank call per case that reaches rankSources; call latency is measured around the provider call; a changed top-N means at least one fetched source differs from the rule-order top-N on the same deduped candidates.",
];

export function renderReport(
  runs: readonly ResearchRun[],
  provenance: ResearchEvalProvenance,
  manualInspections: readonly unknown[] = []
): string {
  const lines: string[] = [
    `# Deep Researcher evaluation — ${provenance.datasetVersion}`,
    "",
    `Date: ${provenance.date} · Cases: ${provenance.caseCount} · Runs: ${provenance.runCount} · LLM: ${provenance.llmProvider}/${provenance.plannerModel} · Search: ${provenance.searchProvider}${provenance.rerankModel ? ` · Rerank: ${provenance.rerankModel}` : ""} · Commits: ${Object.entries(provenance.commits).map(([ranking, commit]) => `${ranking}@${commit}`).join(", ")}`,
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
  if (runs.some((run) => run.summary.rerank)) {
    row("Rerank calls (failed → rule fallback)", (run) => (run.summary.rerank ? `${run.summary.rerank.calls} (${run.summary.rerank.failed})` : "-"));
    row("Rerank call latency P50 / P90", (run) => (run.summary.rerank ? latency(run.summary.rerank.latency) : "-"));
    row("Cases where rerank changed the fetched top-N", (run) => (run.summary.rerank ? pct(run.summary.rerank.casesWithChangedSelection) : "-"));
  }
  if (runs.some((run) => run.summary.citationGuard)) {
    row("Citation guard: research answers modified", (run) => (run.summary.citationGuard ? pct(run.summary.citationGuard.answersModified) : "-"));
    row("Citation guard: markers / URLs removed", (run) => (run.summary.citationGuard ? `${run.summary.citationGuard.removedMarkers} / ${run.summary.citationGuard.removedUrls}` : "-"));
  }

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

  for (const inspection of manualInspections) lines.push(...renderManualInspection(inspection));
  if (provenance.notes.length) lines.push("", "## Notes", "", ...provenance.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
