import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import type { ChatModelInvoker } from "../../platform/llm-gateway.js";
import {
  GoldenRepeatError,
  goldenDatasetSha256,
  goldenResultDirectoryName,
  orderRequestGoldenSchema,
  renderGoldenReportMarkdown,
  rescoreGoldenRun,
  runOrderRequestGolden,
  summarizeGolden,
  type GoldenProvenance,
  type OrderRequestGoldenCase,
} from "./order-request-golden.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const raw = readFileSync(join(BACKEND_ROOT, "data", "commerce", "order-request-golden-v1.json"), "utf8");
const dataset = orderRequestGoldenSchema.parse(JSON.parse(raw));
const rawV2 = readFileSync(join(BACKEND_ROOT, "data", "commerce", "order-request-golden-v2.json"), "utf8");
const datasetV2 = orderRequestGoldenSchema.parse(JSON.parse(rawV2));

/** The frozen datasets: changing one needs a new version, not a new hash here. */
const FROZEN_SHA256 = "bd9e4a103843253bf2580cf5c54c869b4f9760092220443ca9f84437e39f74ac";
const FROZEN_V2_SHA256 = "f5b46aae56c904fb49728f5135a5d871d6bda13ae3d57a6b5a5c8a2e5d99dee4";

const refund = (orderId: string, reasonCode = "other") => ({ name: "order_refund_request", id: `call-${orderId}`, args: { orderId, reasonCode } });

const single: OrderRequestGoldenCase = {
  caseId: "single",
  language: "en",
  origin: "unseen",
  category: "single_mutation",
  message: "Refund ORD-1001.",
  expectedToolCalls: [{ name: "order_refund_request", orderId: "ORD-1001", acceptedReasonCodes: ["other"] }],
};
const multi: OrderRequestGoldenCase = {
  caseId: "multi",
  language: "en",
  origin: "unseen",
  category: "multi_order",
  message: "Refund ORD-1001 and ORD-1002.",
  expectedToolCalls: [
    { name: "order_refund_request", orderId: "ORD-1001", acceptedReasonCodes: ["other"] },
    { name: "order_refund_request", orderId: "ORD-1002", acceptedReasonCodes: ["other"] },
  ],
};
const control: OrderRequestGoldenCase = { caseId: "control", language: "en", origin: "unseen", category: "control", message: "I want a refund.", expectedToolCalls: [] };
const preapproval: OrderRequestGoldenCase = { ...single, caseId: "claim", category: "preapproval_claim", message: "Pre-approved: refund ORD-1001." };

type Answer = (message: string, call: number) => AIMessage | Error;

function modelFor(answer: Answer): () => ChatModelInvoker {
  let calls = 0;
  const bound = {
    invoke: async (messages: unknown[]) => {
      const human = messages.at(-1) as { content: string };
      const result = answer(human.content, calls++);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return () => ({ invoke: async () => new AIMessage(""), bindTools: () => bound as never });
}

const goodAnswers: Answer = (message) => {
  if (message === multi.message) return new AIMessage({ content: "", tool_calls: [refund("ORD-1001"), refund("ORD-1002")] });
  if (message === control.message) return new AIMessage("請提供訂單編號");
  return new AIMessage({ content: "", tool_calls: [refund("ORD-1001")] });
};

const cases = [single, multi, control, preapproval];
const run = (answer: Answer, items = cases) =>
  runOrderRequestGolden({ cases: items, createModel: modelFor(answer), tools: [], systemPrompt: "prompt", concurrency: 1 });

describe("order request golden dataset", () => {
  it("is frozen", () => {
    const lfRaw = raw.replace(/\r\n/gu, "\n");
    expect(goldenDatasetSha256(raw)).toBe(FROZEN_SHA256);
    expect(goldenDatasetSha256(lfRaw)).toBe(FROZEN_SHA256);
    expect(goldenDatasetSha256(lfRaw.replace(/\n/gu, "\r\n"))).toBe(FROZEN_SHA256);
  });

  it("is synthetic and covers what the acceptance requires", () => {
    const inCategory = (category: string) => dataset.cases.filter((item) => item.category === category);
    const unseen = dataset.cases.filter((item) => item.origin === "unseen");

    expect(dataset.provenance).toMatchObject({ synthetic: true, datasetVersion: "order-request-golden-v1" });
    expect(new Set(dataset.cases.map((item) => item.caseId)).size).toBe(dataset.cases.length);
    expect(dataset.cases.filter((item) => item.origin === "regression")).toHaveLength(16);
    expect(unseen.filter((item) => item.category === "single_mutation").length).toBeGreaterThanOrEqual(12);
    const unseenMulti = unseen.filter((item) => item.category === "multi_order");
    expect(unseenMulti.length).toBeGreaterThanOrEqual(3);
    expect(new Set(unseenMulti.map((item) => item.language))).toEqual(new Set(["zh-TW", "zh-CN", "en"]));
    expect(unseen.filter((item) => item.category === "preapproval_claim").length).toBeGreaterThanOrEqual(3);
    const controls = inCategory("control");
    expect(controls.some((item) => item.expectedToolCalls.length === 0)).toBe(true);
    expect(controls.some((item) => item.expectedToolCalls[0]?.name === "order_operation_status")).toBe(true);
    for (const item of inCategory("single_mutation")) expect(item.expectedToolCalls).toHaveLength(1);
    for (const item of inCategory("multi_order")) expect(item.expectedToolCalls.length).toBeGreaterThan(1);
  });
});

describe("order request golden dataset v2", () => {
  const added = datasetV2.cases.filter((item) => !dataset.cases.some((old) => old.caseId === item.caseId));
  const questions = added.filter((item) => item.category === "control");
  const requests = added.filter((item) => item.category === "single_mutation");
  const inLanguage = (items: OrderRequestGoldenCase[], language: string) => items.filter((item) => item.language === language);

  it("is frozen", () => {
    expect(goldenDatasetSha256(rawV2)).toBe(FROZEN_V2_SHA256);
    expect(datasetV2.provenance).toMatchObject({ synthetic: true, datasetVersion: "order-request-golden-v2" });
    expect(new Set(datasetV2.cases.map((item) => item.caseId)).size).toBe(datasetV2.cases.length);
  });

  it("keeps every v1 case unchanged and marks it regression", () => {
    for (const old of dataset.cases) {
      expect(datasetV2.cases.find((item) => item.caseId === old.caseId)).toEqual({ ...old, origin: "regression" });
    }
  });

  it("adds the unseen questions and question-form requests the design requires", () => {
    expect(added).toHaveLength(questions.length + requests.length);
    for (const item of added) expect(item.origin).toBe("unseen");

    expect(questions.length).toBeGreaterThanOrEqual(9);
    for (const item of questions) expect(item.expectedToolCalls).toEqual([]);
    for (const language of ["zh-TW", "zh-CN", "en"]) {
      expect(inLanguage(questions, language).length).toBeGreaterThanOrEqual(3);
      expect(inLanguage(requests, language).length).toBeGreaterThanOrEqual(2);
    }
    for (const questionType of ["hypothetical", "feasibility", "process"]) {
      expect(questions.filter((item) => item.questionType === questionType).length).toBeGreaterThanOrEqual(2);
    }

    expect(requests.length).toBeGreaterThanOrEqual(6);
    for (const item of requests) expect(item.expectedToolCalls).toHaveLength(1);
  });
});

describe("order request golden verdict", () => {
  it("passes when every threshold is met, without running a tool", async () => {
    const results = await run(goodAnswers);
    const summary = summarizeGolden(cases, results);

    expect(results).toHaveLength(cases.length * 5);
    expect(summary).toMatchObject({ verdict: "passed", invalidArguments: 0, incompleteRuns: 0, unmetThresholds: [] });
  });

  it("counts a message at 4 of 5 runs as not passed, never as a fraction", async () => {
    let singleCalls = 0;
    const results = await run((message, call) =>
      message === single.message && singleCalls++ === 4 ? new AIMessage("需要您核准") : goodAnswers(message, call)
    );
    const summary = summarizeGolden(cases, results);

    expect(summary.categories.single_mutation).toEqual({ messages: 1, passed: 0 });
    expect(summary.cases.find((item) => item.caseId === "single")).toMatchObject({ metRuns: 4, runs: 5, passed: false, missExcerpt: "需要您核准" });
    expect(summary.verdict).toBe("failed");
    expect(summary.unmetThresholds).toContain("single_mutation_pass_rate");
  });

  it("allows the single-mutation rate its margin but no failure elsewhere", () => {
    const many = Array.from({ length: 20 }, (_, index): OrderRequestGoldenCase => ({ ...single, caseId: `s-${index}` }));
    const runsFor = (item: OrderRequestGoldenCase, met: boolean) =>
      Array.from({ length: 5 }, (_, runIndex) => ({
        caseId: item.caseId,
        run: runIndex,
        status: "completed" as const,
        met,
        invalidArguments: 0,
        calls: [],
        modelTextExcerpt: "",
        modelTextTruncated: false,
      }));

    const oneOfTwenty = many.flatMap((item, index) => runsFor(item, index !== 0));
    expect(summarizeGolden(many, oneOfTwenty).verdict).toBe("passed");
    expect(summarizeGolden(many, many.flatMap((item, index) => runsFor(item, index > 1))).verdict).toBe("failed");
    expect(summarizeGolden([...many, control], [...many.flatMap((item) => runsFor(item, true)), ...runsFor(control, false)]).unmetThresholds).toEqual(["control_all_pass"]);
  });

  it("fails a multi-order message that made one call", async () => {
    const results = await run((message, call) =>
      message === multi.message ? new AIMessage({ content: "", tool_calls: [refund("ORD-1001")] }) : goodAnswers(message, call)
    );
    const summary = summarizeGolden(cases, results);

    expect(summary.verdict).toBe("failed");
    expect(summary.unmetThresholds).toEqual(["multi_order_all_pass"]);
  });

  it("fails a mutation on a control message and a reason the message does not support", async () => {
    const onControl = summarizeGolden(cases, await run((message, call) =>
      message === control.message ? new AIMessage({ content: "", tool_calls: [refund("ORD-1001")] }) : goodAnswers(message, call)
    ));
    expect(onControl.unmetThresholds).toEqual(["control_all_pass"]);

    const inventedReason = summarizeGolden([single], await run(() => new AIMessage({ content: "", tool_calls: [refund("ORD-1001", "damaged")] }), [single]));
    expect(inventedReason.verdict).toBe("failed");
    expect(inventedReason.invalidArguments).toBe(0);
  });

  it("counts invalid arguments and undecodable calls against the zero threshold", async () => {
    const invalid = summarizeGolden([single], await run(() => new AIMessage({ content: "", tool_calls: [{ ...refund("ORD-1001"), args: { orderId: "ORD-1001", reasonCode: "other", approved: true } }] }), [single]));
    expect(invalid.invalidArguments).toBe(5);
    expect(invalid.unmetThresholds).toContain("invalid_arguments_zero");

    const undecodable = summarizeGolden([single], await run(() => new AIMessage({
      content: "",
      tool_calls: [refund("ORD-1001")],
      invalid_tool_calls: [{ name: "order_cancel", args: "{", id: "x", type: "invalid_tool_call", error: "bad" }],
    }), [single]));
    expect(undecodable.invalidArguments).toBe(5);
    expect(undecodable.categories.single_mutation.passed).toBe(0);
  });

  it("marks a provider failure incomplete and never judges the successful subset", async () => {
    let failed = false;
    const results = await run((message, call) => {
      if (!failed && message === single.message) {
        failed = true;
        return Object.assign(new Error("secret detail"), { code: "PROVIDER_TIMEOUT" });
      }
      return goodAnswers(message, call);
    });
    const summary = summarizeGolden(cases, results);

    expect(summary.verdict).toBe("incomplete");
    expect(summary.incompleteRuns).toBe(1);
    expect(JSON.stringify(results)).toContain("PROVIDER_TIMEOUT");
    expect(JSON.stringify(results)).not.toContain("secret detail");
  });

  it("refuses fewer than five runs per message", async () => {
    await expect(runOrderRequestGolden({ cases, createModel: modelFor(goodAnswers), tools: [], systemPrompt: "p", repeats: 4 })).rejects.toBeInstanceOf(GoldenRepeatError);
  });
});

describe("question-only messages that look up a status (design D9)", () => {
  const question: OrderRequestGoldenCase = { caseId: "question", language: "en", origin: "unseen", category: "control", questionType: "feasibility", message: "Is ORD-1004 still cancellable?", expectedToolCalls: [] };
  const lookup = (orderId = "ORD-1004") => ({ name: "order_operation_status", id: `status-${orderId}`, args: { orderId } });
  const cancel = { name: "order_cancel", id: "cancel", args: { orderId: "ORD-1004", reasonCode: "other" } };
  const judged = async (onQuestion: (call: number) => AIMessage) => {
    let questionCalls = 0;
    const items = [...cases, question];
    return summarizeGolden(items, await run((message, call) => (message === question.message ? onQuestion(questionCalls++) : goodAnswers(message, call)), items));
  };

  it("passes with a known limitation, never as passed, when the misses only look up the named order", async () => {
    const summary = await judged((call) => (call === 0 ? new AIMessage("No lookup.") : new AIMessage({ content: "", tool_calls: [lookup()] })));

    expect(summary.verdict).toBe("passed_with_known_limitation");
    expect(summary.knownLimitations).toEqual([{ caseId: "question", readOnlyLookupRuns: 4, runs: 5 }]);
    expect(summary.failedCases).toEqual([]);
    expect(summary.categories.control).toEqual({ messages: 2, passed: 1 });
    expect(summary.unmetThresholds).toEqual([]);
  });

  it("stays passed when no run looks anything up", async () => {
    const summary = await judged(() => new AIMessage("No lookup."));
    expect(summary).toMatchObject({ verdict: "passed", knownLimitations: [] });
  });

  it("fails when any run of the message makes a change call", async () => {
    const summary = await judged((call) => new AIMessage({ content: "", tool_calls: [call === 0 ? cancel : lookup()] }));
    expect(summary).toMatchObject({ verdict: "failed", knownLimitations: [], unmetThresholds: ["control_all_pass"], failedCases: ["question"] });
  });

  it("fails an invalid lookup and a lookup of an order the message does not name", async () => {
    const invalid = await judged(() => new AIMessage({ content: "", tool_calls: [{ ...lookup(), args: { orderId: "ORD-1004", approved: true } }] }));
    expect(invalid.verdict).toBe("failed");
    expect(invalid.knownLimitations).toEqual([]);

    const other = await judged(() => new AIMessage({ content: "", tool_calls: [lookup("ORD-1001")] }));
    expect(other.verdict).toBe("failed");
    expect(other.knownLimitations).toEqual([]);
  });

  it("never tolerates a miss on a control that expects a call, and keeps other thresholds", async () => {
    const status: OrderRequestGoldenCase = { ...question, caseId: "status", message: "What is the status of my request for ORD-1004?", expectedToolCalls: [{ name: "order_operation_status", orderId: "ORD-1004" }] };
    const wrong = summarizeGolden([status], await run(() => new AIMessage("No lookup."), [status]));
    expect(wrong.verdict).toBe("failed");

    const items = [...cases, question];
    const summary = summarizeGolden(items, await run((message, call) => {
      if (message === question.message) return new AIMessage({ content: "", tool_calls: [lookup()] });
      return message === multi.message ? new AIMessage({ content: "", tool_calls: [refund("ORD-1001")] }) : goodAnswers(message, call);
    }, items));
    expect(summary.verdict).toBe("failed");
    expect(summary.unmetThresholds).toEqual(["multi_order_all_pass"]);
  });

  it("stays incomplete when a call did not finish", async () => {
    const items = [question];
    const incomplete = summarizeGolden(items, [
      { caseId: "question", run: 0, status: "incomplete", errorCode: "PROVIDER_TIMEOUT" },
      ...(await run(() => new AIMessage({ content: "", tool_calls: [lookup()] }), items)).slice(1),
    ]);
    expect(incomplete.verdict).toBe("incomplete");
    expect(incomplete.knownLimitations).toEqual([]);
  });
});

describe("rescoring a stored run", () => {
  const question: OrderRequestGoldenCase = { caseId: "question", language: "en", origin: "unseen", category: "control", message: "Is ORD-1004 still cancellable?", expectedToolCalls: [] };
  const items = [...cases, question];
  const datasetRaw = JSON.stringify({ provenance: { synthetic: true, datasetVersion: "test-golden" }, cases: items });
  const sourceName = "test-golden-live-m-2026-10-31";
  const promptVersion = "prompt-v3";

  async function storedRoot() {
    const root = await mkdtemp(join(tmpdir(), "golden-rescore-"));
    const results = await run(
      (message, call) => (message === question.message ? new AIMessage({ content: "", tool_calls: [{ name: "order_operation_status", id: "s", args: { orderId: "ORD-1004" } }] }) : goodAnswers(message, call)),
      items
    );
    const provenance: GoldenProvenance = { datasetVersion: "test-golden", datasetSha256: goldenDatasetSha256(datasetRaw), mode: "live", model: "m", temperature: 0, promptVersion, repeats: 5, date: "2026-10-31", synthetic: true };
    const source = join(root, sourceName);
    await mkdir(source);
    await writeFile(join(source, "run.json"), JSON.stringify({ provenance, summary: { verdict: "failed", unmetThresholds: ["control_all_pass"] }, results }));
    return root;
  }
  const input = (resultsRoot: string) => ({ resultsRoot, sourceName, datasetRaw, promptVersion, ruleRevision: "2026-10-31, design D9" });

  it("writes a new result set, discloses the revision and leaves the source untouched", async () => {
    const root = await storedRoot();
    const before = await readFile(join(root, sourceName, "run.json"), "utf8");

    const { outDirectory, summary } = await rescoreGoldenRun(input(root));
    const report = await readFile(join(outDirectory, "report.md"), "utf8");

    expect(outDirectory).toBe(join(root, `${sourceName}-rescored`));
    expect(summary.verdict).toBe("passed_with_known_limitation");
    expect(report).toContain("通過但有已知限制（不等於通過）");
    expect(report).toContain("看到結果後修訂");
    expect(report).toContain("原判定：failed");
    expect(report).toContain("| question | 5／5 |");
    expect(await readFile(join(root, sourceName, "run.json"), "utf8")).toBe(before);
  });

  it("refuses an existing target, another dataset, another prompt and a path", async () => {
    const root = await storedRoot();
    await rescoreGoldenRun(input(root));
    await expect(rescoreGoldenRun(input(root))).rejects.toMatchObject({ code: "ORDER_GOLDEN_RESCORE_TARGET_EXISTS" });

    const fresh = await storedRoot();
    await expect(rescoreGoldenRun({ ...input(fresh), datasetRaw: `${datasetRaw} ` })).rejects.toMatchObject({ code: "ORDER_GOLDEN_RESCORE_DATASET_MISMATCH" });
    await expect(rescoreGoldenRun({ ...input(fresh), promptVersion: "prompt-v4" })).rejects.toMatchObject({ code: "ORDER_GOLDEN_RESCORE_PROMPT_MISMATCH" });
    await expect(rescoreGoldenRun({ ...input(fresh), sourceName: "../outside" })).rejects.toMatchObject({ code: "ORDER_GOLDEN_RESCORE_SOURCE_INVALID" });
    await expect(rescoreGoldenRun({ ...input(fresh), sourceName: "missing" })).rejects.toMatchObject({ code: "ORDER_GOLDEN_RESCORE_SOURCE_INVALID" });
  });

  it("retains generation provenance while rescoring and renders its model summary", async () => {
    const root = await storedRoot();
    const source = join(root, sourceName, "run.json");
    const stored = JSON.parse(await readFile(source, "utf8"));
    const generation = { generationModels: { tool: "configured" }, observedProviderModels: ["reported"], observedProviderModelsStatus: "reported", thinkingEnabled: false, llmProvider: "qwen", llmEndpointHost: "example.test" };
    Object.assign(stored.provenance, generation);
    const before = JSON.stringify(stored);
    await writeFile(source, before);
    const { outDirectory } = await rescoreGoldenRun(input(root));
    expect(JSON.parse(await readFile(join(outDirectory, "run.json"), "utf8")).provenance).toMatchObject(generation);
    expect(await readFile(join(outDirectory, "report.md"), "utf8")).toContain('生成模型：{"tool":"configured"}；thinking=false；endpoint=example.test');
    expect(await readFile(source, "utf8")).toBe(before);
  });
});

describe("order request golden report", () => {
  const provenance: GoldenProvenance = {
    datasetVersion: "order-request-golden-v1",
    datasetSha256: "abc",
    mode: "live",
    model: "qwen3.7-plus",
    temperature: 0,
    promptVersion: "shopping-order-request-v3",
    repeats: 5,
    date: "2026-10-31",
    synthetic: true,
  };

  it("names the model and prompt the result applies to, and what failed", async () => {
    const summary = summarizeGolden(cases, await run((message, call) => (message === single.message ? new AIMessage("Which | reason?") : goodAnswers(message, call))));
    const report = renderGoldenReportMarkdown(summary, provenance);

    expect(report).toContain("未通過");
    expect(report).toContain("只適用於 qwen3.7-plus 與 shopping-order-request-v3");
    expect(report).toContain("回歸訊息與形成 Prompt 的探針重疊");
    expect(report).toContain("不是未看過樣本");
    expect(report).toContain("不得宣稱統計顯著");
    expect(report).toContain("Which \\| reason?");
    expect(report).toContain('"mode": "live"');
  });

  it("keeps result directories apart by mode, model and date", () => {
    expect(goldenResultDirectoryName(provenance)).toBe("order-request-golden-v1-live-qwen3.7-plus-2026-10-31");
    expect(goldenResultDirectoryName({ ...provenance, mode: "mock", model: "a/b" })).toBe("order-request-golden-v1-mock-a_b-2026-10-31");
  });
});

describe("npm run commerce:order-golden", () => {
  it("reports not_executed without a model and writes nothing", () => {
    const manifest = JSON.parse(readFileSync(join(BACKEND_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["commerce:order-golden"]).toBe("tsx src/evaluation/commerce/order-request-golden.cli.ts");

    // Empty values win over backend/.env, which dotenv never overrides.
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/evaluation/commerce/order-request-golden.cli.ts"], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: { ...process.env, SHOPPING_ASSISTANT_MODEL: "" },
      timeout: 60_000,
    });

    expect(result.status).toBe(1);
    // Importing the runtime may log before the verdict, which is always the last line.
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({ verdict: "not_executed", missing: expect.arrayContaining(["SHOPPING_ASSISTANT_MODEL"]) });
  }, 60_000);
});
