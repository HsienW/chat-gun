/**
 * Live acceptance of the order request step against one real model (design D5).
 *
 * Usage (from backend/):
 *   npm run commerce:order-golden -- [--date YYYY-MM-DD]
 *   npm run commerce:order-golden -- --rescore <result directory name>
 *
 * --rescore judges a stored run again under the current rule (design D9). It calls
 * no model and writes to <result directory name>-rescored.
 *
 * Calls the model with the order tools bound; no Tool runs and no database is
 * opened. Without a model or credential it reports not_executed and writes nothing.
 * Results go to data/commerce-eval/results/<datasetVersion>-live-<model>-<date>/
 * and an existing result set is never overwritten.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readShoppingAssistantModelSettings } from "../../agents/shopping-assistant/model-settings.js";
import { ORDER_REQUEST_SYSTEM_PROMPT, SHOPPING_ORDER_REQUEST_PROMPT_VERSION } from "../../agents/shopping-assistant/order-branch.js";
import { describeLlmGatewayConfig } from "../../platform/llm-gateway.js";
import { MockOrderProvider } from "../../tools/orders/mock-order-provider.js";
import { createOrderToolSet } from "../../tools/orders/order-tools.js";
import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { createCommerceGenerationModels } from "./generation-models.js";
import {
  goldenDatasetSha256,
  goldenResultDirectoryName,
  MIN_REPEATS,
  orderRequestGoldenSchema,
  renderGoldenReportMarkdown,
  rescoreGoldenRun,
  runOrderRequestGolden,
  summarizeGolden,
  type GoldenProvenance,
} from "./order-request-golden.js";

const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");
const DATASET_FILE = join(DATA_ROOT, "commerce", "order-request-golden-v2.json");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rescoreIndex = argv.indexOf("--rescore");
  if (rescoreIndex !== -1) {
    const { outDirectory, summary } = await rescoreGoldenRun({
      resultsRoot: join(DATA_ROOT, "commerce-eval", "results"),
      sourceName: argv[rescoreIndex + 1] ?? "",
      datasetRaw: await readFile(DATASET_FILE, "utf8"),
      promptVersion: SHOPPING_ORDER_REQUEST_PROMPT_VERSION,
      ruleRevision: "2026-10-31, design D9",
    });
    process.stdout.write(
      `${JSON.stringify({ outDirectory, verdict: summary.verdict, knownLimitations: summary.knownLimitations, unmetThresholds: summary.unmetThresholds, failedCases: summary.failedCases }, null, 2)}\n`
    );
    if (summary.verdict !== "passed" && summary.verdict !== "passed_with_known_limitation") process.exitCode = 1;
    return;
  }
  const dateIndex = argv.indexOf("--date");
  const date = dateIndex === -1 ? new Date().toISOString().slice(0, 10) : argv[dateIndex + 1] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("--date must be YYYY-MM-DD");

  const settings = readShoppingAssistantModelSettings();
  const missing = [
    ...(settings.model === undefined ? ["SHOPPING_ASSISTANT_MODEL"] : []),
    ...(describeLlmGatewayConfig().apiKeyConfigured === true ? [] : ["model credential"]),
  ];
  if (settings.model === undefined || missing.length > 0) {
    process.stdout.write(`${JSON.stringify({ verdict: "not_executed", missing })}\n`);
    process.exitCode = 1;
    return;
  }
  const model = settings.model;
  const generation = createCommerceGenerationModels(model);

  const raw = await readFile(DATASET_FILE, "utf8");
  const dataset = orderRequestGoldenSchema.parse(JSON.parse(raw));
  const provenance: GoldenProvenance = {
    datasetVersion: dataset.provenance.datasetVersion,
    datasetSha256: goldenDatasetSha256(raw),
    mode: "live",
    model,
    temperature: settings.temperature,
    promptVersion: SHOPPING_ORDER_REQUEST_PROMPT_VERSION,
    repeats: MIN_REPEATS,
    date,
    synthetic: true,
  };
  const outDirectory = join(DATA_ROOT, "commerce-eval", "results", goldenResultDirectoryName(provenance));
  await mkdir(dirname(outDirectory), { recursive: true });
  await mkdir(outDirectory); // Fails on an existing result set before any model call.

  const { tools } = createOrderToolSet({
    provider: new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() }),
    statusReader: { read: async () => null },
  });
  const results = await runOrderRequestGolden({
    cases: dataset.cases,
    tools,
    systemPrompt: ORDER_REQUEST_SYSTEM_PROMPT,
    repeats: provenance.repeats,
    createModel: generation.toolModel,
  });
  const observed = generation.observer.snapshot();
  Object.assign(provenance, { ...observed, generationModels: { tool: observed.generationModels.tool } });
  const summary = summarizeGolden(dataset.cases, results);

  await writeFile(join(outDirectory, "run.json"), `${JSON.stringify({ provenance, summary, results }, null, 2)}\n`);
  await writeFile(join(outDirectory, "report.md"), renderGoldenReportMarkdown(summary, provenance));
  process.stdout.write(
    `${JSON.stringify({ outDirectory, verdict: summary.verdict, knownLimitations: summary.knownLimitations, unmetThresholds: summary.unmetThresholds, failedCases: summary.failedCases, incompleteRuns: summary.incompleteRuns }, null, 2)}\n`
  );
  if (summary.verdict !== "passed" && summary.verdict !== "passed_with_known_limitation") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
  process.stderr.write(`Order request golden failed: ${code}${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
