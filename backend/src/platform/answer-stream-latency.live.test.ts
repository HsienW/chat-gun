import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import { createAnswerTextSink } from "./answer-text-sink.js";

/**
 * Opt-in measurement for Task 3.1 (design D8, OQ3): first visible fragment latency, gaps between
 * fragments and total time on the configured endpoint, through the real Gateway streaming path.
 * Evidence holds timings, counts and usage only; never answer text, prompts or credentials.
 *
 *   RUN_ANSWER_STREAM_LATENCY_PROBE=true npx vitest run --config vitest.live.config.ts \
 *     src/platform/answer-stream-latency.live.test.ts
 */
const RUNS = Number(process.env.ANSWER_STREAM_LATENCY_RUNS ?? "5");
const EVIDENCE_PATH = resolve("..", ".agent-runtime", "stream-chat-answer-text", "artifacts", "task3-1-latency-ccr.json");

const PROMPT = [
  "請用繁體中文寫一段約 500 字的純文字說明，主題是「為什麼聊天介面要逐段顯示回答」。",
  "不要使用 Markdown、清單或標題，不要呼叫工具，直接輸出正文。",
].join("\n");

type RunEvidence = {
  run: number;
  status: "completed" | "failed";
  errorName?: string;
  errorCode?: string;
  firstFragmentMs?: number;
  totalMs: number;
  fragmentCount: number;
  maxGapMs?: number;
  p95GapMs?: number;
  answerLength: number;
  finishReason?: unknown;
  answerStreamed?: unknown;
  providerModel?: unknown;
  inputTokens?: number;
  outputTokens?: number;
};

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Reads one field of an unknown value without a type assertion. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

it.skipIf(process.env.RUN_ANSWER_STREAM_LATENCY_PROBE !== "true")(
  "measures answer streaming latency on the configured endpoint",
  async () => {
    const { llmGateway, getEffectiveLlmEndpoint } = await import("./llm-gateway.js");
    const { getAgentRuntimeConfig } = await import("./runtime-config.js");
    const endpoint = getEffectiveLlmEndpoint();
    const config = getAgentRuntimeConfig();
    const runs: RunEvidence[] = [];

    for (let run = 1; run <= RUNS; run += 1) {
      const fragmentTimes: number[] = [];
      let answerLength = 0;
      const sink = createAnswerTextSink({
        messageId: `latency-probe-${run}`,
        publish: ({ delta }) => {
          fragmentTimes.push(performance.now());
          answerLength += delta.length;
        },
        observer: { recordMetric: () => undefined },
      });
      const startedAt = performance.now();
      try {
        const message = await llmGateway.createChatModel({ maxRetries: 0 }).invoke(PROMPT, { answerTextSink: sink });
        const gaps = fragmentTimes.slice(1).map((time, index) => time - (fragmentTimes[index] ?? time));
        const usage = field(message, "usage_metadata");
        const metadata = field(message, "response_metadata");
        runs.push({
          run,
          status: "completed",
          firstFragmentMs: round(fragmentTimes[0] === undefined ? undefined : fragmentTimes[0] - startedAt),
          totalMs: Math.round(performance.now() - startedAt),
          fragmentCount: fragmentTimes.length,
          maxGapMs: round(gaps.length ? Math.max(...gaps) : undefined),
          p95GapMs: round(percentile(gaps, 95)),
          answerLength,
          finishReason: field(metadata, "finish_reason"),
          answerStreamed: field(metadata, "answer_streamed"),
          providerModel: field(metadata, "provider_model"),
          inputTokens: numberOrUndefined(field(usage, "input_tokens")),
          outputTokens: numberOrUndefined(field(usage, "output_tokens")),
        });
      } catch (error) {
        const record = error as { name?: unknown; code?: unknown };
        runs.push({
          run,
          status: "failed",
          errorName: typeof record.name === "string" ? record.name : "UnknownError",
          errorCode: typeof record.code === "string" ? record.code : undefined,
          totalMs: Math.round(performance.now() - startedAt),
          fragmentCount: fragmentTimes.length,
          answerLength,
        });
      }
    }

    const completed = runs.filter((entry) => entry.status === "completed");
    const firsts = completed.flatMap((entry) => (entry.firstFragmentMs === undefined ? [] : [entry.firstFragmentMs]));
    const evidence = {
      kind: "answer-stream-latency-probe",
      measuredAt: new Date().toISOString(),
      endpoint: { provider: endpoint.provider, endpointHost: endpoint.endpointHost },
      limitsUnderTest: {
        llmStreamFirstChunkTimeoutMs: config.llmStreamFirstChunkTimeoutMs,
        llmStreamIdleTimeoutMs: config.llmStreamIdleTimeoutMs,
        llmStreamTotalDeadlineMs: config.llmStreamTotalDeadlineMs,
        llmStreamMaxPendingBytes: config.llmStreamMaxPendingBytes,
      },
      summary: {
        runs: runs.length,
        completed: completed.length,
        firstFragmentMs: { min: firsts.length ? Math.min(...firsts) : null, p50: percentile(firsts, 50) ?? null, max: firsts.length ? Math.max(...firsts) : null },
        maxGapMs: Math.max(0, ...completed.map((entry) => entry.maxGapMs ?? 0)),
        maxTotalMs: Math.max(0, ...completed.map((entry) => entry.totalMs)),
      },
      runs,
    };
    await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
    await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

    expect(completed.length).toBeGreaterThan(0);
  },
  600_000,
);
