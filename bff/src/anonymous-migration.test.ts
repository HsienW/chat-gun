import { describe, expect, it } from "vitest";

import {
  AnonymousMigrationService,
  createInMemoryAnonymousMigrationStore,
  parseAnonymousMigrationRequest,
} from "./anonymous-migration.js";

const input = {
  schemaVersion: "1.0.0" as const,
  anonymousId: "anonymous_01",
  anonymousSessionId: "session_anonymous_01",
  anonymousDeviceId: "device_anonymous_01",
  anonymousCredential: "anonymous-secret",
  idempotencyKey: "migration_01",
};

describe("anonymous migration contract", () => {
  it("strictly validates the versioned request", () => {
    expect(parseAnonymousMigrationRequest(input)).toEqual(input);
    expect(parseAnonymousMigrationRequest({ ...input, accountId: "attacker" })).toBeUndefined();
    expect(parseAnonymousMigrationRequest({ ...input, schemaVersion: "2.0.0" })).toBeUndefined();
  });

  it("is atomic and idempotent across competing claimants", async () => {
    const service = new AnonymousMigrationService(
      createInMemoryAnonymousMigrationStore(),
      { verify: async ({ credential }) => credential === "anonymous-secret" },
    );

    await expect(service.migrate(input, {
      accountId: "account_01",
      sessionId: "session_account_01",
    })).resolves.toMatchObject({ result: "migrated" });
    await expect(service.migrate(input, {
      accountId: "account_01",
      sessionId: "session_account_01",
    })).resolves.toMatchObject({ result: "already_migrated" });
    await expect(service.migrate({ ...input, idempotencyKey: "migration_02" }, {
      accountId: "account_02",
      sessionId: "session_account_02",
    })).resolves.toEqual({ schemaVersion: "1.0.0", result: "conflict" });
  });

  it("resumes an interrupted ownership transfer without losing ownership", async () => {
    const store = createInMemoryAnonymousMigrationStore({ interruptAfterClaimOnce: true });
    const service = new AnonymousMigrationService(store, { verify: async () => true });
    await expect(service.migrate(input, {
      accountId: "account_01",
      sessionId: "session_account_01",
    })).rejects.toThrow("MIGRATION_INTERRUPTED");

    await expect(service.migrate(input, {
      accountId: "account_01",
      sessionId: "session_account_01",
    })).resolves.toMatchObject({ result: "migrated" });
    await expect(store.getOwnership("anonymous_01")).resolves.toEqual({
      anonymousId: "anonymous_01",
      accountId: "account_01",
      status: "complete",
    });
  });

  it("does not claim when the anonymous credential is invalid", async () => {
    const store = createInMemoryAnonymousMigrationStore();
    const service = new AnonymousMigrationService(store, { verify: async () => false });
    await expect(service.migrate(input, {
      accountId: "account_01",
      sessionId: "session_account_01",
    })).rejects.toThrow("ANONYMOUS_CREDENTIAL_INVALID");
    await expect(store.getOwnership("anonymous_01")).resolves.toBeNull();
  });
});
