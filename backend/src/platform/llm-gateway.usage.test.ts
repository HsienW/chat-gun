import { afterEach, describe, expect, it, vi } from "vitest";
import { datePartition } from "./usage/ledger.js";

function configureUsage() {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
  vi.stubEnv("USAGE_LEDGER_REDIS_URI", "");
  vi.stubEnv("USAGE_LEDGER_TIME_ZONE", "Asia/Singapore");
  vi.stubEnv("USAGE_PRICE_TABLE_JSON", JSON.stringify(["qwen", "openai-compatible"].flatMap(provider => ["chat", "vision"].map(callKind => ({
    provider, model: "usage-fixture", callKind, currency: "USD", inputPerMillion: "1", outputPerMillion: "2",
    source: "https://pricing.fixture.test", verifiedAt: "2026-11-02",
  })))));
  vi.resetModules();
}
function response(content: string, input = 3, output = 2, status = 200) {
  return new Response(JSON.stringify({ model: "usage-fixture", choices: [{ message: { content } }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  }), { status, headers: { "content-type": "application/json" } });
}
async function ledger() {
  const { getUsageRuntime } = await import("./usage/runtime.js");
  const runtime = getUsageRuntime();
  await runtime.writer.flush();
  return runtime.store.read(datePartition(new Date(), "Asia/Singapore"));
}

describe("LLM provider response accounting", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

  it("sends the declared Qwen thinking option and an explicit false when the caller omits it", async () => {
    configureUsage();
    const transport = vi.fn(async () => response("answer")); vi.stubGlobal("fetch", transport);
    const { llmGateway, enabledChatModels } = await import("./llm-gateway.js");
    await llmGateway.createChatModel({ model: "usage-fixture", thinkingEnabled: false }).invoke("fixture");
    await llmGateway.createChatModel({ model: "usage-fixture" }).invoke("fixture");
    const calls = vi.mocked(fetch).mock.calls;
    expect(JSON.parse(String(calls[0][1]?.body))).toHaveProperty("enable_thinking", false);
    // switch-generation-to-qwen35-flash D-2: every Qwen generation request carries an explicit value.
    expect(JSON.parse(String(calls[1][1]?.body))).toHaveProperty("enable_thinking", false);
    expect(enabledChatModels([{ purpose: "vision", model: "usage-fixture" }])).toEqual([{ provider: "qwen", model: "usage-fixture", callKind: "vision" }]);
    expect(await ledger()).toMatchObject({ amountMicros: 14 });
  });

  for (const purpose of ["chat", "math", "research", "tool", "vision"] as const) {
    it(`accounts ${purpose} once with trusted graph attribution`, async () => {
      configureUsage();
      vi.stubGlobal("fetch", vi.fn(async () => response("answer")));
      const { llmGateway } = await import("./llm-gateway.js");
      await llmGateway.createChatModel({ model: "usage-fixture", purpose, maxRetries: 0 }).invoke("fixture", { attribution: { graphId: "deep_researcher" } });
      const summary = await ledger();
      expect(summary).toMatchObject({ amountMicros: 7, unpricedCount: 0, currency: "USD" });
      expect(Object.values(summary.byGraphAndKind)).toEqual([{ graphId: "deep_researcher", callKind: purpose === "vision" ? "vision" : "chat", amountMicros: 7, unpricedCount: 0 }]);
    });
  }

  it("accounts repair attempts while preserving the last visible usage_metadata", async () => {
    configureUsage();
    vi.stubEnv("LLM_FALLBACK_ENABLED", "true");
    vi.stubEnv("LLM_FALLBACK_PROVIDERS", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://fallback.fixture.test/v1");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_with_hint");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("not-json")).mockResolvedValueOnce(response('{"ok":true}', 5, 4)));
    const { llmGateway } = await import("./llm-gateway.js");
    const answer = await llmGateway.createChatModelWithFallback({ model: "usage-fixture", maxRetries: 0, responseFormat: { type: "json_object" } })
      .invoke("fixture", { attribution: { graphId: "chatbot" } });
    expect(answer).toMatchObject({ usage_metadata: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } });
    expect(await ledger()).toMatchObject({ amountMicros: 20 });
  });

  it("accounts error responses before retry and does not change missing-run attribution", async () => {
    configureUsage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("failure", 3, 2, 502)).mockResolvedValueOnce(response("success")));
    const { llmGateway } = await import("./llm-gateway.js");
    await llmGateway.createChatModel({ model: "usage-fixture", maxRetries: 1 }).invoke("fixture");
    const summary = await ledger();
    expect(summary.amountMicros).toBe(14);
    expect(Object.values(summary.byGraphAndKind)[0].graphId).toBe("unattributed");
  });

  it("accounts a completed provider response even if cancellation arrives while reading it", async () => {
    configureUsage(); const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const original = response("completed");
      const text = original.text.bind(original);
      original.text = async () => { const body = await text(); controller.abort(); return body; };
      return original;
    }));
    const { llmGateway } = await import("./llm-gateway.js");
    // Delivery may reject on cancellation; billing must retain the provider response either way.
    await llmGateway.createChatModel({ model: "usage-fixture", maxRetries: 0 }).invoke("fixture", { signal: controller.signal, attribution: { graphId: "chatbot" } }).catch(() => undefined);
    expect(controller.signal.aborted).toBe(true);
    expect(await ledger()).toMatchObject({ amountMicros: 7, unpricedCount: 0 });
  });

  it("accounts both primary failure and fallback success, preserving attribution through the invoker chain", async () => {
    configureUsage(); vi.stubEnv("LLM_FALLBACK_ENABLED", "true"); vi.stubEnv("LLM_FALLBACK_PROVIDERS", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://fallback.fixture.test/v1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("failure", 3, 2, 502)).mockResolvedValueOnce(response("success")));
    const { llmGateway } = await import("./llm-gateway.js");
    const model = llmGateway.createChatModelWithFallback({ model: "usage-fixture", maxRetries: 0 });
    const answer = await model.invoke("fixture", { attribution: { graphId: "deep_researcher" } });
    expect(answer.content).toBe("success");
    const summary = await ledger(); expect(summary).toMatchObject({ amountMicros: 14, unpricedCount: 0 });
    expect(Object.values(summary.byGraphAndKind)).toEqual([{ graphId: "deep_researcher", callKind: "chat", amountMicros: 14, unpricedCount: 0 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps every priced attempt when structured repairs and fallback are exhausted", async () => {
    configureUsage(); vi.stubEnv("LLM_FALLBACK_ENABLED", "true"); vi.stubEnv("LLM_FALLBACK_PROVIDERS", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://fallback.fixture.test/v1"); vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_with_hint");
    vi.stubGlobal("fetch", vi.fn(async () => response("not-json")));
    const { llmGateway } = await import("./llm-gateway.js");
    await expect(llmGateway.createChatModelWithFallback({ model: "usage-fixture", maxRetries: 0, responseFormat: { type: "json_object" } })
      .invoke("fixture", { attribution: { graphId: "shopping_assistant" } })).rejects.toBeInstanceOf(Error);
    const attempts = vi.mocked(fetch).mock.calls.length; expect(attempts).toBeGreaterThan(1);
    const summary = await ledger(); expect(summary).toMatchObject({ amountMicros: attempts * 7, unpricedCount: 0 });
    expect(Object.values(summary.byGraphAndKind).map(row => row.graphId)).toEqual(["shopping_assistant"]);
  });

  it("rejects an unpriced runtime model override before calling its provider when a monetary guard is injected", async () => {
    configureUsage(); vi.stubGlobal("fetch", vi.fn(async () => response("answer")));
    const { llmGateway, configureUsageModelValidator } = await import("./llm-gateway.js");
    const { validateMonetaryBudgetConfiguration } = await import("./usage/budget-configuration.js");
    const { getUsageRuntime } = await import("./usage/runtime.js");
    configureUsageModelValidator(model => validateMonetaryBudgetConfiguration(true, getUsageRuntime().prices, [model]));
    expect(() => llmGateway.createChatModel({ model: "unpriced-user-override" })).toThrow("enabled_model_unpriced");
    expect(fetch).not.toHaveBeenCalled();
    await llmGateway.createChatModel({ model: "usage-fixture", maxRetries: 0 }).invoke("fixture");
    expect(fetch).toHaveBeenCalledOnce(); expect(await ledger()).toMatchObject({ amountMicros: 7 });
  });
});
