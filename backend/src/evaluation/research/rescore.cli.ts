/**
 * Re-applies the current scorer to recorded observations and re-renders the report.
 *
 * Usage (from backend/):
 *   npm run research:rescore -- data/research-eval/results/<label>
 *
 * Observations (answers, sources, latency) are never modified; only scores, summaries and
 * report.md are recomputed, so a scorer fix does not require another live run.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderReport, type ResearchEvalProvenance } from "./report.js";
import type { ResearchRun } from "./runner.js";
import { scoreCase, summarizeRun } from "./scoring.js";

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every manual-inspection-<ranking>.json in the results directory, in name order. */
export async function readManualInspections(dir: string): Promise<unknown[]> {
  const files = (await readdir(dir)).filter((name) => /^manual-inspection-.+\.json$/u.test(name)).sort();
  return Promise.all(files.map((name) => readJson(join(dir, name))));
}

export async function rescoreResultsDir(dir: string): Promise<ResearchRun[]> {
  const runs: ResearchRun[] = [];
  for (const file of (await readdir(dir)).filter((name) => /^run-.+\.json$/u.test(name)).sort()) {
    const run = JSON.parse(await readFile(join(dir, file), "utf8")) as ResearchRun;
    const scores = run.observations.map(scoreCase);
    const rescored = { ...run, scores, summary: summarizeRun(run.observations, scores) };
    await writeFile(join(dir, file), `${JSON.stringify(rescored, null, 2)}\n`);
    runs.push(rescored);
  }
  const provenance = (await readJson(join(dir, "provenance.json"))) as ResearchEvalProvenance | undefined;
  if (!provenance || runs.length === 0) throw new Error(`RESEARCH_EVAL_RESULTS_INCOMPLETE: ${dir}`);
  await writeFile(join(dir, "report.md"), renderReport(runs, provenance, await readManualInspections(dir)));
  return runs;
}

// Run only as a CLI: the live evaluation imports readManualInspections from this module.
const target = process.argv[2];
if (target && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runs = await rescoreResultsDir(resolve(target));
  process.stdout.write(`rescored ${runs.map((run) => `${run.ranking} (${run.observations.length} cases)`).join(", ")}\n`);
}
