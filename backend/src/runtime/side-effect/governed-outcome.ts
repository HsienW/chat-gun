import type { ConfirmationRequiredDescriptor } from "../authorization/confirmation.js";

export type DispatchState = "before" | "after" | "unknown";

export type GovernedToolOutcome<TResult> =
  | { type: "succeeded"; result: TResult }
  | { type: "rejected_before_dispatch"; errorCode: string }
  | {
      type: "denied_by_authorization";
      errorCode: string;
      decisionId: string;
    }
  | {
      type: "confirmation_required";
      decisionId: string;
      descriptor: ConfirmationRequiredDescriptor;
    }
  | {
      type: "failed_not_committed";
      errorCode: string;
      retryAfterMs?: number;
    }
  | { type: "ambiguous_after_dispatch"; errorCode: string }
  | { type: "cancelled"; dispatchState: DispatchState };

export type ToolExecutionTerminationCause =
  | "completed"
  | "rejected_before_dispatch"
  | "denied_by_authorization"
  | "confirmation_required"
  | "failed_not_committed"
  | "ambiguous_after_dispatch"
  | "cancelled_before_dispatch"
  | "cancelled_after_dispatch"
  | "cancelled_unknown_dispatch"
  | "profile_missing"
  | "profile_version_unsupported"
  | "profile_invalid"
  | "unsupported"
  | "capability_mismatch"
  | "secret_unresolvable";

export function getToolExecutionTerminationCause(
  outcome: GovernedToolOutcome<unknown>
): ToolExecutionTerminationCause {
  if (outcome.type === "succeeded") return "completed";
  if (outcome.type !== "cancelled") return outcome.type;
  return `cancelled_${outcome.dispatchState}_dispatch`;
}

export type GovernedAuthorizationOutcome =
  | { type: "authorized"; decisionId?: string }
  | Extract<
      GovernedToolOutcome<never>,
      { type: "denied_by_authorization" | "confirmation_required" }
    >;

export interface GovernedToolExecutor<TInput, TResult> {
  authorizeTyped?(
    input: TInput,
    config?: unknown
  ): Promise<GovernedAuthorizationOutcome>;
  executeAuthorizedTyped?(
    input: TInput,
    config?: unknown
  ): Promise<GovernedToolOutcome<TResult>>;
  executeTyped(input: TInput, config?: unknown): Promise<GovernedToolOutcome<TResult>>;
}
