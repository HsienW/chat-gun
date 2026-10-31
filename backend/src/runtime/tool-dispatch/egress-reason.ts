import { z } from "zod";

export type EgressPolicyErrorCode =
  | "EGRESS_DENIED"
  | "EGRESS_POLICY_UNAVAILABLE";

/**
 * Single source of egress reasons. Each reason is bound to one outcome:
 * "deny" when the policy decided against the request, "unavailable" when the
 * policy could not finish evaluating because infrastructure (DNS) failed.
 */
export const EGRESS_REASON_OUTCOMES = {
  POLICY_ALLOWED: "allow",
  URL_INVALID: "EGRESS_DENIED",
  URL_PARSER_DISAGREEMENT: "EGRESS_DENIED",
  PROTOCOL_NOT_ALLOWED: "EGRESS_DENIED",
  EMBEDDED_CREDENTIAL: "EGRESS_DENIED",
  PORT_NOT_ALLOWED: "EGRESS_DENIED",
  PRIVATE_ADDRESS: "EGRESS_DENIED",
  DESTINATION_NOT_ALLOWED: "EGRESS_DENIED",
  // An empty answer is a resolved result the policy refuses to connect to.
  DNS_EMPTY: "EGRESS_DENIED",
  DNS_RESOLUTION_FAILED: "EGRESS_POLICY_UNAVAILABLE",
  CONNECT_HOST_MISMATCH: "EGRESS_DENIED",
  TOO_MANY_REDIRECTS: "EGRESS_DENIED",
} as const satisfies Record<string, "allow" | EgressPolicyErrorCode>;

export type EgressReasonCode = keyof typeof EGRESS_REASON_OUTCOMES;

export type EgressFailureReasonCode<
  TCode extends EgressPolicyErrorCode = EgressPolicyErrorCode,
> = {
  [K in EgressReasonCode]: (typeof EGRESS_REASON_OUTCOMES)[K] extends TCode
    ? K
    : never;
}[EgressReasonCode];

/** Consumers map reasons outside the known set to this value instead of dropping them. */
export const UNKNOWN_EGRESS_REASON = "UNKNOWN" as const;

export type ObservedEgressReasonCode =
  | EgressReasonCode
  | typeof UNKNOWN_EGRESS_REASON;

const EGRESS_REASON_CODES = Object.keys(
  EGRESS_REASON_OUTCOMES
) as [EgressReasonCode, ...EgressReasonCode[]];

export const egressReasonCodeSchema = z.enum(EGRESS_REASON_CODES);

export const observedEgressReasonCodeSchema = z.enum([
  ...EGRESS_REASON_CODES,
  UNKNOWN_EGRESS_REASON,
]);

export const egressPolicyErrorCodeSchema = z.enum([
  "EGRESS_DENIED",
  "EGRESS_POLICY_UNAVAILABLE",
]);

export function toObservedEgressReasonCode(
  value: unknown
): ObservedEgressReasonCode {
  const parsed = egressReasonCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : UNKNOWN_EGRESS_REASON;
}

export interface EgressDecisionEvidence {
  decision: "allow" | "deny" | "unavailable";
  reasonCode: ObservedEgressReasonCode;
}

const storedEgressDecisionSchema = z
  .object({ decision: z.enum(["allow", "deny", "unavailable"]), reasonCode: z.unknown() })
  .passthrough();

/**
 * Reads a decision persisted before or after the reason set was closed.
 * A stored value without a valid decision is not evidence and returns null.
 */
export function parseStoredEgressDecision(
  value: unknown
): EgressDecisionEvidence | null {
  const parsed = storedEgressDecisionSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    decision: parsed.data.decision,
    reasonCode: toObservedEgressReasonCode(parsed.data.reasonCode),
  };
}
