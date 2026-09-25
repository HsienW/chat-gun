import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import type {
  MemoryContextProvider,
  MemoryContextRecallInput,
} from "../memory/context/memory-context-provider.js";
import { auditLogger } from "../platform/observability.js";
import { getSpanManager } from "../platform/tracing/span-manager.js";
import type { LlmCapabilities } from "../platform/llm-gateway.js";
import { compressBlocks } from "./compression-strategy.js";
import {
  ContextPriority,
  allocateBudget,
  createDefaultBudgetConfig,
  estimateTokens,
  type ContextBlock,
} from "./context-budget.js";
import { ContextHardLimitError } from "./context-errors.js";
import {
  buildContextManifest,
  type ContextCompressionAction,
  type ContextManifest,
  type ContextManifestReasonCode,
  type ManifestContextBlock,
} from "./context-manifest.js";
import { resolveEffectiveContextLimit } from "./context-limit.js";
import {
  toContextItem,
  type ContextSection,
} from "./context-source.js";

export interface AgentContextLimits {
  contextBudgetTotal: number;
  contextOutputReserveTokens: number;
  capabilities: Pick<LlmCapabilities, "contextWindowTokens" | "maxOutputTokens">;
}

export interface BuildAgentContextInput {
  executionContext?: ExecutionContext;
  sources: readonly ContextSection[];
  memoryProvider?: Pick<MemoryContextProvider, "recall">;
  memoryRecall?: MemoryContextRecallInput;
  limits: AgentContextLimits;
  signal?: AbortSignal;
  compressionStrategy?: string;
  tokenEstimator?: (content: string) => number;
}

export interface AssembledAgentContext {
  text: string;
  blocks: ManifestContextBlock[];
  totalTokens: number;
  truncatedBlocks: ManifestContextBlock[];
  exceeded: boolean;
  manifest: ContextManifest;
}

function formatBlocks(blocks: readonly ContextBlock[]): string {
  return blocks.map(({ label, content }) => `## ${label}\n${content}`).join("\n\n");
}

function renderedTokens(
  blocks: readonly ContextBlock[],
  estimator: (content: string) => number = estimateTokens
): number {
  return blocks.length === 0 ? 0 : estimator(formatBlocks(blocks));
}

function blockKey(block: ContextBlock): string {
  const sourced = block as ManifestContextBlock;
  return [block.priority, block.label, sourced.referenceId ?? "", block.content].join("\u0000");
}

function removedBlocks(
  original: readonly ManifestContextBlock[],
  retained: readonly ManifestContextBlock[]
): ManifestContextBlock[] {
  const remaining = new Map<string, number>();
  for (const block of retained) {
    const key = blockKey(block);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return original.filter((block) => {
    const key = blockKey(block);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function blocksMatch(
  left: readonly ManifestContextBlock[],
  right: readonly ManifestContextBlock[]
): boolean {
  return left.length === right.length && left.every((block, index) =>
    blockKey(block) === blockKey(right[index]) &&
    block.estimatedTokens === right[index].estimatedTokens
  );
}

async function recallMemory(
  input: BuildAgentContextInput
): Promise<{ blocks: ManifestContextBlock[]; reasonCode?: ContextManifestReasonCode }> {
  if (!input.memoryProvider || !input.memoryRecall) return { blocks: [] };
  try {
    const recalled = await input.memoryProvider.recall({
      ...input.memoryRecall,
      budgetHint: Math.max(1, Math.floor(input.limits.contextBudgetTotal / 4)),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      blocks: recalled.map((block) => ({
        ...block,
        source: "memory",
        referenceId: block.metadata.memoryId,
      })),
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const isTimeout = error instanceof Error && /timeout/i.test(error.name + error.message);
    return { blocks: [], reasonCode: isTimeout ? "memory_timeout" : "memory_unavailable" };
  }
}

async function emitManifest(
  manifest: ContextManifest,
  executionContext?: ExecutionContext
): Promise<void> {
  await auditLogger.record("context.manifest", { ...manifest }, executionContext);
  const span = getSpanManager().getActiveSpan();
  if (span) {
    getSpanManager().setAttributes(span, {
      "context.policy_version": manifest.policyVersion,
      "context.compression_action": manifest.compressionAction,
      "context.total_tokens": manifest.totalTokens,
      "context.effective_limit": manifest.effectiveLimit,
      "context.p0_tokens": manifest.p0Tokens,
      ...(manifest.reasonCode ? { "context.reason_code": manifest.reasonCode } : {}),
    });
  }
}

export async function buildAgentContext(
  input: BuildAgentContextInput
): Promise<AssembledAgentContext> {
  input.signal?.throwIfAborted();
  let estimatorUnavailable = false;
  let tokenEstimator = input.tokenEstimator ?? estimateTokens;
  const safeEstimate = (content: string): number => {
    try {
      const value = tokenEstimator(content);
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (content.length > 0 && value === 0)
      ) {
        throw new TypeError("Token estimator returned an invalid value.");
      }
      return value;
    } catch {
      estimatorUnavailable = true;
      tokenEstimator = estimateTokens;
      return estimateTokens(content);
    }
  };
  const sourceBlocks: ManifestContextBlock[] = input.sources.map((section) => {
    const item = toContextItem(section);
    return { ...item, estimatedTokens: safeEstimate(item.content) };
  });
  let resolved: ReturnType<typeof resolveEffectiveContextLimit>;
  try {
    resolved = resolveEffectiveContextLimit(
      input.limits,
      input.limits.capabilities
    );
  } catch (error) {
    if (!(error instanceof ContextHardLimitError)) throw error;
    const manifest = buildContextManifest({
      blocks: sourceBlocks,
      totalTokens: renderedTokens(sourceBlocks, safeEstimate),
      effectiveLimit: 0,
      compressionAction: "none",
      reasonCode: error.code,
      p0Tokens: renderedTokens(
        sourceBlocks.filter(({ priority }) => priority === ContextPriority.P0),
        safeEstimate
      ),
    });
    await emitManifest(manifest, input.executionContext);
    throw error;
  }
  const memory = await recallMemory(input);
  const original = [
    ...sourceBlocks,
    ...memory.blocks.map((block) => ({
      ...block,
      estimatedTokens: safeEstimate(block.content),
    })),
  ].sort(
    (left, right) => left.priority - right.priority
  );
  const p0Tokens = renderedTokens(
    original.filter(({ priority }) => priority === ContextPriority.P0),
    safeEstimate
  );
  const allocation = allocateBudget(
    original,
    createDefaultBudgetConfig({ totalTokenBudget: resolved.effectiveLimit })
  );
  if (allocation.exceeded || p0Tokens > resolved.effectiveLimit) {
    const error = new ContextHardLimitError(
      "context_p0_overflow",
      "System policy exceeds the effective context limit.",
      { p0Tokens, effectiveLimit: resolved.effectiveLimit }
    );
    await emitManifest(buildContextManifest({
      blocks: original,
      totalTokens: renderedTokens(original, safeEstimate),
      effectiveLimit: resolved.effectiveLimit,
      compressionAction: "none",
      reasonCode: error.code,
      p0Tokens,
    }), input.executionContext);
    throw error;
  }

  let blocks = original;
  let compressionAction: ContextCompressionAction = "none";
  let compressionReason: ContextManifestReasonCode | undefined;
  if (renderedTokens(blocks, safeEstimate) > resolved.effectiveLimit) {
    try {
      const compressed = compressBlocks(
        [...blocks],
        resolved.effectiveLimit,
        input.compressionStrategy
      ).map((block) => ({
        ...block,
        estimatedTokens: safeEstimate(block.content),
      })) as ManifestContextBlock[];
      compressionAction = blocksMatch(blocks, compressed) ? "none" : "compressed";
      blocks = compressed;
    } catch {
      blocks = [...original];
      compressionAction = "fallback_truncate";
      compressionReason = "compression_invalid";
    }
  }
  for (const priority of [
    ContextPriority.P5,
    ContextPriority.P4,
    ContextPriority.P3,
    ContextPriority.P2,
  ]) {
    if (renderedTokens(blocks, safeEstimate) <= resolved.effectiveLimit) break;
    blocks = blocks.filter((block) => block.priority !== priority);
  }

  const finalTotal = renderedTokens(blocks, safeEstimate);
  if (finalTotal > resolved.effectiveLimit) {
    const error = new ContextHardLimitError(
      "context_hard_limit_overflow",
      "System policy and current task exceed the effective context limit.",
      { totalTokens: finalTotal, effectiveLimit: resolved.effectiveLimit }
    );
    await emitManifest(buildContextManifest({
      blocks,
      totalTokens: finalTotal,
      effectiveLimit: resolved.effectiveLimit,
      compressionAction,
      reasonCode: error.code,
      p0Tokens,
    }), input.executionContext);
    throw error;
  }
  const truncatedBlocks = removedBlocks(original, blocks);
  const reasonCode =
    compressionReason ??
    memory.reasonCode ??
    (estimatorUnavailable ? "estimator_unavailable" : undefined) ??
    resolved.reasonCode;
  const manifest = buildContextManifest({
    blocks,
    totalTokens: finalTotal,
    effectiveLimit: resolved.effectiveLimit,
    compressionAction,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    p0Tokens,
  });
  await emitManifest(manifest, input.executionContext);
  return {
    text: formatBlocks(blocks),
    blocks,
    totalTokens: finalTotal,
    truncatedBlocks,
    exceeded: false,
    manifest,
  };
}
