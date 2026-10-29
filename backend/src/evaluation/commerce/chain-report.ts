import type { ChainCaseResult, ChainEvaluationMode, ChainEvaluationRun, ChainSplitSummary, TurnScore } from "./chain-scoring.js";

/**
 * X42 provenance fields plus the chain-specific ones (design §20.7). Fields a
 * mode does not use are null rather than omitted, so the two modes compare.
 */
export interface ChainEvaluationProvenance {
  datasetVersion: string;
  corpusVersion: string;
  orderFixtureVersion: string;
  split: "dev" | "test" | "all";
  mode: ChainEvaluationMode;
  graphId: string;
  intentPromptVersion: string;
  policyPromptVersion: string;
  embeddingModel: string | null;
  embeddingSpaceId: string | null;
  rerankModel: string | null;
  generationModel: string | null;
  generationTemperature: number | null;
  judgeModel: string | null;
  thresholdVersion: string | null;
  configVersion: string;
  /** Approval timeout of the runtime, and the short one the expiry cases use. */
  confirmationTimeoutMs: { default: number; expireCases: number };
  runCount: number;
  date: string;
  synthetic: true;
}

export function chainResultDirectoryName(datasetVersion: string, mode: ChainEvaluationMode, date: string): string {
  return `${datasetVersion}-${mode}-${date}`;
}

/**
 * An incomplete run is reported but its figures are never published (`retrieval-evaluation`),
 * nor is a run that left rows behind (design §20.5 B1).
 */
export function isChainRunPublishable(run: ChainEvaluationRun): boolean {
  return run.status === "completed" && run.cleanup?.status !== "failed";
}

const figure = (value: number | null) => (value === null ? "—" : value.toFixed(3));
const milliseconds = (value: number | null) => (value === null ? "—" : String(Math.round(value)));

function summaryRows(summary: Record<"dev" | "test" | "all", ChainSplitSummary>): string[] {
  const splits = ["test", "dev", "all"] as const;
  const row = (label: string, value: (split: ChainSplitSummary) => string) =>
    `| ${label} | ${splits.map((split) => value(summary[split])).join(" | ")} |`;
  return [
    `| 指標 | ${splits.join(" | ")} |`,
    `|---|${splits.map(() => "---").join("|")}|`,
    row("題數（完成／通過）", (split) => `${split.cases}（${split.completedCases}／${split.passedCases}）`),
    row("輪數", (split) => String(split.turns)),
    row("路由準確率", (split) => (split.routing.status === "measured" ? figure(split.routing.accuracy) : "not_measured")),
    row("操作 terminal 正確率", (split) => `${figure(split.operationTerminalAccuracy)}（${split.operationTurns} 輪）`),
    row("dedup 原因正確率", (split) => figure(split.dedupReasonAccuracy)),
    row("引用準確率", (split) => figure(split.citationAccuracy)),
    row("正確拒答率", (split) => figure(split.abstentionAccuracy)),
    row("誤拒率", (split) => figure(split.falseAbstentionRate)),
    row("禁止結果次數", (split) => String(split.prohibitedOutcomeViolations)),
    row("延遲 p50／p95（ms）", (split) => `${milliseconds(split.latencyP50Ms)}／${milliseconds(split.latencyP95Ms)}`),
  ];
}

function turnFailures(turn: TurnScore): string[] {
  const reasons: string[] = [];
  if (!turn.route.correct) reasons.push(`route ${turn.route.routeStatus ?? "none"}:${turn.route.actual ?? "null"}≠${turn.route.expected}`);
  if (turn.answer && !turn.answer.correct) reasons.push(`answer ${turn.answer.answerStatus ?? "null"}（預期 ${turn.answer.expectedKind}）`);
  if (turn.operation && !turn.operation.correct) reasons.push(`operation ${turn.operation.actual ?? "null"}≠${turn.operation.expected}`);
  if (turn.operation?.dedupCorrect === false) {
    reasons.push(`dedup ${turn.operation.actualDedupReason ?? "none"}≠${turn.operation.expectedDedupReason ?? "none"}`);
  }
  reasons.push(...turn.prohibitedOutcomes);
  return reasons;
}

function caseRow(result: ChainCaseResult): string {
  if (result.status === "failed") return `| ${result.caseId} | ${result.split} | 未完成 | ${result.errorCode} |`;
  const detail = result.turns
    .map((turn) => {
      const parts = [
        turn.route.actual ?? "null",
        ...(turn.answer ? [turn.answer.answerStatus ?? "null"] : []),
        ...(turn.operation ? [turn.operation.actual ?? "null"] : []),
      ];
      const failures = turnFailures(turn);
      return `T${turn.turnIndex}:${parts.join("/")}${failures.length > 0 ? `（${failures.join("；")}）` : ""}`;
    })
    .join("<br>");
  return `| ${result.caseId} | ${result.split} | ${result.passed ? "通過" : "未通過"} | ${detail} |`;
}

export function renderChainReportMarkdown(run: ChainEvaluationRun, provenance: ChainEvaluationProvenance): string {
  const publishable = isChainRunPublishable(run);
  const lines = [
    `# 鏈路評測報表：${run.datasetVersion}（${run.mode}）`,
    "",
    "> 合成資料聲明：本評測的案例、訂單與知識庫內容全部為合成資料，不含個資，不代表真實顧客或營運數字。",
    "",
    publishable
      ? `- 狀態：completed，可發布。`
      : run.status === "completed"
        ? `- 狀態：completed，但清除失敗，**不可發布**。`
        : `- 狀態：incomplete，**不可發布**。未完成的題目：${run.failedCases.join(", ")}。以下數字只供除錯，不得當作分數。`,
    `- evaluationRunId：\`${run.evaluationRunId}\``,
  ];
  if (run.knowledgeImport?.status === "failed") {
    lines.push(`- kb-v1 匯入失敗（${run.knowledgeImport.errorCode}），沒有執行任何題目。`);
  }
  if (run.cleanup?.status === "failed") {
    lines.push(`- 清除失敗（${run.cleanup.errorCode}）：評測 tenant 的 runtime 或 knowledge 資料可能殘留，需要人工清除。`);
  }
  if (run.mode === "deterministic") {
    lines.push(
      "- deterministic 層：路由、商品模型與政策合成由腳本依案例預期決定，路由準確率與混淆矩陣為 `not_measured`。",
      "  引用與拒答只驗證結構化證據經真實 dispatch 與驗證後的保存，不代表模型品質。",
      "- 檢索內容注入只在 deterministic 層覆蓋（決策點 2 方案 B）；live 層以使用者訊息注入代替。"
    );
  } else {
    lines.push(
      "- live 層：路由、商品模型與政策合成使用真實模型，kb_search 走真實 embedding、rerank 與 knowledge DB。",
      "- 資料隔離（design §20.5 B1）：kb-v1 匯入本次執行的專用評測 tenant，每題使用不同的合成 principal，結束後清除該 tenant 的 runtime 與 knowledge 資料。",
      "- 並行重複的第一筆由 harness 腳本送出，第二筆走受測模型。",
      "- live 層沒有覆蓋「檢索內容注入」（決策點 2 方案 B），只以使用者訊息注入涵蓋。"
    );
  }
  lines.push("", "## 彙總", "", ...summaryRows(run.summary), "");
  if (run.mode === "live" && run.summary.all.routing.status === "measured") {
    const matrix = run.summary.all.routing.confusionMatrix;
    lines.push(
      "## 路由混淆矩陣（列：預期，欄：實際）",
      "",
      `| 預期＼實際 | ${matrix.labels.join(" | ")} |`,
      `|---|${matrix.labels.map(() => "---").join("|")}|`,
      ...matrix.labels.map((label, index) => `| ${label} | ${matrix.counts[index]!.join(" | ")} |`),
      "",
      `route 失敗（不列入矩陣）：${JSON.stringify(matrix.routeFailures)}`,
      ""
    );
  }
  lines.push(
    "## 逐題結果",
    "",
    "| caseId | split | 結果 | 逐輪（路由/回答/操作） |",
    "|---|---|---|---|",
    ...run.results.map(caseRow),
    "",
    "## Provenance",
    "",
    "```json",
    JSON.stringify(provenance, null, 2),
    "```",
    ""
  );
  return lines.join("\n");
}
