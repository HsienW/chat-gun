/**
 * Ingests the synthetic knowledge corpus into the knowledge store.
 *
 * Usage: npm run knowledge:ingest [-- --corpus <dir>] [-- --tenant <tenantId>]
 * Requires KNOWLEDGE_DATABASE_URL and QWEN_API_KEY, resolved through the SecretBroker.
 */
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readKnowledgeConfig } from "./config.js";
import {
  createKnowledgePool,
  createKnowledgeSecretBroker,
  createSystemExecutionContext,
  KNOWLEDGE_MODEL_SECRET,
} from "./connection.js";
import { loadRawCorpus, prepareCorpus } from "./corpus.js";
import { isKnowledgeError, KnowledgeError } from "./errors.js";
import { ingestCorpus } from "./ingestion.js";
import { runKnowledgeMigrations } from "./migration-runner.js";
import { HttpKnowledgeModelGateway } from "./model-gateway.js";
import { PgKnowledgeStore } from "./store.js";

const DEFAULT_CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "knowledge-corpus", "kb-v1", "raw");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const config = readKnowledgeConfig();
  const tenantId = argument("--tenant") ?? config.corpusTenantId;
  const corpusDirectory = resolve(argument("--corpus") ?? DEFAULT_CORPUS);
  const broker = createKnowledgeSecretBroker();
  const context = createSystemExecutionContext("kb-ingestion");

  let credential: string;
  try {
    credential = (await broker.resolve(KNOWLEDGE_MODEL_SECRET, context)).value;
  } catch {
    throw new KnowledgeError("SECRET_REFERENCE_UNRESOLVABLE", "Knowledge model credential is not configured");
  }
  const pool = await createKnowledgePool(broker, context);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    await runKnowledgeMigrations(pool);
    const corpus = prepareCorpus(await loadRawCorpus(corpusDirectory));
    const result = await ingestCorpus({
      runId: `kb-run-${randomUUID()}`,
      tenantId,
      corpus,
      store: new PgKnowledgeStore(pool),
      gateway: new HttpKnowledgeModelGateway(config),
      credential,
      config,
      signal: abort.signal,
      context,
    });
    process.stdout.write(
      `${JSON.stringify({ preparation: corpus.counts, rejected: corpus.rejected, ingestion: result }, null, 2)}\n`
    );
    if (result.status !== "completed") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${isKnowledgeError(error) ? error.code : "KB_INGESTION_FAILED"}: ${error instanceof Error ? error.message : ""}\n`);
  process.exitCode = 1;
});
