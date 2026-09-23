import { z } from "zod";

import { TOOL_RISK_TIERS } from "../authorization/tool-risk.js";
import {
  executionContextSchema,
  type ExecutionContext,
} from "../execution-context/execution-context.js";
import type { GovernedToolOutcome } from "../side-effect/governed-outcome.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";

const dispatchStateSchema = z.enum(["before", "after", "unknown"]);

const governedToolOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("succeeded"), result: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("rejected_before_dispatch"),
      errorCode: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("denied_by_authorization"),
      errorCode: z.string().min(1),
      decisionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("confirmation_required"),
      decisionId: z.string().min(1),
      descriptor: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed_not_committed"),
      errorCode: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("ambiguous_after_dispatch"),
      errorCode: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelled"),
      dispatchState: dispatchStateSchema,
    })
    .strict(),
]);

export const structuredToolResultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    kind: z.literal("tool_result"),
    correlation: z
      .object({
        requestId: z.string().min(1),
        threadId: z.string().min(1),
        runId: z.string().min(1),
        toolCallId: z.string().min(1),
        stepId: z.string().min(1).optional(),
      })
      .strict(),
    tool: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        riskTier: z.enum(TOOL_RISK_TIERS),
        readOnly: z.boolean(),
      })
      .strict(),
    outcome: governedToolOutcomeSchema,
    emittedAt: z.string().datetime(),
  })
  .strict();

export interface StructuredToolResultEnvelope<TResult = unknown> {
  schemaVersion: "1.0";
  kind: "tool_result";
  correlation: {
    requestId: string;
    threadId: string;
    runId: string;
    toolCallId: string;
    stepId?: string;
  };
  tool: {
    name: string;
    version: string;
    riskTier: RuntimeToolDescriptor["riskTier"];
    readOnly: boolean;
  };
  outcome: GovernedToolOutcome<TResult>;
  emittedAt: string;
}

export interface CreateStructuredToolResultInput<TResult> {
  executionContext: ExecutionContext;
  descriptor: RuntimeToolDescriptor<unknown, TResult>;
  outcome: GovernedToolOutcome<TResult>;
  emittedAt?: string;
}

export function createStructuredToolResultEnvelope<TResult>(
  input: CreateStructuredToolResultInput<TResult>
): StructuredToolResultEnvelope<TResult> {
  const context = executionContextSchema.parse(input.executionContext);
  if (context.toolCallId === undefined) {
    throw new Error("Structured tool result requires toolCallId");
  }

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
    emittedAt: input.emittedAt ?? new Date().toISOString(),
  };

  structuredToolResultEnvelopeSchema.parse(envelope);
  return envelope;
}

function outcomeErrorCode<TResult>(
  outcome: Exclude<GovernedToolOutcome<TResult>, { type: "succeeded" }>
): string {
  if (outcome.type === "cancelled") {
    return `TOOL_EXECUTION_CANCELLED_${outcome.dispatchState.toUpperCase()}`;
  }
  return outcome.type === "confirmation_required"
    ? "REQUIRES_CONFIRMATION"
    : outcome.errorCode;
}

export function toLegacyToolResult<TResult>(
  envelope: StructuredToolResultEnvelope<TResult>
): string {
  if (envelope.outcome.type === "succeeded") {
    return typeof envelope.outcome.result === "string"
      ? envelope.outcome.result
      : JSON.stringify(envelope.outcome.result);
  }
  return `Error: ${envelope.tool.name} failed - ${outcomeErrorCode(
    envelope.outcome
  )}`;
}

export function tryToLegacyToolResult(value: unknown): string | undefined {
  const parsed = structuredToolResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  // Zod infers `z.unknown()` object properties as optional. The domain
  // assertion stays here, immediately after strict runtime validation.
  return toLegacyToolResult(
    parsed.data as StructuredToolResultEnvelope<unknown>
  );
}
