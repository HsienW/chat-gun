import type { ConfirmationRequiredDescriptor } from "../authorization/confirmation.js";
import type {
  DispatchState,
  GovernedAuthorizationOutcome,
  ToolExecutionTerminationCause,
} from "@gun-ai/harness-contracts";

export type {
  DispatchState,
  GovernedAuthorizationOutcome,
  ToolExecutionTerminationCause,
} from "@gun-ai/harness-contracts";

export type DeduplicationReason =
  | "committed_result_reused"
  | "in_flight_duplicate"
  | "original_outcome_unknown";

export interface DeduplicatedOriginal {
  businessEffectId: string;
  toolExecutionId?: string;
}

export type GovernedToolOutcome<TResult> =
  | { type: "succeeded"; result: TResult }
  | {
      type: "deduplicated";
      reason: "committed_result_reused";
      original: DeduplicatedOriginal;
      result: TResult;
    }
  | {
      type: "deduplicated";
      reason: "in_flight_duplicate" | "original_outcome_unknown";
      original: DeduplicatedOriginal;
      result?: never;
    }
  | { type: "rejected_before_dispatch"; errorCode: string }
  | { type: "denied_by_authorization"; errorCode: string; decisionId: string }
  | { type: "confirmation_required"; decisionId: string; descriptor: ConfirmationRequiredDescriptor }
  | { type: "failed_not_committed"; errorCode: string; retryAfterMs?: number }
  | { type: "ambiguous_after_dispatch"; errorCode: string }
  | { type: "cancelled"; dispatchState: DispatchState };

export function getToolExecutionTerminationCause(
  outcome: GovernedToolOutcome<unknown>
): ToolExecutionTerminationCause {
  if (outcome.type === "succeeded") return "completed";
  if (outcome.type === "deduplicated") return "deduplicated";
  if (outcome.type !== "cancelled") return outcome.type;
  return `cancelled_${outcome.dispatchState}_dispatch`;
}

/**
 * The authorization decision a caller already consumed on the server (for
 * example an approved confirmation). It is passed as a typed argument, never
 * through run config, so a client cannot supply it.
 */
export interface ConsumedAuthorization {
  decisionId: string;
}

export interface GovernedToolExecutor<TInput, TResult> {
  authorizeTyped?(input: TInput, config?: unknown): Promise<GovernedAuthorizationOutcome>;
  executeAuthorizedTyped?(
    input: TInput,
    config?: unknown,
    authorization?: ConsumedAuthorization
  ): Promise<GovernedToolOutcome<TResult>>;
  executeTyped(input: TInput, config?: unknown): Promise<GovernedToolOutcome<TResult>>;
}
