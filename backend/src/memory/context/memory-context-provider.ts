import {
  ContextPriority,
  type ContextBlock,
} from "../../context/context-budget.js";
import type {
  PrincipalContext,
  RuntimeScope,
} from "../../runtime/authorization/index.js";
import type {
  MemoryGovernanceService,
  MemoryRecallItem,
  RecallMemoryInput,
} from "../governance/memory-governance-service.js";
import type {
  MemoryNamespace,
  MemoryProvenance,
} from "../types.js";

export interface MemoryContextMetadata {
  memoryId: string;
  namespace: MemoryNamespace;
  provenance: MemoryProvenance;
  confidence: number;
  revision: string;
  score: number;
}

export interface MemoryContextBlock extends ContextBlock {
  metadata: MemoryContextMetadata;
}

export interface MemoryRecallBoundary {
  recall(input: RecallMemoryInput): Promise<MemoryRecallItem[]>;
}

export interface MemoryContextRecallInput {
  principal: PrincipalContext;
  scope: RuntimeScope;
  namespace: MemoryNamespace;
  budgetHint?: number;
  signal?: AbortSignal;
  at?: string;
}

function renderMemoryValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

export class MemoryContextProvider {
  constructor(
    private readonly governance: MemoryRecallBoundary | MemoryGovernanceService
  ) {}

  async recall(input: MemoryContextRecallInput): Promise<MemoryContextBlock[]> {
    const recalled = await this.governance.recall({
      principal: input.principal,
      scope: input.scope,
      namespace: input.namespace,
      ...(input.budgetHint === undefined
        ? {}
        : { budgetHint: input.budgetHint }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.at === undefined ? {} : { at: input.at }),
    });
    return recalled.map(({ record, score, estimatedTokens }) => ({
      priority: ContextPriority.P3,
      label: `Long-term memory (${record.memoryType})`,
      content: renderMemoryValue(record.value),
      estimatedTokens,
      metadata: {
        memoryId: record.memoryId,
        namespace: record.namespace,
        provenance: record.provenance,
        confidence: record.confidence,
        revision: record.revision,
        score,
      },
    }));
  }
}
