/**
 * Runs the X42 retrieval evaluation and writes a versioned, reproducible result set.
 *
 * Usage (from backend/):
 *   npm run knowledge:evaluate -- [--strategies vector_only,vector_rerank] [--no-judge] [--opik] [--out <dir>]
 *
 * Requires KNOWLEDGE_DATABASE_URL and QWEN_API_KEY (resolved through the SecretBroker) and an
 * ingested corpus. vector_rerank is refused unless KB_RERANK_URL is configured, so a degraded run is
 * never reported under the rerank label.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { llmGateway } from "../../platform/llm-gateway.js";
import { readKnowledgeConfig } from "../config.js";
import {
  createKnowledgePool,
  createKnowledgeSecretBroker,
  createSystemExecutionContext,
  KNOWLEDGE_MODEL_SECRET,
} from "../connection.js";
import { HttpKnowledgeModelGateway } from "../model-gateway.js";
import { PgKnowledgeStore } from "../store.js";
import { parseEvalDataset } from "./eval-case.js";
import { publishEvaluationToOpik } from "./opik-publisher.js";
import {
  isPublishable,
  manualInspectionTemplate,
  readManualInspection,
  renderComparisonMarkdown,
  type EvaluationProvenance,
} from "./report.js";
import { runEvaluation, type EvaluationRun, type EvaluationStrategy } from "./runner.js";
import { LlmAnswerSynthesizer, LlmFaithfulnessJudge, KB_ANSWER_PROMPT_VERSION, KB_FAITHFULNESS_PROMPT_VERSION } from "./synthesis.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATASET_FILE = join(BACKEND_ROOT, "data", "knowledge-eval", "kb-eval-v1.json");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readJsonIfPresent(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = readKnowledgeConfig();
  const dataset = parseEvalDataset(JSON.parse(await readFile(DATASET_FILE, "utf8")));
  if (dataset.rejected.length > 0) {
    throw new Error(`Dataset has rejected cases: ${dataset.rejected.map((item) => `${item.caseId ?? item.index}:${item.code}`).join(", ")}`);
  }
  const gateway = new HttpKnowledgeModelGateway(config);
  const requested = (argument("--strategies") ?? "vector_only,vector_rerank").split(",") as EvaluationStrategy[];
  const strategies = requested.filter((strategy) => {
    if (strategy === "vector_rerank" && !gateway.capabilities.supportsRerank) {
      process.stderr.write("Skipping vector_rerank: KB_RERANK_URL is not configured.\n");
      return false;
    }
    return strategy === "vector_only" || strategy === "vector_rerank";
  });
  if (strategies.length === 0) throw new Error("No runnable strategy");

  const date = new Date().toISOString().slice(0, 10);
  const outDirectory = resolve(argument("--out") ?? join(BACKEND_ROOT, "data", "knowledge-eval", "results", `${dataset.datasetVersion}-${date}`));
  const generationModel = process.env.KB_EVAL_GENERATION_MODEL?.trim() || process.env.QWEN_CHAT_MODEL?.trim() || "qwen-plus";
  const judgeModel = process.argv.includes("--no-judge") ? null : process.env.KB_EVAL_JUDGE_MODEL?.trim() || "qwen-max";
  const jsonModel = (model: string) => llmGateway.createChatModel({ model, purpose: "chat", temperature: 0, responseFormat: { type: "json_object" } });

  const broker = createKnowledgeSecretBroker();
  const context = createSystemExecutionContext("kb-evaluation");
  const credential = (await broker.resolve(KNOWLEDGE_MODEL_SECRET, context)).value;
  const pool = await createKnowledgePool(broker, context);
  const runs: EvaluationRun[] = [];
  try {
    for (const strategy of strategies) {
      process.stderr.write(`Running ${strategy} over ${dataset.cases.length} cases...\n`);
      runs.push(
        await runEvaluation({
          cases: dataset.cases,
          strategy,
          tenantId: config.corpusTenantId,
          store: new PgKnowledgeStore(pool),
          gateway,
          credential,
          config,
          synthesizer: new LlmAnswerSynthesizer(jsonModel(generationModel), generationModel),
          ...(judgeModel ? { judge: new LlmFaithfulnessJudge(jsonModel(judgeModel), judgeModel) } : {}),
        })
      );
    }
  } finally {
    await pool.end();
  }

  await mkdir(outDirectory, { recursive: true });
  const inspection = readManualInspection(await readJsonIfPresent(join(outDirectory, "manual-inspection.json")));
  const provenanceFor = (split: EvaluationProvenance["split"]): EvaluationProvenance => ({
    datasetVersion: dataset.datasetVersion,
    corpusVersion: dataset.corpusVersion,
    split,
    embeddingModel: config.embeddingModel,
    embeddingSpaceId: config.embeddingSpaceId,
    rerankModel: config.rerankModel,
    generationModel,
    judgeModel,
    answerPromptVersion: KB_ANSWER_PROMPT_VERSION,
    judgePromptVersion: judgeModel ? KB_FAITHFULNESS_PROMPT_VERSION : null,
    thresholdVersion: config.thresholdVersion,
    configVersion: config.configVersion,
    runCount: 1,
    date,
    synthetic: true,
  });
  for (const run of runs) await writeFile(join(outDirectory, `run-${run.strategy}.json`), `${JSON.stringify(run, null, 2)}\n`);
  for (const split of ["test", "dev"] as const) {
    await writeFile(join(outDirectory, `comparison-${split}.md`), renderComparisonMarkdown(runs, provenanceFor(split), inspection));
  }
  await writeFile(join(outDirectory, "provenance.json"), `${JSON.stringify(provenanceFor("all"), null, 2)}\n`);
  await writeFile(join(outDirectory, "manual-inspection-template.json"), `${JSON.stringify(manualInspectionTemplate(runs), null, 2)}\n`);

  const publication = process.argv.includes("--opik")
    ? await publishEvaluationToOpik(runs, dataset.cases, provenanceFor("all"))
    : { status: "skipped" as const, reason: "not_requested" };
  process.stdout.write(
    `${JSON.stringify(
      {
        outDirectory,
        publishable: isPublishable(runs),
        runs: runs.map((run) => ({ strategy: run.strategy, status: run.status, failedCases: run.failedCases, test: run.summary.test, dev: run.summary.dev })),
        manualInspection: inspection,
        opik: publication,
      },
      null,
      2
    )}\n`
  );
  if (!isPublishable(runs)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`KB evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
