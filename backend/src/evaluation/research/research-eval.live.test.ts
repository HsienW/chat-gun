/**
 * Opt-in live Deep Researcher evaluation (research-eval-v1).
 *
 * Usage (from backend/):
 *   RUN_RESEARCH_EVAL=true npm run research:evaluate
 *
 * Optional:
 *   RESEARCH_EVAL_RANKING=rule|rerank   label of the ranking arm (default: rule); rerank also sets
 *                                       DEEP_RESEARCH_SOURCE_RERANK=true for the graph
 *   RESEARCH_EVAL_RUN_LABEL=<dir>       results/<dir> (default: research-eval-v1-<date>-r1)
 *   RESEARCH_EVAL_CASES=ans-01,nos-01   subset for smoke runs; written to RESEARCH_EVAL_SMOKE_OUT
 *                                       (default: <os tmpdir>/research-eval-smoke.json), never to results/
 *   RESEARCH_EVAL_DOH_URL=https://223.5.5.5/resolve
 *                                       resolve egress DNS over HTTPS when a TUN/fake-ip proxy makes
 *                                       every host resolve to 198.18.0.0/15 (docs/troubleshooting.md)
 *
 * Requires QWEN_API_KEY and TAVILY_API_KEY in backend/.env. The graph runs in-process without
 * Postgres: task admission and the authorization decision store are replaced exactly as the
 * existing deep researcher tests do, so tool governance still classifies and authorizes every call.
 * no_source cases stub web_search / web_fetch at the tool boundary; every other case is live.
 */
import { execSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import type { ResearchEvalCase, ResearchEvalStub } from "./dataset.js";
import { loadResearchDataset } from "./dataset.js";
import { renderReport, type ResearchEvalProvenance } from "./report.js";
import { runResearchEvaluation, type AgentTrace, type ResearchRun } from "./runner.js";

vi.mock("../../tools/authorization/tool-authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools/authorization/tool-authorization.js")>();
  const db = {
    async query<TResult extends Record<string, unknown>>() {
      return { rows: [] as TResult[], rowCount: 0 };
    },
  };
  return {
    ...actual,
    createRuntimeToolAuthorizationComposition: () =>
      actual.createRuntimeToolAuthorizationComposition({ profile: "development", db }),
  };
});

const liveEnabled = process.env.RUN_RESEARCH_EVAL?.toLowerCase() === "true";
const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA_DIR = join(BACKEND_ROOT, "data", "research-eval");
const LIVE_TIMEOUT_MS = 90 * 60 * 1_000;

let activeStub: ResearchEvalStub | undefined;

function trustedConfigurable(): Record<string, string> {
  return {
    thread_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    "x-request-id": crypto.randomUUID(),
    "x-bff-principal-id": "research-eval-runner",
    "x-bff-principal-type": "service",
    "x-bff-tenant-id": "research-eval",
    "x-bff-roles": "member",
    "x-bff-scopes": "search:read",
    "x-bff-auth-source": "trusted_gateway",
    "x-bff-authenticated-at": new Date().toISOString(),
    "x-bff-scope-id": "research-eval",
    "x-bff-scope-type": "tenant",
  };
}

/**
 * DNS over HTTPS for hosts whose local resolver returns fake-ip addresses (Clash/sing-box TUN,
 * see docs/troubleshooting.md). Only resolution changes: the egress policy still rejects any
 * non-public answer and still pins the connection to the validated address.
 */
function dohResolver(endpoint: string) {
  return async (hostname: string) => {
    const addresses: { address: string; family: 4 | 6 }[] = [];
    for (const [type, family] of [["A", 4], ["AAAA", 6]] as const) {
      const url = new URL(endpoint);
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", type);
      const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) continue;
      const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
      for (const answer of body.Answer ?? []) {
        if (answer.type === (family === 4 ? 1 : 28)) addresses.push({ address: answer.data, family });
      }
    }
    if (addresses.length === 0) throw new Error(`DoH resolution returned no address for ${hostname}`);
    return addresses;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe.runIf(liveEnabled)("deep researcher live evaluation", () => {
  it(
    "runs research-eval-v1 and writes a versioned result set",
    async () => {
      const ranking = process.env.RESEARCH_EVAL_RANKING?.trim() || "rule";
      vi.stubEnv("OPIK_ENABLED", "false");
      vi.stubEnv("DEEP_RESEARCH_SOURCE_RERANK", ranking === "rerank" ? "true" : "false");

      if (process.env.RESEARCH_EVAL_DOH_URL?.trim()) {
        const { setEgressPolicyTestDependencies } = await import("../../runtime/tool-dispatch/egress-policy.js");
        setEgressPolicyTestDependencies({ resolveDns: dohResolver(process.env.RESEARCH_EVAL_DOH_URL.trim()) });
      }

      const { PgGraphTaskAdmission } = await import("../../runtime/execution-context/graph-task-admission.js");
      vi.spyOn(PgGraphTaskAdmission.prototype, "admit").mockImplementation(async (context) => context.taskId);

      const { webSearchTool } = await import("../../tools/web-search.js");
      const { webFetchTool } = await import("../../tools/web-fetch.js");
      const realSearch = webSearchTool.invoke.bind(webSearchTool);
      const realFetch = webFetchTool.invoke.bind(webFetchTool);
      vi.spyOn(webSearchTool, "invoke").mockImplementation(async (input, config) =>
        activeStub === "empty_search" ? JSON.stringify({ provider: "stub", results: [] }) : realSearch(input, config)
      );
      // empty_search also blocks planner-supplied URLs, otherwise the case would still have sources.
      vi.spyOn(webFetchTool, "invoke").mockImplementation(async (input, config) =>
        activeStub ? "Error: web_fetch failed - 503 Service Unavailable (research-eval stub)" : realFetch(input, config)
      );

      const { deepResearcherGraph } = await import("../../agents/deep-researcher.js");
      const { describeLlmGatewayConfig, resolveModelForPurpose } = await import("../../platform/llm-gateway.js");
      const { messageContentToString } = await import("../../state.js");

      const agent = async (item: ResearchEvalCase, signal: AbortSignal): Promise<AgentTrace> => {
        activeStub = item.stub;
        try {
          const output: unknown = await deepResearcherGraph.invoke(
            { messages: [new HumanMessage(item.question)] },
            { configurable: trustedConfigurable(), signal }
          );
          if (!isRecord(output)) throw new Error("graph returned no state");
          const plan = isRecord(output.plan) ? output.plan : {};
          const fetched = Array.isArray(output.fetchedSources) ? output.fetchedSources.filter(isRecord) : [];
          const extracted = Array.isArray(output.extractedSources) ? output.extractedSources.filter(isRecord) : [];
          const messages = Array.isArray(output.messages) ? output.messages : [];
          return {
            answerMode: typeof plan.answerMode === "string" ? plan.answerMode : undefined,
            queries: Array.isArray(plan.queries) ? plan.queries.map(String) : [],
            searchResultCount: Array.isArray(output.searchResults) ? output.searchResults.length : 0,
            rankedUrls: Array.isArray(output.rankedSources)
              ? output.rankedSources.filter(isRecord).map((source) => String(source.url))
              : [],
            sources: extracted.map((source) => {
              const url = String(source.url);
              const fetchError = fetched.find((candidate) => candidate.url === url)?.fetchError;
              return {
                index: Number(source.index),
                url,
                usable: source.usable === true,
                ...(typeof fetchError === "string" ? { fetchError: fetchError.slice(0, 200) } : {}),
              };
            }),
            answer: messages.length ? messageContentToString(messages.at(-1)) : "",
          };
        } finally {
          activeStub = undefined;
        }
      };

      const loaded = await loadResearchDataset(join(DATA_DIR, "research-eval-v1.json"));
      const caseIds = process.env.RESEARCH_EVAL_CASES?.split(",").map((id) => id.trim()).filter(Boolean);
      const run = await runResearchEvaluation(loaded, agent, {
        ranking,
        caseIds,
        onCase: (observation, index, total) =>
          process.stdout.write(`[research-eval] ${index + 1}/${total} ${observation.caseId} ${observation.status} ${observation.latencyMs}ms mode=${observation.answerMode ?? "-"}\n`),
      });
      expect(run.observations.length).toBeGreaterThan(0);

      if (caseIds?.length) {
        const smokeOut = process.env.RESEARCH_EVAL_SMOKE_OUT?.trim() || join(tmpdir(), "research-eval-smoke.json");
        await writeFile(smokeOut, `${JSON.stringify(run, null, 2)}\n`);
        return;
      }

      const date = new Date().toISOString().slice(0, 10);
      const label = process.env.RESEARCH_EVAL_RUN_LABEL?.trim() || `${loaded.dataset.datasetVersion}-${date}-r1`;
      const outDir = join(DATA_DIR, "results", label);
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `run-${ranking}.json`), `${JSON.stringify(run, null, 2)}\n`);

      const runs: ResearchRun[] = [];
      for (const file of (await readdir(outDir)).filter((name) => /^run-.+\.json$/u.test(name)).sort()) {
        runs.push(JSON.parse(await readFile(join(outDir, file), "utf8")) as ResearchRun);
      }
      const gateway = describeLlmGatewayConfig();
      const researchModel = resolveModelForPurpose("research");
      const provenance: ResearchEvalProvenance = {
        datasetVersion: loaded.dataset.datasetVersion,
        datasetSha256: loaded.sha256,
        runnerVersion: run.runnerVersion,
        rankings: runs.map((candidate) => candidate.ranking),
        llmProvider: String(gateway.provider),
        plannerModel: researchModel,
        synthesisModel: researchModel,
        searchProvider: "Tavily Search API (basic depth, 8 results per query)",
        rerankModel: runs.some((candidate) => candidate.ranking === "rerank")
          ? process.env.KB_RERANK_MODEL?.trim() || "qwen3-rerank"
          : null,
        caseCount: loaded.dataset.cases.length,
        runCount: runs.length,
        date,
        commit: execSync("git rev-parse --short HEAD", { cwd: BACKEND_ROOT }).toString().trim(),
        notes: [
          "Executed in-process via vitest without Postgres: graph task admission and the tool authorization decision store were replaced by no-op test doubles; tool governance, egress policy and the graph itself were unchanged.",
          "no_source cases stub web_search (empty_search: zero results, and planner-supplied URLs unreachable) or web_fetch (fetch_fail: every fetch returns an error) at the tool boundary. All other cases used live Tavily search and live page fetches.",
          "Live web results change over time; reruns will not reproduce identical numbers.",
          ...(process.env.RESEARCH_EVAL_DOH_URL?.trim()
            ? ["The local resolver returned fake-ip (198.18.0.0/15) answers, so egress DNS resolution used DNS over HTTPS (RESEARCH_EVAL_DOH_URL); the public-address check and connection pinning were unchanged."]
            : []),
        ],
      };
      await writeFile(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
      await writeFile(join(outDir, "report.md"), renderReport(runs, provenance));
    },
    LIVE_TIMEOUT_MS
  );
});
