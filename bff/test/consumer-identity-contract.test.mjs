import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../contracts/execution-context.fixture.json", import.meta.url),
    "utf8",
  ),
);

test("defines the single-source consumer identity contract", () => {
  assert.deepEqual(fixture.consumerIdentity.opaqueId, {
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    minLength: 1,
    maxLength: 128,
    types: [
      "AccountId",
      "UserId",
      "TenantId",
      "SessionId",
      "DeviceId",
      "CredentialId",
      "PrincipalId",
    ],
  });
  assert.deepEqual(fixture.consumerIdentity.accountStatuses, [
    "pending_verification",
    "active",
    "recovery_restricted",
    "suspended",
    "deletion_pending",
    "deleted",
  ]);
  assert.deepEqual(fixture.consumerIdentity.sessionStatuses, [
    "active",
    "expired",
    "revoked",
    "compromised",
  ]);
  assert.deepEqual(fixture.consumerIdentity.principalKinds, [
    "anonymous",
    "authenticated",
    "service",
    "operator",
    "delegated",
  ]);
  assert.deepEqual(fixture.consumerIdentity.principalTypeAdapter, {
    version: "1.0.0",
    mapping: {
      user: "authenticated",
      merchant_staff: "authenticated",
      platform_staff: "operator",
      service: "service",
    },
    unknown: "deny",
  });
  assert.deepEqual(fixture.consumerIdentity.trustedHeaders.additive, [
    "x-bff-account-id",
    "x-bff-session-id",
    "x-bff-device-id",
    "x-bff-principal-kind",
  ]);
  assert.equal(
    fixture.consumerIdentity.accessDenial.crossAccount,
    "CROSS_TENANT_DENIED",
  );
  assert.equal(
    fixture.consumerIdentity.accessDenial.crossTenant,
    "CROSS_TENANT_DENIED",
  );
});

test("rejects unknown or malformed consumer identity values", () => {
  const opaqueIdPattern = new RegExp(fixture.consumerIdentity.opaqueId.pattern);
  assert.equal(opaqueIdPattern.test("account_01"), true);
  assert.equal(opaqueIdPattern.test("bad account"), false);
  assert.equal(opaqueIdPattern.test("x".repeat(129)), false);
  assert.equal(fixture.consumerIdentity.accountStatuses.includes("unknown"), false);
  assert.equal(fixture.consumerIdentity.sessionStatuses.includes("unknown"), false);
  assert.equal(fixture.consumerIdentity.principalKinds.includes("root"), false);
  assert.equal(fixture.consumerIdentity.principalTypeAdapter.mapping.root, undefined);
});
