import { describe, expect, it } from "vitest";

import { knowledgeEgressDestinations, readKnowledgeConfig } from "./config.js";
import { KnowledgeError } from "./errors.js";

describe("knowledge configuration", () => {
  it("uses versioned defaults and derives the embedding space", () => {
    const config = readKnowledgeConfig(() => undefined);
    expect(config.embeddingModel).toBe("text-embedding-v4");
    expect(config.embeddingDimensions).toBe(1024);
    expect(config.embeddingSpaceId).toBe("text-embedding-v4:1024");
    expect(config.rerankUrl).toBeUndefined();
    expect(config.thresholdVersion).toMatch(/^kb-threshold-/u);
  });

  it("rejects an unsupported embedding dimension with a typed failure", () => {
    expect(() => readKnowledgeConfig((name) => (name === "KB_EMBEDDING_DIMENSIONS" ? "1000" : undefined))).toThrowError(
      expect.objectContaining({ code: "KB_CONFIG_INVALID" }) as KnowledgeError
    );
  });

  it("rejects overlap that is not smaller than the chunk target", () => {
    const environment: Record<string, string> = { KB_CHUNK_TARGET_CHARS: "100", KB_CHUNK_OVERLAP_CHARS: "100" };
    expect(() => readKnowledgeConfig((name) => environment[name])).toThrowError(KnowledgeError);
  });

  it("derives egress destinations from the configured endpoints only", () => {
    const environment: Record<string, string> = {
      QWEN_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      KB_RERANK_URL: "https://ws-1.ap-southeast-1.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
    };
    const config = readKnowledgeConfig((name) => environment[name]);
    expect(knowledgeEgressDestinations(config)).toEqual([
      "dashscope-intl.aliyuncs.com",
      "ws-1.ap-southeast-1.maas.aliyuncs.com",
    ]);
  });
});
