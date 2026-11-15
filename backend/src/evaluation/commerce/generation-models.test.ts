import { HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("commerce generation configuration", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
  it("sends Gun Shop settings for chat, tool and bound calls and records safe provenance", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_BASE_URL", "https://example.test/v1?secret=hidden");
    vi.stubEnv("QWEN_API_KEY", "fake-key");
    vi.stubEnv("SHOPPING_ASSISTANT_MODEL", "configured-model");
    vi.stubEnv("SHOPPING_ASSISTANT_THINKING_ENABLED", "");
    vi.stubEnv("LLM_THINKING_DEFAULT_ENABLED", "true");
    vi.stubEnv("SHOPPING_ASSISTANT_TEMPERATURE", "0.2");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ model: "reported-model", choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }));
    const { createCommerceGenerationModels } = await import("./generation-models.js");
    const models = createCommerceGenerationModels("configured-model");
    await models.chatModel().invoke([new HumanMessage("JSON")]);
    await models.toolModel().invoke([new HumanMessage("request")]);
    await models.toolModel().bindTools!([]).invoke([new HumanMessage("bound")]);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toMatchObject({ model: "configured-model", temperature: 0.2, enable_thinking: false });
    expect(models.observer.snapshot()).toMatchObject({ generationModels: { chat: "configured-model", tool: "configured-model" }, observedProviderModels: ["reported-model"], thinkingEnabled: false, llmEndpointHost: "example.test" });
  });
  it.each([
    { name: "reported", models: ["revision-a", "revision-a"], observed: ["revision-a"], status: "reported" },
    { name: "unreported", models: [undefined, ""], observed: [], status: "unreported" },
    { name: "partial", models: ["revision-a", undefined], observed: ["revision-a"], status: "partial" },
  ])("records $name provider models through the real gateway without counting the filled model", async ({ models: reportedModels, observed, status }) => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_BASE_URL", undefined);
    vi.stubEnv("SHOPPING_ASSISTANT_MODEL", "configured-model");
    vi.stubEnv("SHOPPING_ASSISTANT_THINKING_ENABLED", "");
    const fetchMock = vi.fn();
    for (const model of reportedModels) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        ...(model === undefined ? {} : { model }),
        choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      }), { headers: { "content-type": "application/json" } }));
    }
    vi.stubGlobal("fetch", fetchMock);
    const { createCommerceGenerationModels } = await import("./generation-models.js");
    const generation = createCommerceGenerationModels("configured-model");
    await generation.toolModel().invoke([new HumanMessage("one")]);
    await generation.toolModel().invoke([new HumanMessage("two")]);
    // QWEN_BASE_URL unset: the gateway's built-in default host is recorded, never an empty string.
    expect(generation.observer.snapshot()).toMatchObject({ observedProviderModels: observed, observedProviderModelsStatus: status, llmEndpointHost: "dashscope.aliyuncs.com" });
    expect(generation.observer.snapshot().observedProviderModels).not.toContain("configured-model");
  });
  it("fails on an invalid endpoint before constructing models", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_BASE_URL", "not a url");
    vi.stubEnv("SHOPPING_ASSISTANT_THINKING_ENABLED", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createCommerceGenerationModels } = await import("./generation-models.js");
    expect(() => createCommerceGenerationModels("model")).toThrow(/^invalid_configuration:LLM_BASE_URL$/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["true", "invalid"])("rejects %s before constructing models", async (setting) => {
    vi.stubEnv("SHOPPING_ASSISTANT_THINKING_ENABLED", setting);
    const { createCommerceGenerationModels } = await import("./generation-models.js");
    expect(() => createCommerceGenerationModels("model")).toThrow("invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED");
  });
});
