/**
 * Runs the X43 commerce chain evaluation and writes a versioned result set (design §20.7).
 *
 * Usage (from backend/):
 *   npm run commerce:evaluate -- --mode deterministic [--date YYYY-MM-DD]
 *
 * deterministic drives the real shopping_assistant graph over an isolated Postgres
 * (SIDE_EFFECT_INTEGRATION_DATABASE_URL) with scripted routing, request models and
 * policy synthesis. live is refused until the Master provides a model and a knowledge
 * database. Results go to data/commerce-eval/results/<datasetVersion>-<mode>-<date>/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { SHOPPING_ASSISTANT_GRAPH_ID } from "../../agents/shopping-assistant/graph.js";
import { loadRawCorpus, prepareCorpus } from "../../knowledge/corpus.js";
import { getEnv } from "../../platform/env.js";
import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { isChainCase, parseVersionedEvalDataset } from "./chain-case.js";
import { chainResultDirectoryName, isChainRunPublishable, renderChainReportMarkdown, type ChainEvaluationProvenance } from "./chain-report.js";
import { DEFAULT_EXPIRE_TIMEOUT_MS, runDeterministicChainEvaluation } from "./chain-runner.js";
import { CHAIN_SCRIPT_VERSION, SCRIPTED_RETRIEVAL_CONFIG_VERSION } from "./chain-script.js";
import { resolveChainEvaluationPlan } from "./evaluate-options.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA_ROOT = join(BACKEND_ROOT, "data");
const DATASET_FILE = join(DATA_ROOT, "commerce-eval", "chain-eval-v1.json");
const CORPUS_DIRECTORY = join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw");

async function main(): Promise<void> {
  const plan = resolveChainEvaluationPlan(process.argv.slice(2), process.env);
  const raw = JSON.parse(await readFile(DATASET_FILE, "utf8")) as { orderFixtureVersion?: unknown };
  const dataset = parseVersionedEvalDataset(raw);
  if (dataset.rejected.length > 0) {
    throw new Error(`Dataset has rejected cases: ${dataset.rejected.map((item) => `${item.caseId ?? item.index}:${item.code}`).join(", ")}`);
  }
  const cases = dataset.cases.filter(isChainCase);
  const corpus = prepareCorpus(await loadRawCorpus(CORPUS_DIRECTORY)).documents;
  const orderFixture = await loadSyntheticOrderFixture();
  const orderFixtureVersion = typeof raw.orderFixtureVersion === "string" ? raw.orderFixtureVersion : "unknown";

  const pool = new Pool({ connectionString: plan.databaseUrl });
  let run;
  try {
    run = await runDeterministicChainEvaluation({ pool, cases, corpus, orderFixture, datasetVersion: dataset.datasetVersion });
  } finally {
    await pool.end();
  }

  const provenance: ChainEvaluationProvenance = {
    datasetVersion: dataset.datasetVersion,
    corpusVersion: dataset.corpusVersion,
    orderFixtureVersion,
    split: "all",
    mode: plan.mode,
    graphId: SHOPPING_ASSISTANT_GRAPH_ID,
    intentPromptVersion: CHAIN_SCRIPT_VERSION,
    policyPromptVersion: CHAIN_SCRIPT_VERSION,
    embeddingModel: null,
    embeddingSpaceId: null,
    rerankModel: null,
    generationModel: null,
    judgeModel: null,
    thresholdVersion: null,
    configVersion: SCRIPTED_RETRIEVAL_CONFIG_VERSION,
    confirmationTimeoutMs: {
      default: Number(getEnv("TOOL_AUTHORIZATION_CONFIRMATION_TIMEOUT_MS", "900000")),
      expireCases: DEFAULT_EXPIRE_TIMEOUT_MS,
    },
    runCount: 1,
    date: plan.date,
    synthetic: true,
  };
  const outDirectory = join(DATA_ROOT, "commerce-eval", "results", chainResultDirectoryName(dataset.datasetVersion, plan.mode, plan.date));
  await mkdir(outDirectory, { recursive: true });
  await writeFile(join(outDirectory, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(join(outDirectory, "report.md"), renderChainReportMarkdown(run, provenance));
  await writeFile(join(outDirectory, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const publishable = isChainRunPublishable(run);
  process.stdout.write(
    `${JSON.stringify(
      {
        outDirectory,
        status: run.status,
        publishable,
        failedCases: run.failedCases,
        notPassed: run.results.filter((result) => result.status === "completed" && !result.passed).map((result) => result.caseId),
        test: run.summary.test,
        dev: run.summary.dev,
      },
      null,
      2
    )}\n`
  );
  if (!publishable) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
  process.stderr.write(`Commerce chain evaluation failed: ${code}${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
