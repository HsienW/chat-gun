/**
 * Calibrates evidence thresholds from the dev split of an evaluation run (T5).
 *
 * Usage (from backend/):
 *   npx tsx scripts/knowledge/calibrate-thresholds.ts <results-dir> <threshold-version>
 *
 * Only dev cases are read. The output is versioned configuration; the test split is evaluated
 * afterwards with a fresh live run, never consulted here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { calibrateThreshold, calibrationPoints } from "../../src/knowledge/evaluation/calibration.js";
import type { EvaluationRun } from "../../src/knowledge/evaluation/runner.js";

async function readRun(directory: string, strategy: string): Promise<EvaluationRun> {
  return JSON.parse(await readFile(join(directory, `run-${strategy}.json`), "utf8")) as EvaluationRun;
}

async function main(): Promise<void> {
  const [resultsArgument, thresholdVersion] = process.argv.slice(2);
  if (!resultsArgument || !thresholdVersion) throw new Error("Usage: calibrate-thresholds <results-dir> <threshold-version>");
  const resultsDirectory = resolve(resultsArgument);
  const provenance = JSON.parse(await readFile(join(resultsDirectory, "provenance.json"), "utf8")) as Record<string, unknown>;
  const vectorRun = await readRun(resultsDirectory, "vector_only");
  const rerankRun = await readRun(resultsDirectory, "vector_rerank");
  for (const run of [vectorRun, rerankRun]) {
    if (run.status !== "completed") throw new Error(`Run ${run.strategy} is incomplete; calibration requires a complete run`);
  }
  const dev = (run: EvaluationRun) => run.results.filter((result) => result.split === "dev");
  const vector = calibrateThreshold(calibrationPoints(dev(vectorRun), "similarity"));
  const rerank = calibrateThreshold(calibrationPoints(dev(rerankRun), "rerankScore"));
  const output = {
    thresholdVersion,
    calibratedAt: new Date().toISOString().slice(0, 10),
    method:
      "Dev split only. Threshold on the top candidate score maximizing balanced accuracy (answerable passes, abstain blocks); ties broken by the largest margin from any observed score.",
    source: {
      results: basename(resultsDirectory),
      datasetVersion: provenance.datasetVersion,
      corpusVersion: provenance.corpusVersion,
      embeddingSpaceId: provenance.embeddingSpaceId,
      rerankModel: provenance.rerankModel,
      split: "dev",
    },
    vectorOnly: { score: "cosine similarity", ...vector },
    vectorRerank: { score: "qwen3-rerank relevance_score", ...rerank },
  };
  const target = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "knowledge-eval", "thresholds", `${thresholdVersion}.json`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Calibration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
