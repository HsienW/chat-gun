import { z } from "zod";

import { KnowledgeError } from "./errors.js";

/**
 * Versioned, non-secret knowledge configuration. Credentials never appear here; they are
 * resolved through the SecretBroker at the execution edge.
 */
export const KNOWLEDGE_CONFIG_VERSION = "kb-config-v1" as const;

const positiveInt = z.coerce.number().int().positive();
const unitInterval = z.coerce.number().min(0).max(1);

const knowledgeConfigSchema = z
  .object({
    embeddingBaseUrl: z.string().url(),
    embeddingModel: z.string().min(1),
    embeddingDimensions: z.coerce
      .number()
      .int()
      .refine((value) => [64, 128, 256, 512, 768, 1024, 1536, 2048].includes(value), {
        message: "unsupported embedding dimension",
      }),
    embeddingMaxBatch: positiveInt.max(10),
    rerankUrl: z.string().url().optional(),
    rerankModel: z.string().min(1),
    corpusTenantId: z.string().min(1),
    candidateCount: positiveInt.max(100),
    thresholdVersion: z.string().min(1),
    vectorThreshold: unitInterval,
    rerankThreshold: unitInterval,
    chunkingPolicyVersion: z.string().min(1),
    chunkTargetChars: positiveInt,
    chunkOverlapChars: z.coerce.number().int().nonnegative(),
    requestTimeoutMs: positiveInt,
  })
  .strict()
  .refine((config) => config.chunkOverlapChars < config.chunkTargetChars, {
    message: "chunk overlap must be smaller than the chunk target",
  });

export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema> & {
  embeddingSpaceId: string;
  configVersion: typeof KNOWLEDGE_CONFIG_VERSION;
};

type EnvironmentReader = (name: string) => string | undefined;

const DEFAULTS: Record<string, string> = {
  QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  KB_EMBEDDING_MODEL: "text-embedding-v4",
  KB_EMBEDDING_DIMENSIONS: "1024",
  KB_EMBEDDING_MAX_BATCH: "10",
  KB_RERANK_MODEL: "qwen3-rerank",
  KB_CORPUS_TENANT_ID: "public",
  KB_CANDIDATE_COUNT: "20",
  // Calibrated on the dev split; see data/knowledge-eval/thresholds/kb-threshold-v1.json.
  KB_THRESHOLD_VERSION: "kb-threshold-v1",
  KB_VECTOR_THRESHOLD: "0.616",
  KB_RERANK_THRESHOLD: "0.62",
  KB_CHUNKING_POLICY_VERSION: "kb-chunk-v1",
  KB_CHUNK_TARGET_CHARS: "900",
  KB_CHUNK_OVERLAP_CHARS: "120",
  KB_REQUEST_TIMEOUT_MS: "15000",
};

export function embeddingSpaceIdFor(model: string, dimensions: number): string {
  return `${model}:${dimensions}`;
}

export function readKnowledgeConfig(
  readEnvironment: EnvironmentReader = (name) => process.env[name]
): KnowledgeConfig {
  const value = (name: string): string | undefined => {
    const raw = readEnvironment(name)?.trim();
    return raw === undefined || raw.length === 0 ? DEFAULTS[name] : raw;
  };
  const parsed = knowledgeConfigSchema.safeParse({
    embeddingBaseUrl: value("QWEN_BASE_URL"),
    embeddingModel: value("KB_EMBEDDING_MODEL"),
    embeddingDimensions: value("KB_EMBEDDING_DIMENSIONS"),
    embeddingMaxBatch: value("KB_EMBEDDING_MAX_BATCH"),
    rerankUrl: value("KB_RERANK_URL"),
    rerankModel: value("KB_RERANK_MODEL"),
    corpusTenantId: value("KB_CORPUS_TENANT_ID"),
    candidateCount: value("KB_CANDIDATE_COUNT"),
    thresholdVersion: value("KB_THRESHOLD_VERSION"),
    vectorThreshold: value("KB_VECTOR_THRESHOLD"),
    rerankThreshold: value("KB_RERANK_THRESHOLD"),
    chunkingPolicyVersion: value("KB_CHUNKING_POLICY_VERSION"),
    chunkTargetChars: value("KB_CHUNK_TARGET_CHARS"),
    chunkOverlapChars: value("KB_CHUNK_OVERLAP_CHARS"),
    requestTimeoutMs: value("KB_REQUEST_TIMEOUT_MS"),
  });
  if (!parsed.success) {
    throw new KnowledgeError(
      "KB_CONFIG_INVALID",
      `Invalid knowledge configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`
    );
  }
  return {
    ...parsed.data,
    embeddingSpaceId: embeddingSpaceIdFor(parsed.data.embeddingModel, parsed.data.embeddingDimensions),
    configVersion: KNOWLEDGE_CONFIG_VERSION,
  };
}

/** Egress destinations derive from configured endpoints, never from a hard-coded host list. */
export function knowledgeEgressDestinations(config: KnowledgeConfig): string[] {
  const hosts = new Set<string>([new URL(config.embeddingBaseUrl).hostname.toLowerCase()]);
  if (config.rerankUrl !== undefined) hosts.add(new URL(config.rerankUrl).hostname.toLowerCase());
  return [...hosts];
}
