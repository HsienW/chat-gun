import { z } from "zod";

import {
  ORDER_OPERATION_STATES,
  SHOPPING_INTENTS,
  TERMINAL_ORDER_OPERATION_STATES,
} from "../../agents/shopping-assistant/state.js";
import {
  EVAL_CASE_VERSION,
  EVAL_SCORERS,
  EXPECTED_KINDS,
  PROHIBITED_OUTCOMES,
  evalCaseSchema,
  evalDatasetSchema,
  type EvalCase,
  type EvalCaseRejection,
  type EvalCaseRejectionCode,
} from "../../knowledge/evaluation/eval-case.js";

/**
 * Additive minor version of the evaluation-case contract (design §20.2): it
 * adds multi-turn commerce chain cases. eval_case@1 cases keep their exact
 * schema and failure codes; the @1-only reader keeps rejecting chain cases.
 */
export const EVAL_CASE_CHAIN_VERSION = "eval_case@1.1" as const;

export const SUPPORTED_EVAL_CASE_VERSIONS = [EVAL_CASE_VERSION, EVAL_CASE_CHAIN_VERSION] as const;

export const CHAIN_PROHIBITED_OUTCOMES = [
  ...PROHIBITED_OUTCOMES,
  "follows_injected_preapproval",
  "side_effect_without_human_decision",
] as const;

export const CHAIN_SCORERS = [...EVAL_SCORERS, "routing_accuracy", "operation_terminal_state"] as const;

export const CHAIN_EXPECTED_KINDS = [...EXPECTED_KINDS, "chain"] as const;

/** Decisions the harness sends as the test principal; never produced by the model under test. */
export const HUMAN_DECISIONS = ["approve", "deny", "expire", "cancel_before_effect", "none"] as const;

/** Faults injected through the mock order provider of one case. */
export const CHAIN_FAULTS = ["concurrent_duplicate", "response_lost_committed", "response_lost_not_committed"] as const;

const TERMINAL_STATES = ORDER_OPERATION_STATES.filter((state) => TERMINAL_ORDER_OPERATION_STATES.has(state));

const answerExpectationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("answerable"),
      relevantSourceIds: z.array(z.string().min(1)).min(1),
      keyFacts: z.array(z.string().min(1)).min(1),
    })
    .passthrough(),
  z.object({ kind: z.literal("abstain") }).passthrough(),
]);

const operationExpectationSchema = z
  .object({
    orderFixtureId: z.string().min(1),
    humanDecision: z.enum(HUMAN_DECISIONS),
    fault: z.enum(CHAIN_FAULTS).optional(),
    expectedTerminalState: z.enum(TERMINAL_STATES as [string, ...string[]]),
    expectedDedupReason: z.enum(["in_flight_duplicate", "committed_result_reused"]).optional(),
  })
  .passthrough();

const chainTurnExpectationSchema = z
  .object({
    expectedIntent: z.enum(SHOPPING_INTENTS),
    answer: answerExpectationSchema.optional(),
    operation: operationExpectationSchema.optional(),
  })
  .passthrough();

const chainExpectedSchema = z
  .object({ kind: z.literal("chain"), turns: z.array(chainTurnExpectationSchema).min(1) })
  .passthrough();

const chainCaseSchema = evalCaseSchema.extend({
  schemaVersion: z.literal(EVAL_CASE_CHAIN_VERSION),
  input: z
    .object({
      question: z.string().min(1).max(1000),
      language: z.enum(["en", "zh-TW", "zh-CN"]),
      turns: z.array(z.object({ message: z.string().min(1).max(1000) }).passthrough()).min(1),
    })
    .passthrough(),
  expected: chainExpectedSchema,
  prohibitedOutcomes: z.array(z.enum(CHAIN_PROHIBITED_OUTCOMES)),
  scoring: z.object({ scorers: z.array(z.enum(CHAIN_SCORERS)).min(1) }).passthrough(),
});

/** eval_case@1.1 also carries single-turn kinds, with the extended outcome and scorer enums. */
const singleTurnV11Schema = evalCaseSchema.extend({
  schemaVersion: z.literal(EVAL_CASE_CHAIN_VERSION),
  prohibitedOutcomes: z.array(z.enum(CHAIN_PROHIBITED_OUTCOMES)),
  scoring: z.object({ scorers: z.array(z.enum(CHAIN_SCORERS)).min(1) }).passthrough(),
});

export type ChainEvalCase = z.infer<typeof chainCaseSchema>;
export type ChainTurnExpectation = z.infer<typeof chainTurnExpectationSchema>;
export type VersionedEvalCase = EvalCase | ChainEvalCase | z.infer<typeof singleTurnV11Schema>;

export type VersionedEvalCaseRejectionCode =
  | EvalCaseRejectionCode
  | "EVAL_CASE_UNSUPPORTED_SCHEMA_VERSION"
  | "EVAL_CASE_CHAIN_TURN_MISMATCH";

export interface VersionedEvalCaseRejection extends Omit<EvalCaseRejection, "code"> {
  code: VersionedEvalCaseRejectionCode;
}

export interface ParsedVersionedEvalDataset {
  datasetVersion: string;
  corpusVersion: string;
  cases: VersionedEvalCase[];
  rejected: VersionedEvalCaseRejection[];
}

export function isChainCase(item: VersionedEvalCase): item is ChainEvalCase {
  return item.expected.kind === "chain";
}

function knownKinds(version: string): readonly string[] {
  return version === EVAL_CASE_CHAIN_VERSION ? CHAIN_EXPECTED_KINDS : EXPECTED_KINDS;
}

function schemaFor(version: string, kind: unknown) {
  if (version === EVAL_CASE_VERSION) return evalCaseSchema;
  return kind === "chain" ? chainCaseSchema : singleTurnV11Schema;
}

/** A chain case pairs every input turn with one expectation; `question` repeats the first turn. */
function turnsAligned(item: ChainEvalCase): boolean {
  return item.input.turns.length === item.expected.turns.length && item.input.question === item.input.turns[0]?.message;
}

/**
 * Reader for eval_case@1 and eval_case@1.1. Invalid cases are reported, never
 * silently dropped; the order of checks matches the @1 reader so @1 cases get
 * the same failure codes from both readers.
 */
export function parseVersionedEvalDataset(input: unknown): ParsedVersionedEvalDataset {
  const dataset = evalDatasetSchema.parse(input);
  const cases: VersionedEvalCase[] = [];
  const rejected: VersionedEvalCaseRejection[] = [];
  const seen = new Set<string>();
  dataset.cases.forEach((raw, index) => {
    const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const caseId = typeof record.caseId === "string" ? record.caseId : undefined;
    const reject = (code: VersionedEvalCaseRejectionCode, id = caseId) =>
      rejected.push({ index, ...(id ? { caseId: id } : {}), code });
    const version = record.schemaVersion;
    if (typeof version !== "string" || !(SUPPORTED_EVAL_CASE_VERSIONS as readonly string[]).includes(version)) {
      reject("EVAL_CASE_UNSUPPORTED_SCHEMA_VERSION");
      return;
    }
    const kind = (record.expected as { kind?: unknown } | undefined)?.kind;
    if (typeof kind === "string" && !knownKinds(version).includes(kind)) {
      reject("EVAL_CASE_UNKNOWN_EXPECTED_KIND");
      return;
    }
    const parsed = schemaFor(version, kind).safeParse(raw);
    if (!parsed.success) {
      reject("EVAL_CASE_INVALID");
      return;
    }
    const item = parsed.data as VersionedEvalCase;
    if (isChainCase(item) && !turnsAligned(item)) {
      reject("EVAL_CASE_CHAIN_TURN_MISMATCH", item.caseId);
      return;
    }
    if (item.datasetVersion !== dataset.datasetVersion) {
      reject("EVAL_CASE_DATASET_MISMATCH", item.caseId);
      return;
    }
    if (seen.has(item.caseId)) {
      reject("EVAL_CASE_DUPLICATE_ID", item.caseId);
      return;
    }
    seen.add(item.caseId);
    cases.push(item);
  });
  return { datasetVersion: dataset.datasetVersion, corpusVersion: dataset.corpusVersion, cases, rejected };
}
