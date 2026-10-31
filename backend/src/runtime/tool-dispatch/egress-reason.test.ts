import { describe, expect, it } from "vitest";

import {
  EGRESS_REASON_OUTCOMES,
  UNKNOWN_EGRESS_REASON,
  parseStoredEgressDecision,
  toObservedEgressReasonCode,
} from "./egress-reason.js";

describe("egress reason set", () => {
  it("binds every reason to exactly one outcome", () => {
    expect(EGRESS_REASON_OUTCOMES).toEqual({
      POLICY_ALLOWED: "allow",
      URL_INVALID: "EGRESS_DENIED",
      URL_PARSER_DISAGREEMENT: "EGRESS_DENIED",
      PROTOCOL_NOT_ALLOWED: "EGRESS_DENIED",
      EMBEDDED_CREDENTIAL: "EGRESS_DENIED",
      PORT_NOT_ALLOWED: "EGRESS_DENIED",
      PRIVATE_ADDRESS: "EGRESS_DENIED",
      DESTINATION_NOT_ALLOWED: "EGRESS_DENIED",
      DNS_EMPTY: "EGRESS_DENIED",
      DNS_RESOLUTION_FAILED: "EGRESS_POLICY_UNAVAILABLE",
      CONNECT_HOST_MISMATCH: "EGRESS_DENIED",
      TOO_MANY_REDIRECTS: "EGRESS_DENIED",
    });
  });

  it("keeps known reasons and maps anything else to UNKNOWN", () => {
    expect(toObservedEgressReasonCode("PRIVATE_ADDRESS")).toBe("PRIVATE_ADDRESS");
    expect(toObservedEgressReasonCode("PROXY_REFUSED")).toBe(UNKNOWN_EGRESS_REASON);
    expect(toObservedEgressReasonCode(undefined)).toBe(UNKNOWN_EGRESS_REASON);
  });

  it("reads stored decisions with unknown reasons without dropping the decision", () => {
    expect(
      parseStoredEgressDecision({ decision: "deny", reasonCode: "LEGACY_REASON" })
    ).toEqual({ decision: "deny", reasonCode: "UNKNOWN" });
    expect(
      parseStoredEgressDecision({ decision: "allow", reasonCode: "POLICY_ALLOWED" })
    ).toEqual({ decision: "allow", reasonCode: "POLICY_ALLOWED" });
    expect(
      parseStoredEgressDecision({ decision: "unavailable", reasonCode: "DNS_RESOLUTION_FAILED" })
    ).toEqual({ decision: "unavailable", reasonCode: "DNS_RESOLUTION_FAILED" });
  });

  it("treats a stored value without a valid decision as missing evidence", () => {
    expect(parseStoredEgressDecision(null)).toBeNull();
    expect(parseStoredEgressDecision({ decision: "maybe", reasonCode: "PRIVATE_ADDRESS" })).toBeNull();
  });
});
