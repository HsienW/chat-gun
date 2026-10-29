/**
 * Production wiring of the live chain evaluation (design §20.5 B1): the shopping
 * assistant's real models through the LLM gateway, and kb_search, ingestion and
 * purge over the knowledge database. Loaded by the CLI only in live mode.
 */
import { randomUUID } from "node:crypto";

import { LlmShoppingIntentRouter } from "../../agents/shopping-assistant/intent-router.js";
import { readShoppingAssistantModelSettings } from "../../agents/shopping-assistant/model-settings.js";
import { LlmPolicyAnswerSynthesizer } from "../../agents/shopping-assistant/policy-answer.js";
import { readKnowledgeConfig, type KnowledgeConfig } from "../../knowledge/config.js";
import {
  createKnowledgePool,
  createKnowledgeSecretBroker,
  createSystemExecutionContext,
  KNOWLEDGE_MODEL_SECRET,
} from "../../knowledge/connection.js";
import type { PreparedCorpus } from "../../knowledge/corpus.js";
import { KnowledgeError } from "../../knowledge/errors.js";
import { ingestCorpus } from "../../knowledge/ingestion.js";
import { runKnowledgeMigrations } from "../../knowledge/migration-runner.js";
import { HttpKnowledgeModelGateway, type KnowledgeModelGateway } from "../../knowledge/model-gateway.js";
import { PgKnowledgeStore, type KnowledgeStore } from "../../knowledge/store.js";
import { getConfiguredLlmCapabilities, llmGateway } from "../../platform/llm-gateway.js";
import type { Queryable } from "../../runtime/persistence/rows.js";
import { EnvironmentSecretBroker } from "../../runtime/tool-dispatch/secret-broker.js";
import { KB_SEARCH_SECRET_REFERENCE, createKbSearchTool } from "../../tools/kb-search.js";
import { isLiveTenantId } from "./chain-isolation.js";
import type { LiveChainKnowledge, LiveChainModels } from "./chain-runner.js";

export class ChainLiveTenantError extends Error {
  readonly name = "ChainLiveTenantError";
  readonly code = "CHAIN_LIVE_TENANT_INVALID";
}

export interface LiveChainKnowledgeDependencies {
  /** The knowledge database, for the tenant purge. */
  db: Queryable;
  store: KnowledgeStore;
  gateway: KnowledgeModelGateway;
  credential: string;
  config: KnowledgeConfig;
  corpus: PreparedCorpus;
}

export function createLiveChainKnowledge(dependencies: LiveChainKnowledgeDependencies): LiveChainKnowledge {
  const { db, store, gateway, credential, config, corpus } = dependencies;
  return {
    ingest: async (tenantId) => {
      const result = await ingestCorpus({
        runId: `kb-run-${randomUUID()}`,
        tenantId,
        corpus,
        store,
        gateway,
        credential,
        config,
        context: createSystemExecutionContext("chain-eval-live-ingestion"),
      });
      return { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
    },
    kbSearch: createKbSearchTool({ config: () => config, store: async () => store, gateway: () => gateway }),
    secretBroker: new EnvironmentSecretBroker({
      references: { [KB_SEARCH_SECRET_REFERENCE.secretRef]: KB_SEARCH_SECRET_REFERENCE.secretName },
    }),
    purge: async (tenantId) => {
      // Never a corpus or production tenant: only the run's own dedicated tenant.
      if (!isLiveTenantId(tenantId)) throw new ChainLiveTenantError("Only a live evaluation tenant can be purged");
      // Chunks reference their source; ingestion runs only record the import.
      for (const table of ["kb_chunk", "kb_source", "kb_ingestion_run"]) {
        await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      }
    },
  };
}

/** Provenance fields only the live layer has; values come from configuration, never secrets. */
export interface LiveChainProvenance {
  generationModel: string;
  temperature: number;
  intentPromptVersion: string;
  policyPromptVersion: string;
  embeddingModel: string;
  embeddingSpaceId: string;
  rerankModel: string | null;
  thresholdVersion: string;
  configVersion: string;
}

export interface PreparedLiveChainEvaluation {
  models: LiveChainModels;
  knowledge: LiveChainKnowledge;
  provenance: LiveChainProvenance;
  close(): Promise<void>;
}

/**
 * Resolves the knowledge credential and connection before the run starts, so a
 * missing secret fails closed without writing anything.
 */
export async function prepareLiveChainEvaluation(model: string, corpus: PreparedCorpus): Promise<PreparedLiveChainEvaluation> {
  const settings = readShoppingAssistantModelSettings();
  const config = readKnowledgeConfig();
  const broker = createKnowledgeSecretBroker();
  const context = createSystemExecutionContext("chain-eval-live");
  let credential: string;
  try {
    credential = (await broker.resolve(KNOWLEDGE_MODEL_SECRET, context)).value;
  } catch {
    throw new KnowledgeError("SECRET_REFERENCE_UNRESOLVABLE", "Knowledge model credential is not configured");
  }
  const pool = await createKnowledgePool(broker, context);
  try {
    await runKnowledgeMigrations(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const db: Queryable = {
    query: async (text, values = []) => {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  // Structured output is chosen by declared capability, never by model name.
  const jsonFormat = getConfiguredLlmCapabilities("chat").supportsStructuredOutput ? { responseFormat: { type: "json_object" as const } } : {};
  const chatModel = () => llmGateway.createChatModel({ purpose: "chat", model, temperature: settings.temperature, ...jsonFormat });
  const toolModel = () => llmGateway.createChatModel({ purpose: "tool", model, temperature: settings.temperature });
  const intentRouter = new LlmShoppingIntentRouter({ timeoutMs: settings.intentTimeoutMs, createModel: chatModel });
  const policyAnswerSynthesizer = new LlmPolicyAnswerSynthesizer(chatModel);
  const gateway = new HttpKnowledgeModelGateway(config);
  return {
    models: { intentRouter, policyAnswerSynthesizer, createProductRequestModel: toolModel, createOrderRequestModel: toolModel },
    knowledge: createLiveChainKnowledge({ db, store: new PgKnowledgeStore(pool), gateway, credential, config, corpus }),
    provenance: {
      generationModel: model,
      temperature: settings.temperature,
      intentPromptVersion: intentRouter.promptVersion,
      policyPromptVersion: policyAnswerSynthesizer.promptVersion,
      embeddingModel: config.embeddingModel,
      embeddingSpaceId: config.embeddingSpaceId,
      rerankModel: config.rerankUrl ? config.rerankModel : null,
      thresholdVersion: config.thresholdVersion,
      configVersion: config.configVersion,
    },
    close: () => pool.end(),
  };
}
