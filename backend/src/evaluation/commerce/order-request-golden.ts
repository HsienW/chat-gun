import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isAIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { messageText } from "../../agents/shopping-assistant/order-branch.js";
import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import {
  ORDER_CANCEL_TOOL_NAME,
  ORDER_OPERATION_STATUS_TOOL_NAME,
  ORDER_REASON_CODES,
  ORDER_REFUND_REQUEST_TOOL_NAME,
  orderCancelInputSchema,
  orderOperationStatusInputSchema,
  orderRefundRequestInputSchema,
} from "../../tools/orders/order-contracts.js";
import { boundedModelText } from "./chain-scoring.js";

/** Calls per message and the single-mutation pass rate the acceptance requires (design D5). */
export const MIN_REPEATS = 5;
export const SINGLE_MUTATION_PASS_RATE = 0.95;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

const expectedCallSchema = z
  .object({
    name: z.enum([ORDER_REFUND_REQUEST_TOOL_NAME, ORDER_CANCEL_TOOL_NAME, ORDER_OPERATION_STATUS_TOOL_NAME]),
    orderId: z.string().min(1),
    acceptedReasonCodes: z.array(z.enum(ORDER_REASON_CODES)).min(1).optional(),
  })
  .strict();

export const GOLDEN_CATEGORIES = ["single_mutation", "multi_order", "preapproval_claim", "control"] as const;
export type GoldenCategory = (typeof GOLDEN_CATEGORIES)[number];

const goldenCaseSchema = z
  .object({
    caseId: z.string().min(1),
    language: z.enum(["zh-TW", "zh-CN", "en"]),
    origin: z.enum(["regression", "unseen"]),
    category: z.enum(GOLDEN_CATEGORIES),
    questionType: z.enum(["hypothetical", "feasibility", "process"]).optional(),
    message: z.string().min(1),
    expectedToolCalls: z.array(expectedCallSchema),
  })
  .strict();
export type OrderRequestGoldenCase = z.infer<typeof goldenCaseSchema>;

export const orderRequestGoldenSchema = z
  .object({
    provenance: z.object({ synthetic: z.literal(true), datasetVersion: z.string().min(1) }).passthrough(),
    cases: z.array(goldenCaseSchema).min(1),
  })
  .strict();
export type OrderRequestGolden = z.infer<typeof orderRequestGoldenSchema>;

/** Line endings differ between checkouts; the frozen content does not. */
export function goldenDatasetSha256(raw: string): string {
  return createHash("sha256").update(raw.replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

const ARGUMENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  [ORDER_REFUND_REQUEST_TOOL_NAME]: orderRefundRequestInputSchema,
  [ORDER_CANCEL_TOOL_NAME]: orderCancelInputSchema,
  [ORDER_OPERATION_STATUS_TOOL_NAME]: orderOperationStatusInputSchema,
};

export interface ObservedCall {
  name: string;
  args: Record<string, unknown>;
  valid: boolean;
}

export type GoldenRunResult =
  | {
      caseId: string;
      run: number;
      status: "completed";
      met: boolean;
      invalidArguments: number;
      calls: ObservedCall[];
      modelTextExcerpt: string;
      modelTextTruncated: boolean;
    }
  | { caseId: string; run: number; status: "incomplete"; errorCode: string };

/** The run must propose exactly the expected calls, in any order, with valid arguments. */
export function callsMeetExpectation(expected: OrderRequestGoldenCase["expectedToolCalls"], calls: readonly ObservedCall[]): boolean {
  if (calls.length !== expected.length || calls.some((call) => !call.valid)) return false;
  const remaining = [...calls];
  return expected.every((want) => {
    const index = remaining.findIndex(
      (call) =>
        call.name === want.name &&
        call.args.orderId === want.orderId &&
        (want.acceptedReasonCodes === undefined || (want.acceptedReasonCodes as readonly unknown[]).includes(call.args.reasonCode))
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}

export interface GoldenCaseSummary {
  caseId: string;
  category: GoldenCategory;
  origin: OrderRequestGoldenCase["origin"];
  language: OrderRequestGoldenCase["language"];
  runs: number;
  metRuns: number;
  incompleteRuns: number;
  passed: boolean;
  /** Model text of a run that missed, for diagnosis. */
  missExcerpt?: string;
}

/** A question-only message whose misses were all status lookups of the order it names (design D9). */
export interface GoldenKnownLimitation {
  caseId: string;
  readOnlyLookupRuns: number;
  runs: number;
}

export type GoldenVerdict = "passed" | "passed_with_known_limitation" | "failed" | "incomplete";

export interface GoldenSummary {
  verdict: GoldenVerdict;
  knownLimitations: GoldenKnownLimitation[];
  /** Passed messages over messages; a message passes only when all of its runs did. */
  categories: Record<GoldenCategory, { messages: number; passed: number }>;
  singleMutationPassRate: number | null;
  invalidArguments: number;
  incompleteRuns: number;
  unmetThresholds: string[];
  failedCases: string[];
  cases: GoldenCaseSummary[];
}

function knownLimitationOf(item: OrderRequestGoldenCase, runs: readonly GoldenRunResult[]): GoldenKnownLimitation | null {
  if (item.category !== "control" || item.expectedToolCalls.length > 0) return null;
  const misses = runs.filter((run) => run.status !== "completed" || !run.met);
  const onlyLookups = misses.every(
    (run) =>
      run.status === "completed" &&
      run.invalidArguments === 0 &&
      run.calls.length > 0 &&
      run.calls.every(
        (call) =>
          call.name === ORDER_OPERATION_STATUS_TOOL_NAME &&
          call.valid &&
          typeof call.args.orderId === "string" &&
          item.message.includes(call.args.orderId)
      )
  );
  return misses.length > 0 && onlyLookups ? { caseId: item.caseId, readOnlyLookupRuns: misses.length, runs: runs.length } : null;
}

export function summarizeGolden(cases: readonly OrderRequestGoldenCase[], results: readonly GoldenRunResult[]): GoldenSummary {
  const knownLimitations = cases.flatMap((item) => knownLimitationOf(item, results.filter((result) => result.caseId === item.caseId)) ?? []);
  const summaries = cases.map((item): GoldenCaseSummary => {
    const runs = results.filter((result) => result.caseId === item.caseId);
    const metRuns = runs.filter((result) => result.status === "completed" && result.met);
    const miss = runs.find((result) => result.status === "completed" && !result.met);
    return {
      caseId: item.caseId,
      category: item.category,
      origin: item.origin,
      language: item.language,
      runs: runs.length,
      metRuns: metRuns.length,
      incompleteRuns: runs.filter((result) => result.status === "incomplete").length,
      passed: runs.length > 0 && metRuns.length === runs.length,
      ...(miss?.status === "completed" ? { missExcerpt: miss.modelTextExcerpt } : {}),
    };
  });
  const categories = Object.fromEntries(
    GOLDEN_CATEGORIES.map((category) => {
      const inCategory = summaries.filter((summary) => summary.category === category);
      return [category, { messages: inCategory.length, passed: inCategory.filter((summary) => summary.passed).length }];
    })
  ) as GoldenSummary["categories"];
  const single = categories.single_mutation;
  const singleMutationPassRate = single.messages === 0 ? null : single.passed / single.messages;
  const invalidArguments = results.reduce((sum, result) => sum + (result.status === "completed" ? result.invalidArguments : 0), 0);
  const incompleteRuns = results.filter((result) => result.status === "incomplete").length;

  const unmetThresholds: string[] = [];
  if (singleMutationPassRate === null || singleMutationPassRate < SINGLE_MUTATION_PASS_RATE) unmetThresholds.push("single_mutation_pass_rate");
  for (const category of ["multi_order", "preapproval_claim", "control"] as const) {
    const tolerated = category === "control" ? knownLimitations.length : 0;
    if (categories[category].passed + tolerated !== categories[category].messages) unmetThresholds.push(`${category}_all_pass`);
  }
  if (invalidArguments > 0) unmetThresholds.push("invalid_arguments_zero");

  // A missing call never leaves a passing subset behind.
  const verdict: GoldenVerdict =
    incompleteRuns > 0 ? "incomplete" : unmetThresholds.length > 0 ? "failed" : knownLimitations.length > 0 ? "passed_with_known_limitation" : "passed";
  const limited = new Set(knownLimitations.map((item) => item.caseId));
  return {
    verdict,
    knownLimitations,
    categories,
    singleMutationPassRate,
    invalidArguments,
    incompleteRuns,
    unmetThresholds,
    failedCases: summaries.filter((summary) => !summary.passed && !limited.has(summary.caseId)).map((summary) => summary.caseId),
    cases: summaries,
  };
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

export class GoldenRepeatError extends Error {
  readonly name = "GoldenRepeatError";
  readonly code = "ORDER_GOLDEN_REPEATS_TOO_FEW";
}

export interface OrderRequestGoldenInput {
  cases: readonly OrderRequestGoldenCase[];
  createModel: () => ChatModelInvoker;
  /** Bound for the model to choose from; never executed. */
  tools: readonly StructuredToolInterface[];
  systemPrompt: string;
  repeats?: number;
  concurrency?: number;
  timeoutMs?: number;
}

async function runOnce(input: OrderRequestGoldenInput, item: OrderRequestGoldenCase, run: number): Promise<GoldenRunResult> {
  try {
    const model = input.createModel();
    if (model.bindTools === undefined) return { caseId: item.caseId, run, status: "incomplete", errorCode: "MODEL_CANNOT_BIND_TOOLS" };
    const response = await model
      .bindTools([...input.tools])
      .invoke([new SystemMessage(input.systemPrompt), new HumanMessage(item.message)], {
        signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    const toolCalls = isAIMessage(response) ? response.tool_calls ?? [] : [];
    const undecodable = isAIMessage(response) ? response.invalid_tool_calls?.length ?? 0 : 0;
    const calls = toolCalls.map((call): ObservedCall => ({
      name: call.name,
      args: call.args ?? {},
      valid: ARGUMENT_SCHEMAS[call.name]?.safeParse(call.args).success === true,
    }));
    const invalidArguments = calls.filter((call) => !call.valid).length + undecodable;
    return {
      caseId: item.caseId,
      run,
      status: "completed",
      met: undecodable === 0 && callsMeetExpectation(item.expectedToolCalls, calls),
      invalidArguments,
      calls,
      ...boundedModelText(messageText(response.content)),
    };
  } catch (error) {
    return { caseId: item.caseId, run, status: "incomplete", errorCode: errorCodeOf(error) };
  }
}

/** Calls the model and nothing else: no Tool runs and no database is opened (design D5). */
export async function runOrderRequestGolden(input: OrderRequestGoldenInput): Promise<GoldenRunResult[]> {
  const repeats = input.repeats ?? MIN_REPEATS;
  if (repeats < MIN_REPEATS) throw new GoldenRepeatError(`Each message needs at least ${MIN_REPEATS} runs`);
  const jobs = input.cases.flatMap((item) => Array.from({ length: repeats }, (_, run) => ({ item, run })));
  const results: GoldenRunResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      results.push(await runOnce(input, job.item, job.run));
    }
  };
  await Promise.all(Array.from({ length: input.concurrency ?? DEFAULT_CONCURRENCY }, worker));
  return results;
}

export interface GoldenProvenance {
  datasetVersion: string;
  datasetSha256: string;
  mode: "live" | "mock";
  model: string;
  temperature: number;
  promptVersion: string;
  repeats: number;
  date: string;
  synthetic: true;
}

export function goldenResultDirectoryName(provenance: Pick<GoldenProvenance, "datasetVersion" | "mode" | "model" | "date">): string {
  return `${provenance.datasetVersion}-${provenance.mode}-${provenance.model.replace(/[^A-Za-z0-9._-]/gu, "_")}-${provenance.date}`;
}

const VERDICT_LABELS: Readonly<Record<GoldenVerdict, string>> = {
  passed: "通過",
  passed_with_known_limitation: "通過但有已知限制（不等於通過）",
  failed: "未通過",
  incomplete: "未完成（有呼叫未完成，不得以成功子集判定）",
};

const tableText = (text: string) => text.replace(/\s+/gu, " ").replace(/\|/gu, "\\|");

export interface GoldenRescoreNote {
  ruleRevision: string;
  originalVerdict: string;
  originalUnmetThresholds: string[];
  sourceDirectory: string;
}

export function renderGoldenReportMarkdown(summary: GoldenSummary, provenance: GoldenProvenance, rescore?: GoldenRescoreNote): string {
  const limited = new Set(summary.knownLimitations.map((item) => item.caseId));
  const failed = summary.cases.filter((item) => !item.passed && !limited.has(item.caseId));
  return [
    `# 訂單請求 Golden 驗收：${provenance.datasetVersion}（${provenance.mode}）`,
    "",
    "> 合成資料聲明：案例與訂單全部為合成資料，不含個資，不代表真實顧客或營運數字。",
    "",
    `- 結果：${VERDICT_LABELS[summary.verdict]}。此結果只適用於 ${provenance.model} 與 ${provenance.promptVersion}。`,
    ...(rescore === undefined
      ? []
      : [
          `- 重新計分：驗收規則是在看到結果後修訂（${rescore.ruleRevision}）。未重新呼叫模型；來源 ${rescore.sourceDirectory}。`,
          `- 原判定：${rescore.originalVerdict}；原未達門檻：${rescore.originalUnmetThresholds.join(", ") || "無"}。`,
        ]),
    `- 溫度 ${provenance.temperature}；每則訊息 ${provenance.repeats} 次；日期 ${provenance.date}。`,
    "- 回歸訊息與形成 Prompt 的探針重疊；小樣本只提供方向性信心，不得宣稱統計顯著或 100% 可靠。",
    "- 回歸訊息已用於形成或修訂 Prompt，不是未看過樣本；未看過的訊息與 Prompt 同一作者，不得宣稱完全獨立。",
    `- 無效參數 ${summary.invalidArguments}；未完成呼叫 ${summary.incompleteRuns}。`,
    ...(summary.unmetThresholds.length > 0 ? [`- 未達門檻：${summary.unmetThresholds.join(", ")}。`] : []),
    "",
    "## 門檻（以訊息為單位）",
    "",
    "| 類別 | 通過／訊息 | 門檻 |",
    "|---|---|---|",
    ...GOLDEN_CATEGORIES.map((category) => {
      const { passed, messages } = summary.categories[category];
      return `| ${category} | ${passed}／${messages} | ${category === "single_mutation" ? `至少 ${SINGLE_MUTATION_PASS_RATE * 100}%` : "全數通過"} |`;
    }),
    "",
    ...(summary.knownLimitations.length > 0
      ? [
          "## 已知限制：只是提問卻查詢狀態",
          "",
          "這些訊息預期不呼叫 Tool。未符合的執行都只查詢訊息指名訂單的狀態，沒有變更呼叫；門檻表的通過數不包含它們。",
          "",
          "| caseId | 唯讀查詢次數／執行 |",
          "|---|---|",
          ...summary.knownLimitations.map((item) => `| ${item.caseId} | ${item.readOnlyLookupRuns}／${item.runs} |`),
          "",
        ]
      : []),
    ...(failed.length > 0
      ? [
          "## 未通過的訊息",
          "",
          "| caseId | 類別 | 符合／執行 | 未完成 | 模型文字摘錄 |",
          "|---|---|---|---|---|",
          ...failed.map((item) => `| ${item.caseId} | ${item.category} | ${item.metRuns}／${item.runs} | ${item.incompleteRuns} | ${tableText(item.missExcerpt ?? "（無）")} |`),
          "",
        ]
      : []),
    "## Provenance",
    "",
    "```json",
    JSON.stringify(provenance, null, 2),
    "```",
    "",
  ].join("\n");
}

export type GoldenRescoreErrorCode =
  | "ORDER_GOLDEN_RESCORE_SOURCE_INVALID"
  | "ORDER_GOLDEN_RESCORE_DATASET_MISMATCH"
  | "ORDER_GOLDEN_RESCORE_PROMPT_MISMATCH"
  | "ORDER_GOLDEN_RESCORE_TARGET_EXISTS";

export class GoldenRescoreError extends Error {
  readonly name = "GoldenRescoreError";

  constructor(readonly code: GoldenRescoreErrorCode, message: string) {
    super(message);
  }
}

const storedRunSchema = z.object({
  provenance: z.object({
    datasetVersion: z.string(),
    datasetSha256: z.string(),
    mode: z.enum(["live", "mock"]),
    model: z.string(),
    temperature: z.number(),
    promptVersion: z.string(),
    repeats: z.number(),
    date: z.string(),
    synthetic: z.literal(true),
  }),
  summary: z.object({ verdict: z.string(), unmetThresholds: z.array(z.string()) }),
  results: z.array(
    z.discriminatedUnion("status", [
      z.object({
        caseId: z.string(),
        run: z.number(),
        status: z.literal("completed"),
        met: z.boolean(),
        invalidArguments: z.number(),
        calls: z.array(z.object({ name: z.string(), args: z.record(z.unknown()), valid: z.boolean() })),
        modelTextExcerpt: z.string(),
        modelTextTruncated: z.boolean(),
      }),
      z.object({ caseId: z.string(), run: z.number(), status: z.literal("incomplete"), errorCode: z.string() }),
    ])
  ),
});

export interface RescoreGoldenInput {
  resultsRoot: string;
  /** A directory name under resultsRoot, never a path. */
  sourceName: string;
  datasetRaw: string;
  promptVersion: string;
  ruleRevision: string;
}

/**
 * Judges a stored run again under a revised rule without calling the model, so a
 * revision can never become a retry (design D9). The source is left untouched.
 */
export async function rescoreGoldenRun(input: RescoreGoldenInput): Promise<{ outDirectory: string; summary: GoldenSummary }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.sourceName)) {
    throw new GoldenRescoreError("ORDER_GOLDEN_RESCORE_SOURCE_INVALID", "--rescore takes a result directory name");
  }
  let stored: z.infer<typeof storedRunSchema>;
  try {
    stored = storedRunSchema.parse(JSON.parse(await readFile(join(input.resultsRoot, input.sourceName, "run.json"), "utf8")));
  } catch {
    throw new GoldenRescoreError("ORDER_GOLDEN_RESCORE_SOURCE_INVALID", "The source result set is missing or invalid");
  }
  if (stored.provenance.datasetSha256 !== goldenDatasetSha256(input.datasetRaw)) {
    throw new GoldenRescoreError("ORDER_GOLDEN_RESCORE_DATASET_MISMATCH", "The source was not produced from this dataset");
  }
  if (stored.provenance.promptVersion !== input.promptVersion) {
    throw new GoldenRescoreError("ORDER_GOLDEN_RESCORE_PROMPT_MISMATCH", "The source was not produced by the current prompt");
  }

  const dataset = orderRequestGoldenSchema.parse(JSON.parse(input.datasetRaw));
  const summary = summarizeGolden(dataset.cases, stored.results);
  const rescore: GoldenRescoreNote = {
    ruleRevision: input.ruleRevision,
    originalVerdict: stored.summary.verdict,
    originalUnmetThresholds: stored.summary.unmetThresholds,
    sourceDirectory: input.sourceName,
  };
  const outDirectory = join(input.resultsRoot, `${input.sourceName}-rescored`);
  try {
    await mkdir(outDirectory);
  } catch {
    throw new GoldenRescoreError("ORDER_GOLDEN_RESCORE_TARGET_EXISTS", "The rescored result set already exists or cannot be created");
  }
  await writeFile(join(outDirectory, "run.json"), `${JSON.stringify({ provenance: stored.provenance, rescore, summary, results: stored.results }, null, 2)}\n`);
  await writeFile(join(outDirectory, "report.md"), renderGoldenReportMarkdown(summary, stored.provenance, rescore));
  return { outDirectory, summary };
}
