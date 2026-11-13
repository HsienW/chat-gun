import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createGenerationObserver, generationProvenanceSchema, renderGenerationSummary } from "./generation-provenance.js";

const reported = (providerModel: string | null, extra: Record<string, unknown> = {}) =>
  new AIMessage({ content: "answer", response_metadata: { model: "gateway-filled", provider_model: providerModel, ...extra } });

describe("evaluation generation observer", () => {
  it("preserves response identity, binding and invocation options, and deduplicates reported models", async () => {
    const response = reported("actual-revision", { thinking_enabled: false });
    const invoke = vi.fn(async () => response);
    const bindTools = vi.fn(() => ({ invoke }));
    const observer = createGenerationObserver({ generationModels: { chat: "configured" }, llmProvider: "qwen", llmEndpointHost: "example.test", thinkingEnabled: false });
    const model = observer.wrap({ invoke, bindTools });
    const signal = new AbortController().signal;
    expect(await model.invoke("input", { signal })).toBe(response);
    expect(await model.bindTools!([]).invoke("bound", { signal })).toBe(response);
    expect(invoke).toHaveBeenLastCalledWith("bound", { signal });
    expect(bindTools).toHaveBeenCalledWith([], undefined);
    expect(observer.snapshot()).toEqual({ generationModels: { chat: "configured" }, observedProviderModels: ["actual-revision"], observedProviderModelsStatus: "reported", thinkingEnabled: false, llmProvider: "qwen", llmEndpointHost: "example.test" });
    expect(renderGenerationSummary(observer.snapshot())).toContain("thinking=false");
  });

  it("reads only provider_model and never the gateway-filled model", async () => {
    const observer = createGenerationObserver({ generationModels: { tool: "configured" }, llmProvider: "qwen", llmEndpointHost: "example.test", thinkingEnabled: false });
    const model = observer.wrap({ invoke: vi.fn()
      .mockResolvedValueOnce(reported(null))
      .mockResolvedValueOnce(new AIMessage({ content: "", response_metadata: { model: "gateway-filled" } })) });
    await model.invoke([]);
    await model.invoke([]);
    expect(observer.snapshot()).toMatchObject({ observedProviderModels: [], observedProviderModelsStatus: "unreported" });
  });

  it("does not substitute configured models for missing metadata", async () => {
    const observer = createGenerationObserver({ generationModels: { tool: "configured" }, llmProvider: "ccr", llmEndpointHost: "ccr.test", thinkingEnabled: null });
    const model = observer.wrap({ invoke: async () => new AIMessage("no metadata") });
    expect(model.bindTools).toBeUndefined();
    await model.invoke([]);
    expect(observer.snapshot()).toMatchObject({ observedProviderModels: [], observedProviderModelsStatus: "unreported", thinkingEnabled: null });
  });

  it("reports partial when only some responses carry provider_model", async () => {
    const observer = createGenerationObserver({ generationModels: {}, llmProvider: "qwen", llmEndpointHost: "example.test", thinkingEnabled: false });
    const model = observer.wrap({ invoke: vi.fn().mockResolvedValueOnce(reported("revision-a")).mockResolvedValueOnce(reported(null)) });
    await model.invoke([]);
    await model.invoke([]);
    expect(observer.snapshot()).toMatchObject({ observedProviderModels: ["revision-a"], observedProviderModelsStatus: "partial" });
  });

  it.each([new Error("provider error"), new DOMException("cancelled", "AbortError")])("retains only completed observations on rejection", async (failure) => {
    const observer = createGenerationObserver({ generationModels: {}, llmProvider: "qwen", llmEndpointHost: "example.test", thinkingEnabled: false });
    const model = observer.wrap({ invoke: vi.fn().mockResolvedValueOnce(reported("received")).mockRejectedValueOnce(failure) });
    await model.invoke([]);
    await expect(model.invoke([])).rejects.toBe(failure);
    expect(observer.snapshot()).toMatchObject({ observedProviderModels: ["received"], observedProviderModelsStatus: "reported" });
  });

  it("refuses an empty endpoint host", () => {
    expect(() => createGenerationObserver({ generationModels: {}, llmProvider: "qwen", llmEndpointHost: "", thinkingEnabled: false }))
      .toThrow("invalid_configuration:LLM_ENDPOINT");
  });

  it("validates new fields while accepting absent fields in old provenance", () => {
    expect(generationProvenanceSchema.parse({})).toEqual({});
    expect(generationProvenanceSchema.parse({ observedProviderModelsStatus: "partial" })).toEqual({ observedProviderModelsStatus: "partial" });
    expect(generationProvenanceSchema.safeParse({ thinkingEnabled: "false" }).success).toBe(false);
    expect(renderGenerationSummary({})).toContain("未記錄");
  });
});
