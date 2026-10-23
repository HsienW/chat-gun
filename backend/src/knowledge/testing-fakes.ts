import { createHash } from "node:crypto";

import { readKnowledgeConfig, type KnowledgeConfig } from "./config.js";
import { KnowledgeError } from "./errors.js";
import type { KnowledgeCallOptions, KnowledgeModelGateway, RerankScore } from "./model-gateway.js";

/** Deterministic test doubles. They are not a substitute for live provider evidence. */
export function testKnowledgeConfig(overrides: Record<string, string> = {}): KnowledgeConfig {
  const environment: Record<string, string> = {
    QWEN_BASE_URL: "https://embedding.example.test/compatible-mode/v1",
    KB_EMBEDDING_DIMENSIONS: "64",
    KB_RERANK_URL: "https://rerank.example.test/api/v1/services/rerank/text-rerank/text-rerank",
    KB_VECTOR_THRESHOLD: "0.2",
    KB_RERANK_THRESHOLD: "0.3",
    ...overrides,
  };
  return readKnowledgeConfig((name) => environment[name]);
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}

export function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokens(text)) {
    const bucket = createHash("sha256").update(token).digest().readUInt32BE(0) % dimensions;
    vector[bucket] += 1;
  }
  return vector;
}

export interface FakeGatewayOptions {
  dimensions: number;
  supportsRerank?: boolean;
  failEmbeddingFor?: (text: string) => KnowledgeError | undefined;
  failRerank?: KnowledgeError;
}

export class FakeKnowledgeModelGateway implements KnowledgeModelGateway {
  readonly capabilities;
  readonly embedCalls: string[][] = [];
  readonly rerankCalls: { query: string; documents: readonly string[] }[] = [];
  readonly credentials: string[] = [];
  readonly contexts: KnowledgeCallOptions["context"][] = [];

  constructor(private readonly options: FakeGatewayOptions) {
    this.capabilities = { supportsEmbedding: true, supportsRerank: options.supportsRerank ?? true };
  }

  async embed(texts: readonly string[], options: KnowledgeCallOptions): Promise<number[][]> {
    if (options.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
    this.embedCalls.push([...texts]);
    this.credentials.push(options.credential);
    this.contexts.push(options.context);
    for (const text of texts) {
      const failure = this.options.failEmbeddingFor?.(text);
      if (failure !== undefined) throw failure;
    }
    return texts.map((text) => hashEmbedding(text, this.options.dimensions));
  }

  async rerank(query: string, documents: readonly string[], options: KnowledgeCallOptions): Promise<RerankScore[]> {
    if (options.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
    if (!this.capabilities.supportsRerank) throw new KnowledgeError("KB_RERANK_UNSUPPORTED");
    if (this.options.failRerank) throw this.options.failRerank;
    this.rerankCalls.push({ query, documents });
    const queryTokens = new Set(tokens(query));
    return documents
      .map((document, index) => {
        const documentTokens = new Set(tokens(document));
        const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
        return { index, score: queryTokens.size === 0 ? 0 : overlap / queryTokens.size };
      })
      .sort((left, right) => right.score - left.score);
  }
}
