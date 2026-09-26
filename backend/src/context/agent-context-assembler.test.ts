import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextPriority } from "./context-budget.js";
import { buildAgentContext } from "./agent-context-assembler.js";
import { registerCompressionStrategy } from "./compression-strategy.js";
import { auditLogger } from "../platform/observability.js";
import {
  setSpanManagerForTests,
  type SpanManager,
} from "../platform/tracing/span-manager.js";

const roomyLimits = {
  contextBudgetTotal: 100,
  contextOutputReserveTokens: 10,
  capabilities: { contextWindowTokens: 1_000, maxOutputTokens: 20 },
};

describe("buildAgentContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setSpanManagerForTests(undefined);
  });
  it("orders all sources by priority and includes authorized memory as P3", async () => {
    const recall = vi.fn().mockResolvedValue([
      {
        priority: ContextPriority.P3,
        label: "Long-term memory (preference)",
        content: "concise answers",
        estimatedTokens: 4,
        metadata: { memoryId: "memory-1" },
      },
    ]);
    const assembled = await buildAgentContext({
      sources: [
        { source: "recent_messages", content: "old turn" },
        { source: "current_task", content: "current turn" },
        { source: "system_policy", content: "system" },
      ],
      memoryProvider: { recall },
      memoryRecall: {
        principal: { principalId: "p", tenantId: "t" },
        scope: { scopeId: "s", tenantId: "t" },
        namespace: { principalId: "p", tenantId: "t", scopeId: "s" },
      } as never,
      limits: roomyLimits,
    });

    expect(assembled.blocks.map(({ priority }) => priority)).toEqual([
      ContextPriority.P0,
      ContextPriority.P1,
      ContextPriority.P3,
      ContextPriority.P4,
    ]);
    expect(assembled.manifest.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "memory", referenceId: "memory-1" }),
      ])
    );
  });

  it("compresses P5/P4, then drops whole P3 and P2 blocks before P1", async () => {
    const assembled = await buildAgentContext({
      sources: [
        { source: "system_policy", content: "s" },
        { source: "current_task", content: "q" },
        { source: "active_state", content: "a".repeat(80) },
        { source: "memory", content: "m".repeat(80), referenceId: "m1" },
        { source: "recent_messages", content: "r".repeat(80) },
        { source: "tool_output", content: "t".repeat(80) },
      ],
      limits: {
        contextBudgetTotal: 15,
        contextOutputReserveTokens: 1,
        capabilities: { contextWindowTokens: 100, maxOutputTokens: 1 },
      },
    });

    expect(assembled.exceeded).toBe(false);
    expect(assembled.totalTokens).toBeLessThanOrEqual(15);
    expect(assembled.blocks.map(({ priority }) => priority)).toEqual([
      ContextPriority.P0,
      ContextPriority.P1,
    ]);
    expect(assembled.truncatedBlocks.map(({ priority }) => priority)).toEqual(
      expect.arrayContaining([
        ContextPriority.P2,
        ContextPriority.P3,
        ContextPriority.P4,
        ContextPriority.P5,
      ])
    );
  });

  it("throws a terminal error when P0 alone exceeds the hard limit", async () => {
    const record = vi.spyOn(auditLogger, "record").mockResolvedValue();
    await expect(
      buildAgentContext({
        sources: [{ source: "system_policy", content: "x".repeat(80) }],
        limits: {
          contextBudgetTotal: 2,
          contextOutputReserveTokens: 1,
          capabilities: { contextWindowTokens: 100, maxOutputTokens: 1 },
        },
      })
    ).rejects.toMatchObject({
      code: "context_p0_overflow",
    });
    expect(record).toHaveBeenCalledWith(
      "context.manifest",
      expect.objectContaining({ reasonCode: "context_p0_overflow" }),
      undefined
    );
  });

  it("throws a terminal error when P0 plus P1 cannot fit", async () => {
    await expect(
      buildAgentContext({
        sources: [
          { source: "system_policy", content: "system" },
          { source: "current_task", content: "x".repeat(80) },
        ],
        limits: {
          contextBudgetTotal: 8,
          contextOutputReserveTokens: 1,
          capabilities: { contextWindowTokens: 100, maxOutputTokens: 1 },
        },
      })
    ).rejects.toMatchObject({
      code: "context_hard_limit_overflow",
    });
  });

  it("continues without memory and records the degradation reason", async () => {
    const assembled = await buildAgentContext({
      sources: [
        { source: "system_policy", content: "system" },
        { source: "current_task", content: "task" },
      ],
      memoryProvider: { recall: vi.fn().mockRejectedValue(new Error("store down")) },
      memoryRecall: {} as never,
      limits: roomyLimits,
    });

    expect(assembled.text).toContain("task");
    expect(assembled.manifest.reasonCode).toBe("memory_unavailable");
  });

  it("uses deterministic dropping when compression fails", async () => {
    registerCompressionStrategy({
      name: "throwing-test-strategy",
      compress: () => {
        throw new Error("compression failed");
      },
    });
    const assembled = await buildAgentContext({
      sources: [
        { source: "system_policy", content: "s" },
        { source: "current_task", content: "q" },
        { source: "tool_output", content: "x".repeat(100) },
      ],
      limits: {
        contextBudgetTotal: 12,
        contextOutputReserveTokens: 1,
        capabilities: { contextWindowTokens: 100, maxOutputTokens: 1 },
      },
      compressionStrategy: "throwing-test-strategy",
    });

    expect(assembled.blocks.map(({ priority }) => priority)).toEqual([
      ContextPriority.P0,
      ContextPriority.P1,
    ]);
    expect(assembled.manifest).toMatchObject({
      compressionAction: "fallback_truncate",
      reasonCode: "compression_invalid",
    });
  });

  it("emits only redacted manifest fields to audit and active trace", async () => {
    const record = vi.spyOn(auditLogger, "record").mockResolvedValue();
    const setAttributes = vi.fn();
    const span = {} as ReturnType<SpanManager["getActiveSpan"]>;
    setSpanManagerForTests({
      startSpan: vi.fn(() => span!),
      endSpan: vi.fn(),
      recordException: vi.fn(),
      setAttributes,
      getActiveSpan: vi.fn(() => span),
      withSpan: async (_name, _options, operation) => operation(),
    });

    await buildAgentContext({
      sources: [
        { source: "system_policy", content: "apiKey=top-secret" },
        { source: "current_task", content: "user@example.test" },
      ],
      limits: roomyLimits,
    });

    const payload = record.mock.calls.find(([name]) => name === "context.manifest")?.[1];
    expect(JSON.stringify(payload)).not.toContain("top-secret");
    expect(JSON.stringify(payload)).not.toContain("user@example.test");
    expect(setAttributes).toHaveBeenCalledWith(
      span,
      expect.objectContaining({ "context.policy_version": "context-priority-v1" })
    );
  });

  it("uses byte-based estimates for mixed CJK and emoji content", async () => {
    const content = "你好😀context";
    const assembled = await buildAgentContext({
      sources: [{ source: "current_task", content }],
      limits: roomyLimits,
    });

    expect(assembled.blocks[0]?.estimatedTokens).toBe(
      Math.ceil(Buffer.byteLength(content, "utf8") / 4)
    );
  });

  it("falls back to byte estimates when a configured estimator fails", async () => {
    const content = "fallback😀";
    const assembled = await buildAgentContext({
      sources: [{ source: "current_task", content }],
      limits: roomyLimits,
      tokenEstimator: () => {
        throw new Error("estimator unavailable");
      },
    });

    expect(assembled.blocks[0]?.estimatedTokens).toBe(
      Math.ceil(Buffer.byteLength(content, "utf8") / 4)
    );
    expect(assembled.manifest.reasonCode).toBe("estimator_unavailable");
  });

  it("cancels without contaminating the next assembly", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(buildAgentContext({
      sources: [{ source: "current_task", content: "cancelled" }],
      limits: roomyLimits,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(buildAgentContext({
      sources: [{ source: "current_task", content: "next turn" }],
      limits: roomyLimits,
    })).resolves.toMatchObject({ exceeded: false });
  });
});
