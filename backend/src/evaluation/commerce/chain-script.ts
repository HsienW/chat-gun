import { z } from "zod";

import type { ShoppingIntentRouteResult } from "../../agents/shopping-assistant/intent-router.js";
import type { PolicyAnswer } from "../../agents/shopping-assistant/policy-answer.js";
import type { ShoppingIntent, ShoppingIntentRationaleCode } from "../../agents/shopping-assistant/state.js";
import type { SourceDocument } from "../../knowledge/corpus.js";
import { KB_SEARCH_RESULT_VERSION, type KbSearchResult } from "../../knowledge/retrieval.js";
import { ORDER_CANCEL_TOOL_NAME, ORDER_REFUND_REQUEST_TOOL_NAME } from "../../tools/orders/order-contracts.js";
import type { ChainEvalCase, ChainTurnExpectation } from "./chain-case.js";

/**
 * Deterministic layer of the chain evaluation (design §20.5): the router, the
 * request models and the policy synthesizer are scripts that return what the
 * case expects, so a run verifies the harness and the operation semantics of
 * the real graph, never a model. Routing accuracy is not measured with them.
 */
export const CHAIN_SCRIPT_VERSION = "chain-eval-script-v1";
export const SCRIPTED_RETRIEVAL_CONFIG_VERSION = "chain-eval-scripted-retrieval-v1";

const INJECTED_CHUNK_SUFFIX = "#injected";

export type ChainScriptErrorCode =
  | "CHAIN_SCRIPT_SOURCE_MISSING"
  | "CHAIN_SCRIPT_AMBIGUOUS_OPERATION"
  | "CHAIN_SCRIPT_NO_OPERATION"
  | "CHAIN_SCRIPT_TURN_MISSING";

export class ChainScriptError extends Error {
  readonly name = "ChainScriptError";

  constructor(readonly code: ChainScriptErrorCode, message: string) {
    super(message);
  }
}

/** One fixed rationale per intent; rationale codes are trace data, never a branch condition. */
const SCRIPTED_RATIONALES: Readonly<Record<ShoppingIntent, ShoppingIntentRationaleCode>> = {
  product_lookup: "asks_product_info",
  policy_question: "asks_policy",
  order_operation: "requests_order_change",
  clarify: "ambiguous",
  unsupported: "out_of_scope",
};

export function scriptedRoute(expectation: Pick<ChainTurnExpectation, "expectedIntent">): ShoppingIntentRouteResult {
  return { status: "routed", intent: expectation.expectedIntent, rationaleCode: SCRIPTED_RATIONALES[expectation.expectedIntent], attempts: 1 };
}

/** Case fixture data the deterministic kb_search returns as retrieved text (decision point 2, option B). */
const injectedRetrievalSchema = z.object({ sourceId: z.string().min(1), text: z.string().min(1) }).strict();

function turnOf(item: ChainEvalCase, turnIndex: number) {
  const input = item.input.turns[turnIndex];
  const expectation = item.expected.turns[turnIndex];
  if (input === undefined || expectation === undefined) {
    throw new ChainScriptError("CHAIN_SCRIPT_TURN_MISSING", `Case ${item.caseId} has no turn ${turnIndex}`);
  }
  return { input, expectation };
}

/**
 * kb_search_result@1 for one turn: one chunk per relevant corpus source, plus
 * the case's injected text; no source for an abstain turn or a turn without an
 * expected answer.
 */
export function scriptedRetrieval(item: ChainEvalCase, turnIndex: number, corpus: readonly SourceDocument[]): KbSearchResult {
  const { input, expectation } = turnOf(item, turnIndex);
  const injectedParse = injectedRetrievalSchema.safeParse((input as Record<string, unknown>).injectedRetrieval);
  const injected = injectedParse.success ? injectedParse.data : undefined;
  const sourceIds = expectation.answer?.kind === "answerable" ? expectation.answer.relevantSourceIds : [];
  const retrieval = {
    mode: "vector_only_configured" as const,
    embeddingSpaceId: CHAIN_SCRIPT_VERSION,
    thresholdVersion: CHAIN_SCRIPT_VERSION,
    configVersion: SCRIPTED_RETRIEVAL_CONFIG_VERSION,
  };
  const blocks = sourceIds.map((sourceId) => {
    const document = corpus.find((candidate) => candidate.sourceId === sourceId);
    if (document === undefined) {
      throw new ChainScriptError("CHAIN_SCRIPT_SOURCE_MISSING", `Source ${sourceId} of case ${item.caseId} is not in the corpus`);
    }
    return { document, chunkId: `${sourceId}#0`, content: document.body };
  });
  if (injected !== undefined) {
    const document = corpus.find((candidate) => candidate.sourceId === injected.sourceId);
    if (document === undefined) {
      throw new ChainScriptError("CHAIN_SCRIPT_SOURCE_MISSING", `Injected source ${injected.sourceId} of case ${item.caseId} is not in the corpus`);
    }
    blocks.push({ document, chunkId: `${injected.sourceId}${INJECTED_CHUNK_SUFFIX}`, content: injected.text });
  }
  if (blocks.length === 0) {
    return { schemaVersion: KB_SEARCH_RESULT_VERSION, outcome: "no_source_found", retrieval: { ...retrieval, candidateCount: 0, passedCount: 0 } };
  }
  return {
    schemaVersion: KB_SEARCH_RESULT_VERSION,
    outcome: "evidence_found",
    citations: blocks.map(({ document, chunkId, content }, index) => ({
      citationId: `c${index + 1}`,
      chunkId,
      sourceId: document.sourceId,
      sourceVersion: 1,
      sourceType: document.sourceType,
      title: document.title,
      offsetStart: 0,
      offsetEnd: Math.max(1, content.length),
    })),
    chunks: blocks.map(({ chunkId, content }, index) => ({
      citationId: `c${index + 1}`,
      chunkId,
      content,
      score: 1 - index / (blocks.length + 1),
    })),
    retrieval: { ...retrieval, candidateCount: blocks.length, passedCount: blocks.length },
  };
}

/** States the expected key facts and cites the relevant corpus chunks, never the injected text. */
export function scriptedPolicyAnswer(
  expectation: ChainTurnExpectation,
  evidence: Extract<KbSearchResult, { outcome: "evidence_found" }>
): PolicyAnswer {
  if (expectation.answer?.kind !== "answerable") return { abstained: true, answer: "" };
  const relevant = new Set(expectation.answer.relevantSourceIds);
  const cited = evidence.citations
    .filter((citation) => relevant.has(citation.sourceId) && !citation.chunkId.endsWith(INJECTED_CHUNK_SUFFIX))
    .map((citation) => `[${citation.citationId}]`);
  if (cited.length === 0) return { abstained: true, answer: "" };
  return { abstained: false, answer: `${expectation.answer.keyFacts.join("; ")} ${cited.join(" ")}` };
}

export interface ScriptedToolCall {
  name: string;
  id: string;
  args: Record<string, unknown>;
}

/** Order change kinds a case names by tag; a case must name exactly one. */
const OPERATION_TOOLS_BY_TAG: Readonly<Record<string, string>> = {
  refund: ORDER_REFUND_REQUEST_TOOL_NAME,
  cancel: ORDER_CANCEL_TOOL_NAME,
};

export function scriptedOrderCall(item: ChainEvalCase, turnIndex: number, toolCallId: string): ScriptedToolCall {
  const { expectation } = turnOf(item, turnIndex);
  if (expectation.operation === undefined) {
    throw new ChainScriptError("CHAIN_SCRIPT_NO_OPERATION", `Turn ${turnIndex} of case ${item.caseId} expects no order change`);
  }
  const tools = item.tags.flatMap((tag) => (OPERATION_TOOLS_BY_TAG[tag] === undefined ? [] : [OPERATION_TOOLS_BY_TAG[tag]]));
  if (tools.length !== 1) {
    throw new ChainScriptError("CHAIN_SCRIPT_AMBIGUOUS_OPERATION", `Case ${item.caseId} must tag exactly one of refund or cancel`);
  }
  return { name: tools[0]!, id: toolCallId, args: { orderId: expectation.operation.orderFixtureId, reasonCode: "other" } };
}
