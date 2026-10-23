import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chunkDocument, loadRawCorpus, normalizeText, prepareCorpus } from "./corpus.js";

const CORPUS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "knowledge-corpus", "kb-v1", "raw");

function product(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    synthetic: true,
    corpusVersion: "kb-test",
    generatedAt: "2026-10-23",
    sourceId,
    sourceType: "product",
    title: `Title ${sourceId}`,
    description: `Description of ${sourceId}.`,
    ...overrides,
  };
}

function policy(sourceId: string, body: string, header: string[] = []): { origin: string; markdown: string } {
  return {
    origin: `policies/${sourceId}.md`,
    markdown: [
      "---",
      "synthetic: true",
      "corpusVersion: kb-test",
      "generatedAt: 2026-10-23",
      `sourceId: ${sourceId}`,
      "sourceType: policy",
      `title: ${sourceId}`,
      ...header,
      "---",
      "",
      `# ${sourceId}`,
      "",
      body,
    ].join("\n"),
  };
}

describe("corpus preparation", () => {
  it("normalizes entities and whitespace while keeping paragraph breaks", () => {
    expect(normalizeText("  Price  is 10&nbsp;USD.\r\n\r\n\r\nSecond   paragraph ")).toBe("Price is 10 USD.\n\nSecond paragraph");
  });

  it("rejects sources without synthetic provenance and keeps processing the rest", () => {
    const result = prepareCorpus({
      products: [product("product-a"), product("product-b", { synthetic: undefined }), { sourceId: "x" }],
      policyMarkdown: [{ origin: "policies/raw.md", markdown: "# No front matter\n\nBody" }],
    });
    expect(result.documents.map((document) => document.sourceId)).toEqual(["product-a"]);
    expect(result.rejected).toEqual([
      { origin: "products[1]", code: "KB_SOURCE_PROVENANCE_MISSING" },
      { origin: "products[2]", code: "KB_SOURCE_PROVENANCE_MISSING" },
      { origin: "policies/raw.md", code: "KB_SOURCE_PROVENANCE_MISSING" },
    ]);
  });

  it("rejects empty and oversized sources with typed codes", () => {
    const result = prepareCorpus({
      products: [product("product-empty", { description: "   " }), product("product-huge", { description: "x".repeat(200_001) })],
      policyMarkdown: [],
    });
    expect(result.rejected.map((item) => item.code)).toEqual(["KB_SOURCE_EMPTY", "KB_SOURCE_TOO_LARGE"]);
  });

  it("removes exact and formatting-only duplicates and counts conflicting ones", () => {
    const result = prepareCorpus({
      products: [
        product("product-a"),
        product("product-a"),
        product("product-a", { title: "  TITLE PRODUCT-A ", description: "Description  of product-a.\n\n" }),
        product("product-a", { description: "A different description." }),
      ],
      policyMarkdown: [],
    });
    expect(result.documents).toHaveLength(1);
    expect(result.counts).toMatchObject({ duplicatesRemoved: 2, conflictingDuplicates: 1, acceptedDocuments: 1 });
  });

  it("chunks long documents with offsets that point into the normalized body", () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index}. ${"Detail sentence. ".repeat(12)}`);
    const [document] = prepareCorpus({ products: [], policyMarkdown: [policy("policy-long", paragraphs.join("\n\n"))] }).documents;
    const chunks = chunkDocument(document, { version: "test", targetChars: 300, overlapChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.offsetEnd).toBeGreaterThan(chunk.offsetStart);
      expect(chunk.content).toContain(document.body.slice(chunk.offsetStart, chunk.offsetEnd).trim());
      expect(chunk.content.startsWith(document.title)).toBe(true);
    }
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it("prepares the synthetic kb-v1 corpus with the documented cleaning counts", async () => {
    const result = prepareCorpus(await loadRawCorpus(CORPUS_DIRECTORY));
    expect(result.counts).toEqual({
      rawRecords: 242,
      acceptedDocuments: 230,
      rejectedDocuments: 0,
      duplicatesRemoved: 12,
      conflictingDuplicates: 0,
    });
    expect(result.documents.filter((document) => document.sourceType === "product")).toHaveLength(200);
    expect(result.documents.every((document) => document.dataClassification === "knowledge:internal-synthetic")).toBe(true);
  });
});
