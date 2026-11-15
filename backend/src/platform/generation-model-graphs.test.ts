import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GENERATION_MODEL } from "./generation-model-profile.js";

const GRAPH_IDS = ["chatbot", "deep_researcher", "shopping_assistant", "math_agent", "mcp_agent"] as const;
type GraphId = (typeof GRAPH_IDS)[number];

const MODEL_KEYS = [
  "QWEN_CHAT_MODEL", "QWEN_RESEARCH_MODEL", "QWEN_TOOL_MODEL", "QWEN_VISION_MODEL",
  "CHAT_MODEL", "MATH_MODEL", "MCP_AGENT_MODEL", "DEFAULT_MODEL", "SHOPPING_ASSISTANT_MODEL",
] as const;
const PURPOSE_KEYS = ["QWEN_CHAT_MODEL", "QWEN_RESEARCH_MODEL", "QWEN_TOOL_MODEL", "QWEN_VISION_MODEL"] as const;

type CapturedRequest = {
  url: string;
  body: {
    model?: unknown;
    enable_thinking?: unknown;
    messages?: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  };
};
type GraphRunOptions = { scenario?: "tool" | "malformed"; stream?: boolean };

function restoreGraphRun() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
}

/** Structural signature only: keys and primitive types, never values. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]));
  }
  return value === null ? "null" : typeof value;
}

async function runGraph(graphId: GraphId, purposeModel: string | undefined, thinkingDefault = "", options: GraphRunOptions = {}) {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
  vi.stubEnv("LLM_THINKING_DEFAULT_ENABLED", thinkingDefault);
  vi.stubEnv("SHOPPING_ASSISTANT_THINKING_ENABLED", "");
  vi.stubEnv("USAGE_LEDGER_REDIS_URI", "");
  vi.stubEnv("USAGE_LEDGER_TIME_ZONE", "UTC");
  vi.stubEnv("USAGE_PRICE_TABLE_JSON", "[]");
  vi.stubEnv("SHOPPING_ORDER_BINDING_ENABLED", "false");
  vi.stubEnv("MCP_LOAD_ON_START", "false");
  for (const key of MODEL_KEYS) vi.stubEnv(key, "");
  if (purposeModel) for (const key of PURPOSE_KEYS) vi.stubEnv(key, purposeModel);
  vi.resetModules();

  const admission = await import("../runtime/execution-context/graph-task-admission.js");
  vi.spyOn(admission.PgGraphTaskAdmission.prototype, "admit").mockImplementation(async (c) => c.taskId);
  // Substitute persistence only; authorization, dispatch and the calculator stay real.
  const grants = await import("../runtime/authorization/grant-store.js");
  const decisions = await import("../runtime/authorization/decision-store.js");
  vi.spyOn(grants.PgGrantStore.prototype, "findMatching").mockResolvedValue(null);
  vi.spyOn(decisions.PgDecisionStore.prototype, "record").mockResolvedValue(undefined);
  const { calculatorTool } = await import("../tools/calculator.js");
  const calculator = vi.spyOn(calculatorTool, "invoke");
  const requests: CapturedRequest[] = [];
  let generationCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    expect(target).toContain("provider.fixture.test");
    requests.push({ url: target, body: JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"] });
    generationCalls++;
    if (options.scenario === "malformed") return new Response('{"choices":', { status: 200 });
    if (options.scenario === "tool" && generationCalls === 1) {
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        content: null,
        tool_calls: [{ id: "call-fixture", type: "function", function: {
          name: "calculator_tool", arguments: JSON.stringify({ expression: "2+2" }),
        } }],
      } }] });
    }
    const content = graphId === "shopping_assistant"
      ? JSON.stringify({ intent: "unsupported", rationaleCode: "out_of_scope" })
      : graphId === "deep_researcher" && generationCalls === 1
        ? JSON.stringify({ question: "fixture", answerMode: "direct", rationale: "fixture", queries: [], urls: [], requiredSourceCount: 1 })
        : "fixture answer";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200 });
  }));

  const deployment = JSON.parse(readFileSync(new URL("../../langgraph.json", import.meta.url), "utf8")) as { graphs: Record<string, string> };
  const [file, exportName] = deployment.graphs[graphId].split(":");
  const module: Record<string, unknown> = await import(new URL(file.replace(".ts", ".js"), new URL("../../", import.meta.url)).href);
  const graph = module[exportName];
  if (graph === null || typeof graph !== "object" || !("invoke" in graph) || typeof graph.invoke !== "function") {
    throw new Error("registered graph has no invoke");
  }
  const { getUsageRuntime } = await import("./usage/runtime.js");
  const runtime = getUsageRuntime();
  try {
    const input = { messages: [new HumanMessage("fixture question")] };
    const config = {
      configurable: {
        thread_id: crypto.randomUUID(), run_id: crypto.randomUUID(), "x-request-id": crypto.randomUUID(),
        "x-bff-principal-id": "principal-fixture", "x-bff-principal-type": "service",
        "x-bff-tenant-id": "tenant-fixture", "x-bff-roles": "member", "x-bff-scopes": "search:read",
        "x-bff-auth-source": "trusted_gateway", "x-bff-authenticated-at": "2026-11-02T00:00:00.000Z",
        "x-bff-scope-id": "tenant-fixture", "x-bff-scope-type": "tenant",
      },
    };
    const events: unknown[] = [];
    let output: unknown;
    let error: Record<string, unknown> | undefined;
    try {
      if (options.stream) {
        if (!("stream" in graph) || typeof graph.stream !== "function") throw new Error("registered graph has no stream");
        const stream: AsyncIterable<unknown> = await graph.stream(input, { ...config, streamMode: ["updates", "custom"] });
        for await (const event of stream) events.push(JSON.parse(JSON.stringify(event)) as unknown);
      } else {
        output = await graph.invoke(input, config);
      }
    } catch (caught) {
      if (options.scenario !== "malformed" || !(caught instanceof Error)) throw caught;
      // Preserve the actual error's fields, including diagnostic codes; no test-built envelope.
      error = Object.fromEntries(Object.getOwnPropertyNames(caught).map((key) => [key, Reflect.get(caught, key)]));
    }
    return {
      requests, events, error,
      output: output === undefined ? undefined : JSON.parse(JSON.stringify(output)) as unknown,
      toolInputs: calculator.mock.calls.map(([input]) => input),
      toolResults: await Promise.all(calculator.mock.results.map((result) => result.value)),
    };
  } finally {
    await runtime.close();
  }
}

const generation = (requests: CapturedRequest[]) => requests.filter((request) => request.url.endsWith("/chat/completions"));
const nonGeneration = (requests: CapturedRequest[]) => requests.filter((request) => !request.url.endsWith("/chat/completions"));

describe("registered graphs use the configured generation model with thinking off", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  for (const graphId of GRAPH_IDS) {
    it(`${graphId}: defaults to ${DEFAULT_GENERATION_MODEL}, rolls back by configuration only, and keeps the output schema`, async () => {
      const flash = await runGraph(graphId, undefined);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      const rollback = await runGraph(graphId, "qwen3.7-plus");

      expect(generation(flash.requests).length).toBeGreaterThan(0);
      for (const request of generation(flash.requests)) {
        expect(request.body.model).toBe(DEFAULT_GENERATION_MODEL);
        expect(request.body.enable_thinking).toBe(false);
      }

      // 3.2 rollback: only settings change; thinking is still sent explicitly.
      expect(generation(rollback.requests).length).toBe(generation(flash.requests).length);
      for (const request of generation(rollback.requests)) {
        expect(request.body.model).toBe("qwen3.7-plus");
        expect(request.body.enable_thinking).toBe(false);
      }

      // Embedding / rerank traffic, if any, is not affected by the generation model setting.
      expect(nonGeneration(rollback.requests).map((request) => request.body.model))
        .toEqual(nonGeneration(flash.requests).map((request) => request.body.model));

      // "Schema 相同": same fake responses produce structurally identical graph output.
      expect(shape(rollback.output)).toEqual(shape(flash.output));
    }, 120_000);
  }

  it("shopping_assistant keeps thinking off even when the gateway-wide default is on", async () => {
    const run = await runGraph("shopping_assistant", undefined, "true");
    expect(generation(run.requests).length).toBeGreaterThan(0);
    for (const request of generation(run.requests)) expect(request.body.enable_thinking).toBe(false);
  }, 120_000);

  it("mcp_agent preserves executed Tool input/output and stream event contracts across model settings", async () => {
    const flash = await runGraph("mcp_agent", DEFAULT_GENERATION_MODEL, "", { scenario: "tool", stream: true });
    restoreGraphRun();
    const rollback = await runGraph("mcp_agent", "qwen3.7-plus", "", { scenario: "tool", stream: true });

    for (const run of [flash, rollback]) {
      expect(run.toolInputs).toEqual([{ expression: "2+2" }]);
      expect(run.toolResults).toEqual(["4"]);
      expect(generation(run.requests)).toHaveLength(2);
      expect(run.requests[1].body.messages?.filter((message) => message.role === "tool"))
        .toEqual([{ role: "tool", content: "4", tool_call_id: "call-fixture" }]);
      expect(run.events.length).toBeGreaterThan(0);
    }
    expect(generation(flash.requests).every((request) => request.body.model === DEFAULT_GENERATION_MODEL)).toBe(true);
    expect(generation(rollback.requests).every((request) => request.body.model === "qwen3.7-plus")).toBe(true);
    expect(shape(rollback.toolInputs)).toEqual(shape(flash.toolInputs));
    expect(shape(rollback.toolResults)).toEqual(shape(flash.toolResults));
    expect(shape(rollback.requests[1].body.messages?.filter((message) => message.role === "tool")))
      .toEqual(shape(flash.requests[1].body.messages?.filter((message) => message.role === "tool")));

    const eventTypes = (events: unknown[]) => events.map((event) => {
      expect(Array.isArray(event)).toBe(true);
      const [mode, payload] = event as [unknown, unknown];
      expect(payload).toBeTypeOf("object");
      return { mode, types: Object.keys(payload as object) };
    });
    expect(eventTypes(flash.events)).toEqual([
      { mode: "updates", types: ["call_model"] },
      { mode: "updates", types: ["authorization_gate"] },
      { mode: "updates", types: ["physical_dispatch"] },
      { mode: "updates", types: ["call_model"] },
    ]);
    expect(eventTypes(rollback.events)).toEqual(eventTypes(flash.events));
    expect(shape(rollback.events)).toEqual(shape(flash.events));
  });

  it("preserves provider parse error codes and error envelope structure across model settings", async () => {
    const flash = await runGraph("chatbot", DEFAULT_GENERATION_MODEL, "", { scenario: "malformed", stream: true });
    restoreGraphRun();
    const rollback = await runGraph("chatbot", "qwen3.7-plus", "", { scenario: "malformed", stream: true });

    for (const run of [flash, rollback]) {
      expect(run.requests.length).toBeGreaterThan(0);
      expect(run.error).toMatchObject({
        name: "ProviderResponseParseError", code: "llm_response_json_parse_failed",
        errorCode: "JSON_DECODE_INCOMPLETE", decodeKind: "incomplete",
      });
      expect(run.toolInputs).toEqual([]);
    }
    expect(flash.requests[0].body.model).toBe(DEFAULT_GENERATION_MODEL);
    expect(rollback.requests[0].body.model).toBe("qwen3.7-plus");
    expect(rollback.error?.code).toBe(flash.error?.code);
    expect(rollback.error?.errorCode).toBe(flash.error?.errorCode);
    expect(shape(rollback.error)).toEqual(shape(flash.error));
  });
});
