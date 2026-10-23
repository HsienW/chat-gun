import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { KnowledgeErrorCode } from "./errors.js";
import { KNOWLEDGE_SOURCE_TYPES, type KnowledgeSourceType } from "./store.js";

/** Synthetic-corpus classification; the corpus contains no subject personal data. */
export const CORPUS_DATA_CLASSIFICATION = "knowledge:internal-synthetic";

const MAX_SOURCE_CHARS = 200_000;

const provenanceSchema = z.object({
  synthetic: z.literal(true),
  corpusVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  sourceType: z.enum(KNOWLEDGE_SOURCE_TYPES),
});

const productSchema = provenanceSchema.extend({
  sourceType: z.literal("product"),
  title: z.string(),
  description: z.string(),
});

export interface SourceDocument {
  sourceId: string;
  sourceType: KnowledgeSourceType;
  corpusVersion: string;
  title: string;
  /** Normalized body text; chunk offsets refer to this string. */
  body: string;
  contentHash: string;
  dataClassification: string;
}

export interface RejectedSource {
  origin: string;
  code: Extract<KnowledgeErrorCode, "KB_SOURCE_PROVENANCE_MISSING" | "KB_SOURCE_EMPTY" | "KB_SOURCE_TOO_LARGE">;
}

export interface PreparedCorpus {
  documents: SourceDocument[];
  rejected: RejectedSource[];
  counts: {
    rawRecords: number;
    acceptedDocuments: number;
    rejectedDocuments: number;
    duplicatesRemoved: number;
    conflictingDuplicates: number;
  };
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
};

/** Unicode NFKC, HTML entity decoding, and whitespace collapsing that keeps paragraph breaks. */
export function normalizeText(text: string): string {
  const decoded = text
    .normalize("NFKC")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gu, (entity) => HTML_ENTITIES[entity] ?? entity);
  return decoded
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n");
}

export function contentHashOf(title: string, body: string): string {
  return createHash("sha256").update(`${title}\u0000${body}`).digest("hex");
}

function dedupeKey(title: string, body: string): string {
  return createHash("sha256").update(`${title.toLowerCase()}\u0000${body.toLowerCase()}`).digest("hex");
}

function parseFrontMatter(markdown: string): { header: Record<string, unknown>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(markdown);
  if (match === null) return null;
  const header: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    header[key] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  return { header, body: match[2].replace(/^#\s+.*\n/u, "") };
}

interface Candidate {
  origin: string;
  provenance: z.infer<typeof provenanceSchema>;
  title: string;
  rawBody: string;
}

function toDocument(candidate: Candidate): SourceDocument | RejectedSource {
  const title = normalizeText(candidate.title);
  const body = normalizeText(candidate.rawBody);
  if (title.length === 0 || body.length === 0) return { origin: candidate.origin, code: "KB_SOURCE_EMPTY" };
  if (body.length > MAX_SOURCE_CHARS) return { origin: candidate.origin, code: "KB_SOURCE_TOO_LARGE" };
  return {
    sourceId: candidate.provenance.sourceId,
    sourceType: candidate.provenance.sourceType,
    corpusVersion: candidate.provenance.corpusVersion,
    title,
    body,
    contentHash: contentHashOf(title, body),
    dataClassification: CORPUS_DATA_CLASSIFICATION,
  };
}

/** Parses, validates provenance, normalizes and deduplicates raw corpus inputs. */
export function prepareCorpus(inputs: {
  products: readonly unknown[];
  policyMarkdown: readonly { origin: string; markdown: string }[];
}): PreparedCorpus {
  const candidates: (Candidate | RejectedSource)[] = [];
  inputs.products.forEach((record, index) => {
    const parsed = productSchema.safeParse(record);
    candidates.push(
      parsed.success
        ? { origin: `products[${index}]`, provenance: parsed.data, title: parsed.data.title, rawBody: parsed.data.description }
        : { origin: `products[${index}]`, code: "KB_SOURCE_PROVENANCE_MISSING" }
    );
  });
  for (const { origin, markdown } of inputs.policyMarkdown) {
    const document = parseFrontMatter(markdown);
    const parsed = document === null ? null : provenanceSchema.safeParse(document.header);
    candidates.push(
      document !== null && parsed?.success === true && typeof document.header.title === "string"
        ? { origin, provenance: parsed.data, title: document.header.title, rawBody: document.body }
        : { origin, code: "KB_SOURCE_PROVENANCE_MISSING" }
    );
  }

  const documents: SourceDocument[] = [];
  const rejected: RejectedSource[] = [];
  const seen = new Map<string, string>();
  let duplicatesRemoved = 0;
  let conflictingDuplicates = 0;
  for (const candidate of candidates) {
    if ("code" in candidate) {
      rejected.push(candidate);
      continue;
    }
    const result = toDocument(candidate);
    if ("code" in result) {
      rejected.push(result);
      continue;
    }
    const key = dedupeKey(result.title, result.body);
    const previous = seen.get(result.sourceId);
    if (previous !== undefined) {
      if (previous === key) duplicatesRemoved += 1;
      else conflictingDuplicates += 1;
      continue;
    }
    seen.set(result.sourceId, key);
    documents.push(result);
  }
  return {
    documents,
    rejected,
    counts: {
      rawRecords: candidates.length,
      acceptedDocuments: documents.length,
      rejectedDocuments: rejected.length,
      duplicatesRemoved,
      conflictingDuplicates,
    },
  };
}

export async function loadRawCorpus(corpusDirectory: string): Promise<{
  products: unknown[];
  policyMarkdown: { origin: string; markdown: string }[];
}> {
  const products = JSON.parse(await readFile(join(corpusDirectory, "products.json"), "utf8")) as unknown;
  if (!Array.isArray(products)) throw new Error("products.json must contain an array");
  const policyDirectory = join(corpusDirectory, "policies");
  const names = (await readdir(policyDirectory)).filter((name) => name.endsWith(".md")).sort();
  const policyMarkdown = await Promise.all(
    names.map(async (name) => ({ origin: `policies/${name}`, markdown: await readFile(join(policyDirectory, name), "utf8") }))
  );
  return { products, policyMarkdown };
}

export interface ChunkingPolicy {
  version: string;
  targetChars: number;
  overlapChars: number;
}

export interface DocumentChunk {
  chunkIndex: number;
  offsetStart: number;
  offsetEnd: number;
  /** Text sent to the embedding model: the source title prefixes the chunk for context. */
  content: string;
  contentHash: string;
}

/**
 * Paragraph-aware chunking: paragraphs are packed up to the target size; a paragraph longer
 * than the target is split on sentence boundaries with the configured overlap.
 */
export function chunkDocument(document: SourceDocument, policy: ChunkingPolicy): DocumentChunk[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const paragraph of document.body.split("\n\n")) {
    const start = document.body.indexOf(paragraph, cursor);
    spans.push({ start, end: start + paragraph.length });
    cursor = start + paragraph.length;
  }

  const ranges: { start: number; end: number }[] = [];
  let current: { start: number; end: number } | null = null;
  for (const span of spans) {
    if (span.end - span.start > policy.targetChars) {
      if (current !== null) {
        ranges.push(current);
        current = null;
      }
      let start = span.start;
      while (start < span.end) {
        let end = Math.min(span.end, start + policy.targetChars);
        if (end < span.end) {
          const sentenceEnd = document.body.lastIndexOf(". ", end);
          if (sentenceEnd > start + policy.overlapChars) end = sentenceEnd + 1;
        }
        ranges.push({ start, end });
        if (end >= span.end) break;
        start = Math.max(end - policy.overlapChars, start + 1);
      }
      continue;
    }
    if (current !== null && span.end - current.start <= policy.targetChars) {
      current = { start: current.start, end: span.end };
    } else {
      if (current !== null) ranges.push(current);
      current = { ...span };
    }
  }
  if (current !== null) ranges.push(current);

  return ranges.map((range, chunkIndex) => {
    const text = document.body.slice(range.start, range.end).trim();
    const content = `${document.title}\n\n${text}`;
    return {
      chunkIndex,
      offsetStart: range.start,
      offsetEnd: range.end,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  });
}
