/**
 * Rebuilds the manual-inspection template for an existing results directory.
 *
 * Usage (from backend/):
 *   KNOWLEDGE_DATABASE_URL=... npx tsx --env-file=.env scripts/knowledge/build-inspection-template.ts <results-dir>
 *
 * Results recorded before evidence was stored get their evidence reconstructed by re-running
 * retrieval with the same configuration. Reconstructed evidence is marked verified only when the
 * top-10 source ranking matches the recorded one exactly; no answer is regenerated or re-judged.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readKnowledgeConfig } from "../../src/knowledge/config.js";
import {
  createKnowledgePool,
  createKnowledgeSecretBroker,
  createSystemExecutionContext,
  KNOWLEDGE_MODEL_SECRET,
} from "../../src/knowledge/connection.js";
import { parseEvalDataset } from "../../src/knowledge/evaluation/eval-case.js";
import { inspectionKey, manualInspectionTemplate, type InspectionEvidence } from "../../src/knowledge/evaluation/report.js";
import type { EvaluationRun } from "../../src/knowledge/evaluation/runner.js";
import { HttpKnowledgeModelGateway } from "../../src/knowledge/model-gateway.js";
import { buildSearchResult, retrieveCandidates } from "../../src/knowledge/retrieval.js";
import { rankedSources } from "../../src/knowledge/evaluation/scorers.js";
import { PgKnowledgeStore } from "../../src/knowledge/store.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  const resultsDirectory = resolve(process.argv[2] ?? "");
  const provenance = JSON.parse(await readFile(join(resultsDirectory, "provenance.json"), "utf8")) as { thresholdVersion: string; embeddingSpaceId: string };
  const config = readKnowledgeConfig();
  if (provenance.thresholdVersion !== config.thresholdVersion || provenance.embeddingSpaceId !== config.embeddingSpaceId) {
    throw new Error(`Current configuration (${config.thresholdVersion}, ${config.embeddingSpaceId}) differs from the results (${provenance.thresholdVersion}, ${provenance.embeddingSpaceId})`);
  }
  const runs: EvaluationRun[] = [];
  for (const strategy of ["vector_only", "vector_rerank"]) {
    try {
      runs.push(JSON.parse(await readFile(join(resultsDirectory, `run-${strategy}.json`), "utf8")) as EvaluationRun);
    } catch {
      // A results directory may contain only one configuration.
    }
  }
  const dataset = parseEvalDataset(JSON.parse(await readFile(join(BACKEND_ROOT, "data", "knowledge-eval", "kb-eval-v1.json"), "utf8")));
  const questions = new Map(dataset.cases.map((item) => [item.caseId, item.input.question]));

  const firstPass = manualInspectionTemplate(runs, { questions });
  const missing = firstPass.items.filter((item) => item.evidenceSource === "unavailable");
  const evidence = new Map<string, InspectionEvidence>();
  const report: { caseId: string; strategy: string; source: string }[] = [];
  if (missing.length > 0) {
    const broker = createKnowledgeSecretBroker();
    const context = createSystemExecutionContext("kb-inspection-template");
    const credential = (await broker.resolve(KNOWLEDGE_MODEL_SECRET, context)).value;
    const pool = await createKnowledgePool(broker, context);
    const store = new PgKnowledgeStore(pool);
    const gateway = new HttpKnowledgeModelGateway(config);
    try {
      for (const item of missing) {
        const run = runs.find((candidate) => candidate.strategy === item.strategy);
        const recorded = run?.results.find((result) => result.caseId === item.caseId);
        if (recorded?.status !== "completed") continue;
        const retrieved = await retrieveCandidates({
          query: item.question,
          tenantId: config.corpusTenantId,
          strategy: item.strategy === "vector_only" ? "vector_only" : "auto",
          store,
          gateway,
          credential,
          config,
        });
        const ranking = rankedSources(retrieved.candidates.map((candidate) => candidate.chunk.sourceId)).slice(0, 10);
        const matches = retrieved.mode === recorded.retrievalMode && JSON.stringify(ranking) === JSON.stringify(recorded.rankedSourceIds);
        const result = buildSearchResult(retrieved, config);
        const blocks =
          result.outcome === "evidence_found"
            ? result.chunks.map((chunk) => {
                const citation = result.citations.find((candidate) => candidate.citationId === chunk.citationId);
                return { citationId: chunk.citationId, sourceId: citation?.sourceId ?? "", title: citation?.title ?? "", content: chunk.content };
              })
            : [];
        const source = matches ? "reconstructed_verified" : "reconstruction_mismatch";
        evidence.set(inspectionKey(item.strategy, item.caseId), { blocks, source });
        report.push({ caseId: item.caseId, strategy: item.strategy, source });
      }
    } finally {
      await pool.end();
    }
  }

  const template = manualInspectionTemplate(runs, { questions, evidence });
  await writeFile(join(resultsDirectory, "manual-inspection-template.json"), `${JSON.stringify(template, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      items: template.items.map((item) => ({ caseId: item.caseId.replace("kb-eval-v1-", ""), strategy: item.strategy, judgeScore: item.judgeScore, evidenceBlocks: item.evidence.length, evidenceSource: item.evidenceSource })),
      reconstruction: report,
    }, null, 2)}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Template build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
