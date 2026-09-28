import { createClarificationInterruptId } from "../interaction/events.js";
import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import {
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
  type ExecutionManifestRef,
} from "./interrupt-manifest.js";

export const WEATHER_CLARIFICATION_RESPONSE_SCHEMA_REF =
  "weather_clarification_resume@1.0" as const;

export interface CreateClarificationInterruptManifestInput {
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  scopeId: string;
  round: number;
  expectedResponseSchemaRef: string;
  expiryAt: string;
  executionManifest: ExecutionManifestRef;
  now?: Date;
}

export function createClarificationInterruptManifest(
  input: CreateClarificationInterruptManifestInput
): DurableInterruptManifest {
  const now = input.now ?? new Date();
  return parseDurableInterruptManifest({
    interruptId: createClarificationInterruptId(input),
    kind: "clarification",
    runId: input.runId,
    threadId: input.threadId,
    taskId: input.taskId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    scopeId: input.scopeId,
    expectedResponseSchemaRef: input.expectedResponseSchemaRef,
    expiryAt: input.expiryAt,
    executionManifest: input.executionManifest,
    status: "waiting",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

function hasSameBinding(
  persisted: DurableInterruptManifest,
  proposed: DurableInterruptManifest
): boolean {
  return (
    persisted.kind === "clarification" &&
    proposed.kind === "clarification" &&
    persisted.interruptId === proposed.interruptId &&
    persisted.runId === proposed.runId &&
    persisted.threadId === proposed.threadId &&
    persisted.taskId === proposed.taskId &&
    persisted.stepId === proposed.stepId &&
    persisted.scopeId === proposed.scopeId &&
    persisted.expectedResponseSchemaRef ===
      proposed.expectedResponseSchemaRef &&
    JSON.stringify(persisted.executionManifest) ===
      JSON.stringify(proposed.executionManifest)
  );
}

export async function persistClarificationInterruptManifest(
  repository: InterruptManifestRepository,
  proposedValue: DurableInterruptManifest
): Promise<DurableInterruptManifest> {
  const proposed = parseDurableInterruptManifest(proposedValue);
  if (proposed.kind !== "clarification") {
    throw new Error("Clarification manifest kind is required");
  }
  const persisted = await repository.findByInterruptId(proposed.interruptId);
  if (!persisted) return repository.create(proposed);
  if (!hasSameBinding(persisted, proposed)) {
    throw new Error("Clarification interrupt manifest binding conflict");
  }
  return persisted;
}
