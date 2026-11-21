import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };

let nodes: typeof import("./deep-researcher.js").deepResearcherWeatherTestInternals;
let gateway: typeof import("../platform/llm-gateway.js");
beforeAll(async () => {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  gateway = await import("../platform/llm-gateway.js");
  nodes = (await import("./deep-researcher.js")).deepResearcherWeatherTestInternals;
}, 60000);

async function analyze(status: number, content = "observed", vision = "", reported?: string, count = 1, fallback = false) {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
  vi.stubEnv("QWEN_VISION_MODEL", vision);
  vi.stubEnv("DEFAULT_MODEL", "");
  vi.stubEnv("LLM_FALLBACK_ENABLED", String(fallback));
  vi.stubEnv("LLM_FALLBACK_PROVIDERS", "ccr");
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(
    JSON.stringify({ model: reported, choices: [{ message: { content } }] }), { status }
  ));
  vi.stubGlobal("fetch", fetch);
  const input = { messages: [new HumanMessage({ content: Array.from({ length: count }, () => image) })], reasoning_model: "qwen-plus" };
  const result = await nodes.analyzeImages(input, {});
  return { result, body: JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("sends the resolved vision model and the image on the wire", async () => {
  const { result, body } = await analyze(200);
  expect(body.messages[0].content).toContainEqual(image);
  expect(body.model).toBe("qwen3.5-flash");
  expect(result).toMatchObject({ imageRecognition: { status: "succeeded", provider: "qwen", model: body.model, imageCount: 1 }, imageObservations: ["observed"] });
});

it("keeps provider failures out of observations", async () => {
  const { result, body } = await analyze(400);
  expect(result.imageObservations).toEqual([]);
  expect(result).toMatchObject({ imageRecognition: { status: "failed", model: body.model, error: expect.stringContaining("image_recognition") } });
});

it("uses the primary vision setting with fallback enabled and reports actual metadata", async () => {
  const resolve = vi.spyOn(gateway, "enabledChatModels");
  const { result, body } = await analyze(200, "two images", "qwen-vl-plus", "served-model", 2, true);
  expect(resolve).toHaveBeenCalledExactlyOnceWith([{ purpose: "vision" }]);
  expect(resolve.mock.results[0]?.value).toHaveLength(2);
  expect(body.model).toBe("qwen-vl-plus");
  expect(result.imageRecognition).toEqual({ status: "succeeded", model: "served-model", provider: "qwen", imageCount: 2 });
});

it.each([false, true])("includes the primary vision provider with fallback enabled=%s", fallback => {
  vi.stubEnv("LLM_PROVIDER", "qwen");
  vi.stubEnv("LLM_FALLBACK_ENABLED", String(fallback));
  vi.stubEnv("LLM_FALLBACK_PROVIDERS", "ccr");
  const models = gateway.enabledChatModels([{ purpose: "vision" }]);
  expect(models).toContainEqual(expect.objectContaining({ provider: gateway.getConfiguredLlmProvider() }));
});

it("degrades empty observations", async () => {
  const { result } = await analyze(200, "  ");
  expect(result).toMatchObject({ imageRecognition: { status: "failed" }, imageObservations: [] });
});

it("accepts a legacy state without imageRecognition and skips vision for text", async () => {
  const create = vi.spyOn(gateway.llmGateway, "createChatModel");
  expect(await nodes.analyzeImages({ messages: [new HumanMessage("text")] }, {})).toEqual({});
  expect(create).not.toHaveBeenCalled();
});

it.each(["timeout", "cancel", "signal"])("handles %s without storing provider content", async mode => {
  const llm = gateway.llmGateway.createChatModel({ purpose: "vision" });
  const controller = new AbortController();
  const error = Object.assign(new Error("data:image/png;base64,private RAW_PROVIDER_DETAIL_SENTINEL"), {
    name: "AbortError", code: mode === "timeout" ? "provider_timeout" : undefined,
  });
  vi.spyOn(llm, "invoke").mockImplementation(async () => {
    if (mode === "signal") controller.abort();
    throw error;
  });
  vi.spyOn(gateway.llmGateway, "createChatModel").mockReturnValue(llm);
  const run = nodes.analyzeImages({ messages: [new HumanMessage({ content: [image] })] }, { signal: controller.signal });
  if (mode !== "timeout") {
    await expect(run).rejects.toBe(error);
    return;
  }
  const result = await run;
  expect(result).toMatchObject({ imageObservations: [], imageRecognition: { status: "failed", error: expect.stringContaining("provider_timeout") } });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/data:image|secret-key|Authorization/);
  expect(serialized).not.toContain("RAW_PROVIDER_DETAIL_SENTINEL");
});

it("aborts a pending provider request at the configured deadline", async () => {
  vi.stubEnv("LLM_FALLBACK_TIMEOUT_MS", "20");
  const llm = gateway.llmGateway.createChatModel({ purpose: "vision" });
  vi.spyOn(llm, "invoke").mockImplementation((_input, options) => new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (!signal || signal.aborted) return reject(signal?.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  vi.spyOn(gateway.llmGateway, "createChatModel").mockReturnValue(llm);
  const result = await nodes.analyzeImages({ messages: [new HumanMessage({ content: [image] })] }, {});
  expect(result).toMatchObject({ imageRecognition: { status: "failed", error: expect.stringContaining("provider_timeout") }, imageObservations: [] });
});
