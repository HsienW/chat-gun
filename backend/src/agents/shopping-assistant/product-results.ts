import { isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

import { kbSearchResultSchema, type KbSearchResult } from "../../knowledge/retrieval.js";
import { structuredToolResultEnvelopeSchema } from "../../runtime/tool-dispatch/structured-tool-result.js";
import type { CardEmission } from "./card-events.js";

export const PRODUCT_RESULT_CARD_TYPE = "product_result";
export const PRODUCT_RESULT_VERSION = "product_result@1";
const SNIPPET_MAX_CHARS = 280;

export const productResultCardSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_RESULT_VERSION),
    citationId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceVersion: z.number().int().positive(),
    title: z.string(),
    snippet: z.string().max(SNIPPET_MAX_CHARS + 1),
  })
  .strict();
export type ProductResultCard = z.infer<typeof productResultCardSchema>;

/** kb_search reports its own typed failures as a JSON result outside kb_search_result@1. */
const kbSearchFailureSchema = z
  .object({
    schemaVersion: z.literal("kb_search_result@1"),
    outcome: z.literal("error"),
    errorCode: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type KbSearchToolOutcome =
  | { kind: "evidence_found"; result: Extract<KbSearchResult, { outcome: "evidence_found" }> }
  | { kind: "no_source_found" }
  | { kind: "failed"; errorCode: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the governed result of one kb_search call. Only a dispatch envelope is
 * accepted; anything that is not a validated kb_search_result@1 is a failure.
 */
export function readKbSearchOutcome(
  messages: readonly BaseMessage[],
  toolCallId: string
): KbSearchToolOutcome {
  const message = messages.find(
    (candidate) => isToolMessage(candidate) && candidate.tool_call_id === toolCallId
  );
  if (message === undefined || typeof message.content !== "string") {
    return { kind: "failed", errorCode: "KB_SEARCH_RESULT_MISSING" };
  }
  const envelope = structuredToolResultEnvelopeSchema.safeParse(parseJson(message.content));
  if (!envelope.success) {
    const failure = z.object({ errorCode: z.string().min(1) }).safeParse(parseJson(message.content));
    return { kind: "failed", errorCode: failure.success ? failure.data.errorCode : "KB_SEARCH_RESULT_INVALID" };
  }
  const outcome = envelope.data.outcome;
  if (outcome.type !== "succeeded") {
    return {
      kind: "failed",
      errorCode: "errorCode" in outcome && typeof outcome.errorCode === "string"
        ? outcome.errorCode
        : outcome.type === "cancelled" ? "TOOL_EXECUTION_CANCELLED" : "KB_SEARCH_RESULT_INVALID",
    };
  }
  const payload = typeof outcome.result === "string" ? parseJson(outcome.result) : outcome.result;
  const result = kbSearchResultSchema.safeParse(payload);
  if (result.success) {
    return result.data.outcome === "evidence_found"
      ? { kind: "evidence_found", result: result.data }
      : { kind: "no_source_found" };
  }
  const failure = kbSearchFailureSchema.safeParse(payload);
  return { kind: "failed", errorCode: failure.success ? failure.data.errorCode : "KB_SEARCH_RESULT_INVALID" };
}

function snippet(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  return normalized.length <= SNIPPET_MAX_CHARS ? normalized : `${normalized.slice(0, SNIPPET_MAX_CHARS)}…`;
}

/**
 * One card per product source, from its highest-ranked chunk. Every field comes
 * from the structured citation and chunk, never from generated text.
 */
export function buildProductCards(
  result: Extract<KbSearchResult, { outcome: "evidence_found" }>
): ProductResultCard[] {
  const citations = new Map(result.citations.map((citation) => [citation.citationId, citation]));
  const cards: ProductResultCard[] = [];
  const seenSources = new Set<string>();
  for (const chunk of result.chunks) {
    const citation = citations.get(chunk.citationId);
    if (citation === undefined || citation.sourceType !== "product" || seenSources.has(citation.sourceId)) continue;
    seenSources.add(citation.sourceId);
    cards.push(
      productResultCardSchema.parse({
        schemaVersion: PRODUCT_RESULT_VERSION,
        citationId: citation.citationId,
        sourceId: citation.sourceId,
        sourceVersion: citation.sourceVersion,
        title: citation.title,
        snippet: snippet(chunk.content),
      })
    );
  }
  return cards;
}

export function toCardEmissions(cards: readonly ProductResultCard[]): CardEmission[] {
  return cards.map((card) => ({ cardType: PRODUCT_RESULT_CARD_TYPE, data: card }));
}
