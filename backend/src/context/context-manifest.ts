import { createHash } from "node:crypto";

import { ContextPriority, type ContextBlock } from "./context-budget.js";
import type { AgentContextSource } from "./context-source.js";

export type ContextManifestReasonCode =
  | "context_p0_overflow"
  | "context_hard_limit_overflow"
  | "context_config_invalid"
  | "provider_window_unknown"
  | "memory_unavailable"
  | "memory_timeout"
  | "compression_invalid"
  | "estimator_unavailable";

export type ContextCompressionAction =
  | "none"
  | "compressed"
  | "fallback_truncate";

export interface ManifestContextBlock extends ContextBlock {
  source?: AgentContextSource;
  referenceId?: string;
}

export interface ContextManifest {
  schemaVersion: "1.0.0";
  policyVersion: "context-priority-v1";
  sourceRefs: Array<{
    priority: ContextPriority;
    kind: AgentContextSource;
    referenceId: string;
    estimatedTokens: number;
  }>;
  totalTokens: number;
  effectiveLimit: number;
  p0Tokens: number;
  compressionAction: ContextCompressionAction;
  reasonCode?: ContextManifestReasonCode;
}

function manifestReferenceId(
  block: ManifestContextBlock,
  index: number
): string {
  const referenceId = block.referenceId ?? `${block.source ?? "context"}-${index + 1}`;
  if (block.source === "memory") return referenceId;
  return `ref-${createHash("sha256").update(referenceId).digest("hex").slice(0, 16)}`;
}

export function buildContextManifest(input: {
  blocks: readonly ManifestContextBlock[];
  totalTokens: number;
  effectiveLimit: number;
  compressionAction: ContextCompressionAction;
  reasonCode?: ContextManifestReasonCode;
  p0Tokens?: number;
}): ContextManifest {
  const sourceRefs = input.blocks.map((block, index) => ({
    priority: block.priority,
    kind: block.source ?? "active_state",
    referenceId: manifestReferenceId(block, index),
    estimatedTokens: block.estimatedTokens,
  }));
  return {
    schemaVersion: "1.0.0",
    policyVersion: "context-priority-v1",
    sourceRefs,
    totalTokens: input.totalTokens,
    effectiveLimit: input.effectiveLimit,
    p0Tokens: input.p0Tokens ?? input.blocks
      .filter(({ priority }) => priority === ContextPriority.P0)
      .reduce((sum, { estimatedTokens }) => sum + estimatedTokens, 0),
    compressionAction: input.compressionAction,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  };
}
