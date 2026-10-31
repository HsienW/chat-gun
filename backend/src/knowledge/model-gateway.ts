import { z } from "zod";

import { recordMetric } from "../platform/observability.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import {
  createEgressPolicy,
  EgressPolicyError,
  fetchWithValidatedRedirects,
  type EgressPolicy,
} from "../runtime/tool-dispatch/egress-policy.js";
import {
  toObservedEgressReasonCode,
  type ObservedEgressReasonCode,
} from "../runtime/tool-dispatch/egress-reason.js";
import { knowledgeEgressDestinations, type KnowledgeConfig } from "./config.js";
import { KnowledgeError, type KnowledgeErrorCode } from "./errors.js";

export type KnowledgeModelPurpose = "embedding" | "rerank";

export interface KnowledgeModelCapabilities {
  supportsEmbedding: boolean;
  supportsRerank: boolean;
}

export interface KnowledgeUsageEvent {
  provider: string;
  model: string;
  purpose: KnowledgeModelPurpose;
  inputItems: number;
  totalTokens: number | null;
  latencyMs: number;
  outcome: "succeeded" | "failed" | "cancelled";
  errorCode?: KnowledgeErrorCode;
  /** Set only when the call failed at the egress policy. */
  egressReasonCode?: ObservedEgressReasonCode;
}

export interface KnowledgeCallOptions {
  /** Credential resolved by the SecretBroker at the execution edge; never read from the environment here. */
  credential: string;
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface RerankScore {
  index: number;
  score: number;
}

export interface KnowledgeModelGateway {
  readonly capabilities: KnowledgeModelCapabilities;
  embed(texts: readonly string[], options: KnowledgeCallOptions): Promise<number[][]>;
  rerank(query: string, documents: readonly string[], options: KnowledgeCallOptions & { topN?: number }): Promise<RerankScore[]>;
}

export type KnowledgeHttp = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
  policy: EgressPolicy
) => Promise<Response>;

const defaultHttp: KnowledgeHttp = (url, init, policy) =>
  fetchWithValidatedRedirects(url, init, policy);

const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).partial().optional(),
});

const rerankResponseSchema = z.object({
  output: z.object({
    results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })),
  }),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).partial().optional(),
});

/** Provider limits from the official API reference, verified 2026-10-23. */
const MAX_EMBEDDING_INPUT_CHARS = 24_000;
const MAX_RERANK_DOCUMENTS = 500;

export type UsageSink = (event: KnowledgeUsageEvent, context?: ExecutionContext) => void;

const defaultUsageSink: UsageSink = (event, context) => {
  void recordMetric("knowledge.model.usage", { ...event }, context);
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}/${path}`;
}

function classifyHttpFailure(status: number): KnowledgeErrorCode {
  if (status === 429) return "KB_PROVIDER_RATE_LIMITED";
  if (status === 408 || status === 504) return "KB_PROVIDER_TIMEOUT";
  return "KB_PROVIDER_ERROR";
}

export class HttpKnowledgeModelGateway implements KnowledgeModelGateway {
  readonly capabilities: KnowledgeModelCapabilities;
  private readonly policy: EgressPolicy;

  constructor(
    private readonly config: KnowledgeConfig,
    private readonly http: KnowledgeHttp = defaultHttp,
    private readonly usageSink: UsageSink = defaultUsageSink,
    private readonly now: () => number = () => Date.now()
  ) {
    this.capabilities = { supportsEmbedding: true, supportsRerank: config.rerankUrl !== undefined };
    const urls = [config.embeddingBaseUrl, ...(config.rerankUrl ? [config.rerankUrl] : [])];
    this.policy = createEgressPolicy({
      destinations: knowledgeEgressDestinations(config),
      protocols: [...new Set(urls.map((url) => new URL(url).protocol.replace(":", "") as "http" | "https"))],
    });
  }

  async embed(texts: readonly string[], options: KnowledgeCallOptions): Promise<number[][]> {
    if (!this.capabilities.supportsEmbedding) {
      throw new KnowledgeError("KB_EMBEDDING_UNSUPPORTED");
    }
    if (texts.some((text) => text.length === 0 || text.length > MAX_EMBEDDING_INPUT_CHARS)) {
      throw new KnowledgeError("KB_EMBEDDING_INPUT_TOO_LARGE", "Embedding input is empty or exceeds the provider limit");
    }
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.config.embeddingMaxBatch) {
      const batch = texts.slice(start, start + this.config.embeddingMaxBatch);
      const response = await this.call("embedding", this.config.embeddingModel, batch.length, options, () => ({
        url: joinUrl(this.config.embeddingBaseUrl, "embeddings"),
        body: {
          model: this.config.embeddingModel,
          input: batch,
          dimensions: this.config.embeddingDimensions,
          encoding_format: "float",
        },
      }));
      const parsed = embeddingResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.data.length !== batch.length) {
        throw new KnowledgeError("KB_PROVIDER_ERROR", "Embedding response does not match the request");
      }
      const ordered = [...parsed.data.data].sort((left, right) => left.index - right.index);
      for (const item of ordered) {
        if (item.embedding.length !== this.config.embeddingDimensions) {
          throw new KnowledgeError("KB_EMBEDDING_DIMENSION_MISMATCH", "Provider returned an unexpected embedding dimension");
        }
        vectors.push(item.embedding);
      }
    }
    return vectors;
  }

  async rerank(
    query: string,
    documents: readonly string[],
    options: KnowledgeCallOptions & { topN?: number }
  ): Promise<RerankScore[]> {
    const rerankUrl = this.config.rerankUrl;
    if (!this.capabilities.supportsRerank || rerankUrl === undefined) {
      throw new KnowledgeError("KB_RERANK_UNSUPPORTED");
    }
    if (documents.length === 0) return [];
    if (documents.length > MAX_RERANK_DOCUMENTS) {
      throw new KnowledgeError("KB_EMBEDDING_INPUT_TOO_LARGE", "Too many documents for one rerank request");
    }
    const response = await this.call("rerank", this.config.rerankModel, documents.length, options, () => ({
      url: rerankUrl,
      body: {
        model: this.config.rerankModel,
        input: { query, documents },
        parameters: { top_n: options.topN ?? documents.length, return_documents: false },
      },
    }));
    const parsed = rerankResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.output.results.some((item) => item.index >= documents.length)) {
      throw new KnowledgeError("KB_PROVIDER_ERROR", "Rerank response does not match the request");
    }
    return parsed.data.output.results.map((item) => ({ index: item.index, score: item.relevance_score }));
  }

  private async call(
    purpose: KnowledgeModelPurpose,
    model: string,
    inputItems: number,
    options: KnowledgeCallOptions,
    build: () => { url: string; body: unknown }
  ): Promise<{ body: unknown }> {
    const startedAt = this.now();
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const report = (outcome: KnowledgeUsageEvent["outcome"], totalTokens: number | null, failure?: KnowledgeError) =>
      this.usageSink(
        {
          provider: "qwen",
          model,
          purpose,
          inputItems,
          totalTokens,
          latencyMs: this.now() - startedAt,
          outcome,
          ...(failure ? { errorCode: failure.code } : {}),
          ...(failure?.egressReasonCode ? { egressReasonCode: failure.egressReasonCode } : {}),
        },
        options.context
      );
    try {
      if (options.signal?.aborted) throw new KnowledgeError("KB_CANCELLED");
      const { url, body } = build();
      const response = await this.http(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.credential}` },
          body: JSON.stringify(body),
          signal,
        },
        this.policy
      );
      if (!response.ok) {
        throw new KnowledgeError(classifyHttpFailure(response.status), `Knowledge ${purpose} request failed with HTTP ${response.status}`);
      }
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        throw new KnowledgeError("KB_PROVIDER_ERROR", `Knowledge ${purpose} response is not JSON`);
      }
      const tokens = (parsedBody as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens;
      report("succeeded", typeof tokens === "number" ? tokens : null);
      return { body: parsedBody };
    } catch (error) {
      const failure = this.toKnowledgeError(error, options.signal);
      report(failure.code === "KB_CANCELLED" ? "cancelled" : "failed", null, failure);
      throw failure;
    }
  }

  private toKnowledgeError(error: unknown, external?: AbortSignal): KnowledgeError {
    if (external?.aborted) return new KnowledgeError("KB_CANCELLED");
    if (error instanceof KnowledgeError) return error;
    if (error instanceof EgressPolicyError) {
      // Keep the egress classification; the egress message is not reused because it is not ours to expose.
      const reason = toObservedEgressReasonCode(error.reasonCode);
      return new KnowledgeError(error.code, `Knowledge egress failed: ${error.code} (${reason})`, reason);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return new KnowledgeError("KB_PROVIDER_TIMEOUT");
    }
    return new KnowledgeError("KB_PROVIDER_ERROR");
  }
}
