import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatModelInvoker } from "./llm-gateway.js";
import {
  FallbackChatModelInvoker,
  ProviderExhaustedError,
  type FallbackObservability,
  type ModelFallbackPolicy,
} from "./llm-fallback.js";

const policy: ModelFallbackPolicy = {
  primaryProvider: "ccr",
  fallbackProviders: ["qwen", "openai-compatible"],
  maxTotalAttempts: 3,
  repairStrategy: "retry_once",
  perProviderTimeoutMs: 30_000,
};

function createObserver() {
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const observer: FallbackObservability = {
    recordMetric: async (name, payload) => {
      metrics.push({ name, payload });
    },
    recordAudit: async (name, payload) => {
      audits.push({ name, payload });
    },
  };
  return { observer, metrics, audits };
}

function invoker(invoke: ChatModelInvoker["invoke"]): ChatModelInvoker {
  return { invoke };
}

describe("FallbackChatModelInvoker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes a provider 5xx failure to the next provider and records observability", async () => {
    const { observer, metrics, audits } = createObserver();
    const primary = vi.fn(async () => {
      throw Object.assign(new Error("primary unavailable"), { statusCode: 502 });
    });
    const fallback = vi.fn(async () => new AIMessage("fallback success"));
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: invoker(primary) },
        { provider: "qwen", invoker: invoker(fallback) },
      ],
      policy,
      observer
    );

    const response = await model.invoke("ping");

    expect(response.content).toBe("fallback success");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(metrics.some(({ name }) => name === "model.fallback.attempt")).toBe(true);
    expect(audits[0]).toMatchObject({
      name: "model.fallback.attempt",
      payload: {
        fromProvider: "ccr",
        toProvider: "qwen",
        reason: "provider_unavailable",
      },
    });
  });

  it("throws ProviderExhaustedError with attempted providers and honors the total budget", async () => {
    const { observer, metrics } = createObserver();
    const failing = () =>
      invoker(async () => {
        throw Object.assign(new Error("unavailable"), { statusCode: 503 });
      });
    const third = vi.fn(async () => new AIMessage("must not run"));
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: failing() },
        { provider: "qwen", invoker: failing() },
        { provider: "openai-compatible", invoker: invoker(third) },
      ],
      { ...policy, maxTotalAttempts: 2 },
      observer
    );

    const error = await model.invoke("ping").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderExhaustedError);
    expect((error as ProviderExhaustedError).attempts.map(({ provider }) => provider)).toEqual([
      "ccr",
      "qwen",
    ]);
    expect(third).not.toHaveBeenCalled();
    expect(metrics.some(({ name }) => name === "modelFallbackExhausted")).toBe(true);
  });

  it("aborts a timed-out provider before trying the fallback", async () => {
    vi.useFakeTimers();
    let primaryAborted = false;
    const primary = invoker(
      async (_input, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            primaryAborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const fallback = invoker(async () => new AIMessage("after timeout"));
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: primary },
        { provider: "qwen", invoker: fallback },
      ],
      { ...policy, perProviderTimeoutMs: 50 },
      createObserver().observer
    );

    const responsePromise = model.invoke("ping");
    await vi.advanceTimersByTimeAsync(50);

    await expect(responsePromise).resolves.toMatchObject({
      content: "after timeout",
    });
    expect(primaryAborted).toBe(true);
  });

  it("does not fallback for a refusal", async () => {
    const fallback = vi.fn(async () => new AIMessage("must not run"));
    const refusal = Object.assign(new Error("request refused"), {
      code: "content_filter_refusal",
    });
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: invoker(async () => Promise.reject(refusal)) },
        { provider: "qwen", invoker: invoker(fallback) },
      ],
      policy,
      createObserver().observer
    );

    await expect(model.invoke("ping")).rejects.toBe(refusal);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not fallback for a Tool argument decode failure", async () => {
    const fallback = vi.fn(async () => new AIMessage("must not run"));
    const decodeFailure = Object.assign(new Error("safe decode failure"), {
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "incomplete",
    });
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: invoker(async () => Promise.reject(decodeFailure)) },
        { provider: "qwen", invoker: invoker(fallback) },
      ],
      policy,
      createObserver().observer
    );

    await expect(model.invoke("ping")).rejects.toBe(decodeFailure);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for an invalid provider response envelope", async () => {
    const invalidEnvelope = Object.assign(new Error("invalid envelope"), {
      name: "ProviderEnvelopeValidationError",
      code: "PROVIDER_ENVELOPE_INVALID",
    });
    const fallback = vi.fn(async () => new AIMessage("fallback success"));
    const model = new FallbackChatModelInvoker(
      [
        { provider: "ccr", invoker: invoker(async () => Promise.reject(invalidEnvelope)) },
        { provider: "qwen", invoker: invoker(fallback) },
      ],
      policy,
      createObserver().observer
    );

    await expect(model.invoke("ping")).resolves.toMatchObject({
      content: "fallback success",
    });
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
