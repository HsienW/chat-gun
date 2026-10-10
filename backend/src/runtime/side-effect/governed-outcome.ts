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

export type GovernedToolOutcome<TResult> =
  | { type: "succeeded"; result: TResult }
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
  if (outcome.type !== "cancelled") return outcome.type;
  return `cancelled_${outcome.dispatchState}_dispatch`;
}

export interface GovernedToolExecutor<TInput, TResult> {
  authorizeTyped?(input: TInput, config?: unknown): Promise<GovernedAuthorizationOutcome>;
  executeAuthorizedTyped?(input: TInput, config?: unknown): Promise<GovernedToolOutcome<TResult>>;
  executeTyped(input: TInput, config?: unknown): Promise<GovernedToolOutcome<TResult>>;
}
