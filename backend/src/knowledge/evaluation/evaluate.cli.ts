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

import { createGenerationObserver } from "../../evaluation/generation-provenance.js";
import { DEFAULT_GENERATION_MODEL } from "../../platform/generation-model-profile.js";
import { getEffectiveLlmEndpoint, llmGateway, resolveModelForPurpose, supportsConfiguredThinkingControl } from "../../platform/llm-gateway.js";
import { readKnowledgeConfig } from "../config.js";
import {
  createKnowledgePool,
  createKnowledgeSecretBroker,
  createSystemExecutionContext,
  KNOWLEDGE_MODEL_SECRET,
} from "../connection.js";
import { HttpKnowledgeModelGateway } from "../model-gateway.js";
import { PgKnowledgeStore } from "../store.js";
import { loadEvaluationDataset } from "./dataset-loader.js";
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

export async function runKnowledgeEvaluationCli(): Promise<void> {
  if (process.argv.includes("--dataset") && (!argument("--dataset") || argument("--dataset")!.startsWith("--"))) throw new Error("EVAL_DATASET_NAME_INVALID");
  const loaded = await loadEvaluationDataset(join(BACKEND_ROOT, "data", "knowledge-eval"), argument("--dataset"));
  const { dataset } = loaded;
  const config = readKnowledgeConfig();
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
  const generationModel = process.env.KB_EVAL_GENERATION_MODEL?.trim() || process.env.QWEN_CHAT_MODEL?.trim() || DEFAULT_GENERATION_MODEL;
  const judgeModel = process.argv.includes("--no-judge") ? null : process.env.KB_EVAL_JUDGE_MODEL?.trim() || "qwen-max";
  const jsonModel = (model: string) => llmGateway.createChatModel({ model, purpose: "chat", temperature: 0, responseFormat: { type: "json_object" } });
  // D-9: effective endpoint (built-in default included); fails before any model is built or result written.
  const { provider, endpointHost: llmEndpointHost } = getEffectiveLlmEndpoint();
  const supportsThinking = supportsConfiguredThinkingControl();
  const observer = createGenerationObserver({
    generationModels: { chat: resolveModelForPurpose("chat", generationModel) },
    llmProvider: provider, llmEndpointHost, thinkingEnabled: supportsThinking ? false : null,
  });
  const generationJsonModel = () => observer.wrap(llmGateway.createChatModel({
    model: generationModel, purpose: "chat", temperature: 0, responseFormat: { type: "json_object" },
    ...(supportsThinking ? { thinkingEnabled: false } : {}),
  }));

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
          datasetVersion: dataset.datasetVersion,
          datasetSha256: loaded.datasetSha256,
          synthesizer: new LlmAnswerSynthesizer(generationJsonModel(), generationModel),
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
    ...observer.snapshot(),
    datasetVersion: dataset.datasetVersion,
    datasetSha256: loaded.datasetSha256,
    queryMode: loaded.queryMode,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runKnowledgeEvaluationCli().catch((error: unknown) => {
    process.stderr.write(`KB evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
