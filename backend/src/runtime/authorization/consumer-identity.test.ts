import { describe, expect, it } from "vitest";

import {
  accountStatusSchema,
  delegatedIdentitySchema,
  opaqueIdentityIdSchema,
  PRINCIPAL_KIND_VALUES,
  principalTypeAdapter,
  sessionStatusSchema,
} from "./consumer-identity.js";

describe("consumer identity contract", () => {
  it("accepts bounded opaque identifiers and rejects malformed values", () => {
    expect(opaqueIdentityIdSchema.safeParse("account_01").success).toBe(true);
    expect(opaqueIdentityIdSchema.safeParse("bad account").success).toBe(false);
    expect(opaqueIdentityIdSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("keeps account and session statuses closed", () => {
    expect(accountStatusSchema.safeParse("active").success).toBe(true);
    expect(accountStatusSchema.safeParse("unknown").success).toBe(false);
    expect(sessionStatusSchema.safeParse("revoked").success).toBe(true);
    expect(sessionStatusSchema.safeParse("unknown").success).toBe(false);
  });

  it("maps every legacy principal type through one versioned adapter", () => {
    expect(principalTypeAdapter.version).toBe("1.0.0");
    expect(principalTypeAdapter.toPrincipalKind("user")).toBe("authenticated");
    expect(principalTypeAdapter.toPrincipalKind("merchant_staff")).toBe(
      "authenticated",
    );
    expect(principalTypeAdapter.toPrincipalKind("platform_staff")).toBe("operator");
    expect(principalTypeAdapter.toPrincipalKind("service")).toBe("service");
    expect(PRINCIPAL_KIND_VALUES).toContain("delegated");
  });

  it("fails closed for an unknown legacy principal type", () => {
    expect(() => principalTypeAdapter.toPrincipalKind("root")).toThrow(
      "UNKNOWN_PRINCIPAL_TYPE",
    );
  });

  it("requires delegated lineage and a bounded capability subset reference", () => {
    expect(
      delegatedIdentitySchema.parse({
        delegatedPrincipalId: "delegated_01",
        parentPrincipalId: "principal_01",
        delegatedCapabilitySet: ["orders:read"],
      }),
    ).toEqual({
      delegatedPrincipalId: "delegated_01",
      parentPrincipalId: "principal_01",
      delegatedCapabilitySet: ["orders:read"],
    });
    expect(
      delegatedIdentitySchema.safeParse({
        delegatedPrincipalId: "delegated_01",
        delegatedCapabilitySet: [],
      }).success,
    ).toBe(false);
  });
});
