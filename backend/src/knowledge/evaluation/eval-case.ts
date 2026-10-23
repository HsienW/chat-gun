import { z } from "zod";

/**
 * Versioned evaluation-case contract. It is a deliberate subset of the X35 evaluation contract:
 * unknown fields are preserved so later versions can extend cases without breaking this reader.
 */
export const EVAL_CASE_VERSION = "eval_case@1" as const;

export const PROHIBITED_OUTCOMES = [
  "unresolvable_citation",
  "confident_answer_on_abstain",
  "answer_without_citation",
  "follows_injected_instruction",
  "non_kb_tool_call",
] as const;

export const EVAL_SCORERS = [
  "recall_at_5",
  "mrr",
  "citation_accuracy",
  "abstention",
  "faithfulness",
] as const;

export const EXPECTED_KINDS = ["answerable", "abstain"] as const;

const answerableSchema = z
  .object({
    kind: z.literal("answerable"),
    relevantSourceIds: z.array(z.string().min(1)).min(1),
    relevantChunkIds: z.array(z.string().min(1)).optional(),
    /** Short facts a faithful answer must state; used by model-assisted scoring and manual review. */
    keyFacts: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

const abstainSchema = z.object({ kind: z.literal("abstain") }).passthrough();

export const evalCaseSchema = z
  .object({
    schemaVersion: z.literal(EVAL_CASE_VERSION),
    caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    datasetVersion: z.string().min(1),
    split: z.enum(["dev", "test"]),
    input: z
      .object({
        question: z.string().min(1).max(1000),
        language: z.enum(["en", "zh-TW", "zh-CN"]),
      })
      .passthrough(),
    expected: z.discriminatedUnion("kind", [answerableSchema, abstainSchema]),
    prohibitedOutcomes: z.array(z.enum(PROHIBITED_OUTCOMES)),
    scoring: z.object({ scorers: z.array(z.enum(EVAL_SCORERS)).min(1) }).passthrough(),
    provenance: z
      .object({
        synthetic: z.literal(true),
        createdAt: z.string().min(1),
        method: z.string().min(1),
      })
      .passthrough(),
    sensitivityClass: z.string().min(1),
    tags: z.array(z.string().min(1)),
  })
  .passthrough();

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalDatasetSchema = z
  .object({
    datasetVersion: z.string().min(1),
    corpusVersion: z.string().min(1),
    synthetic: z.literal(true),
    createdAt: z.string().min(1),
    cases: z.array(z.unknown()),
  })
  .passthrough();

export type EvalCaseRejectionCode = "EVAL_CASE_UNKNOWN_EXPECTED_KIND" | "EVAL_CASE_INVALID" | "EVAL_CASE_DATASET_MISMATCH" | "EVAL_CASE_DUPLICATE_ID";

export interface EvalCaseRejection {
  index: number;
  caseId?: string;
  code: EvalCaseRejectionCode;
}

export interface ParsedEvalDataset {
  datasetVersion: string;
  corpusVersion: string;
  cases: EvalCase[];
  rejected: EvalCaseRejection[];
}

/** Parses a dataset; invalid cases are reported, never silently dropped from the report. */
export function parseEvalDataset(input: unknown): ParsedEvalDataset {
  const dataset = evalDatasetSchema.parse(input);
  const cases: EvalCase[] = [];
  const rejected: EvalCaseRejection[] = [];
  const seen = new Set<string>();
  dataset.cases.forEach((raw, index) => {
    const caseId = typeof (raw as { caseId?: unknown })?.caseId === "string" ? (raw as { caseId: string }).caseId : undefined;
    const kind = (raw as { expected?: { kind?: unknown } })?.expected?.kind;
    if (typeof kind === "string" && !(EXPECTED_KINDS as readonly string[]).includes(kind)) {
      rejected.push({ index, ...(caseId ? { caseId } : {}), code: "EVAL_CASE_UNKNOWN_EXPECTED_KIND" });
      return;
    }
    const parsed = evalCaseSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ index, ...(caseId ? { caseId } : {}), code: "EVAL_CASE_INVALID" });
      return;
    }
    if (parsed.data.datasetVersion !== dataset.datasetVersion) {
      rejected.push({ index, caseId: parsed.data.caseId, code: "EVAL_CASE_DATASET_MISMATCH" });
      return;
    }
    if (seen.has(parsed.data.caseId)) {
      rejected.push({ index, caseId: parsed.data.caseId, code: "EVAL_CASE_DUPLICATE_ID" });
      return;
    }
    seen.add(parsed.data.caseId);
    cases.push(parsed.data);
  });
  return { datasetVersion: dataset.datasetVersion, corpusVersion: dataset.corpusVersion, cases, rejected };
}
