import {
  structuredToolResultEnvelopeSchema,
  type StructuredToolResultEnvelope,
} from "@gun-ai/harness-contracts";

import {
  executionContextSchema,
  type ExecutionContext,
} from "../execution-context/execution-context.js";
import {
  getToolExecutionTerminationCause,
  type GovernedToolOutcome,
} from "../side-effect/governed-outcome.js";
import type { ExecutionProfileEvidence, ExecutionProfileTerminationCause } from "./execution-profile.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";

export { structuredToolResultEnvelopeSchema } from "@gun-ai/harness-contracts";
export type { StructuredToolResultEnvelope } from "@gun-ai/harness-contracts";

export interface CreateStructuredToolResultInput<TResult> {
  executionContext: ExecutionContext;
  descriptor: RuntimeToolDescriptor<unknown, TResult>;
  outcome: GovernedToolOutcome<TResult>;
  securityEvidence?: ExecutionProfileEvidence;
  terminationCause?: ExecutionProfileTerminationCause;
  emittedAt?: string;
}

export function createStructuredToolResultEnvelope<TResult>(
  input: CreateStructuredToolResultInput<TResult>
): StructuredToolResultEnvelope<TResult> {
  const context = executionContextSchema.parse(input.executionContext);
  if (context.toolCallId === undefined) throw new Error("Structured tool result requires toolCallId");

  const envelope: StructuredToolResultEnvelope<TResult> = {
    schemaVersion: "1.0",
    kind: "tool_result",
    correlation: {
      requestId: context.requestId,
      threadId: context.threadId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      ...(context.stepId ? { stepId: context.stepId } : {}),
    },
    tool: {
      name: input.descriptor.toolName,
      version: input.descriptor.toolVersion,
      riskTier: input.descriptor.riskTier,
      readOnly: input.descriptor.isReadOnly,
    },
    outcome: input.outcome,
    ...(input.securityEvidence ? {
      executionProfileVersion: input.securityEvidence.executionProfileVersion,
      effectiveCapabilities: input.securityEvidence.effectiveCapabilities,
      secretRefsUsed: input.securityEvidence.secretRefsUsed,
      egressDecision: input.securityEvidence.egressDecision,
    } : {}),
    terminationCause: input.terminationCause ?? getToolExecutionTerminationCause(input.outcome),
    emittedAt: input.emittedAt ?? new Date().toISOString(),
  };
  structuredToolResultEnvelopeSchema.parse(envelope);
  return envelope;
}

function outcomeErrorCode<TResult>(
  outcome: Exclude<StructuredToolResultEnvelope<TResult>["outcome"], { type: "succeeded" }>
): string {
  if (outcome.type === "cancelled") return `TOOL_EXECUTION_CANCELLED_${outcome.dispatchState.toUpperCase()}`;
  return outcome.type === "confirmation_required" ? "REQUIRES_CONFIRMATION" : outcome.errorCode;
}

export function toLegacyToolResult<TResult>(envelope: StructuredToolResultEnvelope<TResult>): string {
  if (envelope.outcome.type === "succeeded") {
    return typeof envelope.outcome.result === "string"
      ? envelope.outcome.result
      : JSON.stringify(envelope.outcome.result);
  }
  return `Error: ${envelope.tool.name} failed - ${outcomeErrorCode(envelope.outcome)}`;
}

export function tryToLegacyToolResult(value: unknown): string | undefined {
  const parsed = structuredToolResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return toLegacyToolResult(parsed.data as StructuredToolResultEnvelope<unknown>);
}
