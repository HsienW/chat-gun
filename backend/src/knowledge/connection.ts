import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { readExecutionContext } from "../runtime/execution-context/read-execution-context.js";
import {
  EnvironmentSecretBroker,
  type SecretBrokerPort,
  type SecretReference,
} from "../runtime/tool-dispatch/secret-broker.js";
import { KnowledgeError } from "./errors.js";
import { PgKnowledgeStore, type KnowledgeStore } from "./store.js";

export const KNOWLEDGE_DATABASE_SECRET: SecretReference = {
  secretRef: "env:KNOWLEDGE_DATABASE_URL",
  secretName: "KNOWLEDGE_DATABASE_URL",
  scope: "knowledge:store",
};

export const KNOWLEDGE_MODEL_SECRET: SecretReference = {
  secretRef: "env:QWEN_API_KEY",
  secretName: "QWEN_API_KEY",
  scope: "knowledge:model",
};

/** Broker for knowledge infrastructure secrets; values are read only at the execution edge. */
export function createKnowledgeSecretBroker(): SecretBrokerPort {
  return new EnvironmentSecretBroker({
    references: {
      [KNOWLEDGE_DATABASE_SECRET.secretRef]: KNOWLEDGE_DATABASE_SECRET.secretName,
      [KNOWLEDGE_MODEL_SECRET.secretRef]: KNOWLEDGE_MODEL_SECRET.secretName,
    },
  });
}

/** Offline jobs (ingestion, evaluation) run under a server-side system context, never a client one. */
export function createSystemExecutionContext(
  purpose: string,
  ids: { runId?: string; requestId?: string; taskId?: string } = {}
): ExecutionContext {
  const id = `${purpose}-${randomUUID()}`;
  return readExecutionContext(
    undefined,
    {
      configurable: {
        thread_id: ids.runId ?? id,
        requestId: ids.requestId ?? id,
        runId: ids.runId ?? id,
        taskId: ids.taskId ?? ids.requestId ?? id,
      },
    },
    "development"
  );
}

export async function createKnowledgePool(
  broker: SecretBrokerPort,
  context: ExecutionContext
): Promise<Pool> {
  let connectionString: string;
  try {
    connectionString = (await broker.resolve(KNOWLEDGE_DATABASE_SECRET, context)).value;
  } catch {
    throw new KnowledgeError("SECRET_REFERENCE_UNRESOLVABLE", "Knowledge store connection is not configured");
  }
  const sslMode = new URL(connectionString).searchParams.get("sslmode");
  return new Pool({ connectionString, max: 4, ssl: sslMode === "require" ? true : false });
}

let sharedStore: Promise<KnowledgeStore> | undefined;

/** Process-wide store for the kb_search tool; the pool is created once on first use. */
export function getSharedKnowledgeStore(): Promise<KnowledgeStore> {
  sharedStore ??= createKnowledgePool(
    createKnowledgeSecretBroker(),
    createSystemExecutionContext("kb-store")
  )
    .then((pool) => new PgKnowledgeStore(pool))
    .catch((error) => {
      sharedStore = undefined;
      throw error;
    });
  return sharedStore;
}
