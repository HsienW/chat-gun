import { describe, expect, it, vi } from "vitest";

import {
  IdentityLifecycleService,
  createInMemoryIdentityLifecycleStore,
} from "./identity-lifecycle.js";
import {
  PgIdentityLifecycleStore,
  applyConsumerIdentityMigration,
  rollbackConsumerIdentityMigration,
} from "./identity-postgres.js";

const now = new Date("2026-09-30T00:00:00.000Z");

describe("IdentityLifecycleService", () => {
  it("enforces typed account transitions", async () => {
    const store = createInMemoryIdentityLifecycleStore();
    const service = new IdentityLifecycleService(store, {
      now: () => now,
      activeCacheTtlMs: 30_000,
      tombstoneCacheTtlMs: 60_000,
    });
    await service.createAccount({
      accountId: "account_01",
      userId: "user_01",
      tenantId: "tenant_01",
    });

    await expect(
      service.transitionAccount("account_01", "active"),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      service.transitionAccount("account_01", "pending_verification"),
    ).rejects.toThrow("INVALID_ACCOUNT_TRANSITION");
  });

  it("keeps a minimal tombstone and blocks replay, late events, and cache refill", async () => {
    const store = createInMemoryIdentityLifecycleStore();
    const service = new IdentityLifecycleService(store, {
      now: () => now,
      activeCacheTtlMs: 30_000,
      tombstoneCacheTtlMs: 60_000,
    });
    await service.createAccount({
      accountId: "account_01",
      userId: "user_01",
      tenantId: "tenant_01",
    });
    await service.transitionAccount("account_01", "active");
    await service.transitionAccount("account_01", "deletion_pending");
    await service.deleteAccount("account_01", "user_requested");

    await expect(service.getAccount("account_01")).resolves.toMatchObject({
      status: "deleted",
      tombstone: {
        tombstoneVersion: 1,
        deletionReason: "user_requested",
      },
    });
    expect(JSON.stringify(await service.getAccount("account_01"))).not.toContain(
      "user_01",
    );
    await expect(
      service.createAccount({
        accountId: "account_01",
        userId: "user_02",
        tenantId: "tenant_02",
      }),
    ).rejects.toThrow("ACCOUNT_TOMBSTONED");
    await expect(service.handleLateAccountEvent("account_01", "reject")).resolves.toBe(
      "rejected",
    );
  });

  it("enforces cache TTL ordering", () => {
    expect(
      () => new IdentityLifecycleService(createInMemoryIdentityLifecycleStore(), {
        now: () => now,
        activeCacheTtlMs: 60_000,
        tombstoneCacheTtlMs: 30_000,
      }),
    ).toThrow("TOMBSTONE_CACHE_TTL_TOO_SHORT");
  });

  it("supports issuance, expiry, per-session revoke, revoke-all, and compromise containment", async () => {
    const store = createInMemoryIdentityLifecycleStore();
    let current = now;
    const service = new IdentityLifecycleService(store, {
      now: () => current,
      activeCacheTtlMs: 30_000,
      tombstoneCacheTtlMs: 60_000,
    });
    const base = {
      accountId: "account_01",
      principalId: "principal_01",
      deviceId: "device_01",
      credentialId: "credential_01",
      idleExpiresAt: "2026-09-30T00:10:00.000Z",
      absoluteExpiresAt: "2026-09-30T01:00:00.000Z",
    };
    await service.issueCredential({
      credentialId: "credential_01",
      accountId: "account_01",
      deviceId: "device_01",
      absoluteExpiresAt: "2026-10-30T00:00:00.000Z",
    });
    await expect(service.issueSession({
      ...base,
      credentialId: "credential_missing",
      sessionId: "session_missing",
    })).rejects.toThrow("CREDENTIAL_NOT_ACTIVE");
    await service.issueSession({ ...base, sessionId: "session_01" });
    await service.issueSession({ ...base, sessionId: "session_02" });
    await service.revokeSession("session_01");
    await expect(service.checkSession("session_01")).resolves.toMatchObject({
      status: "revoked",
    });
    await service.compromiseCredential("credential_01");
    await expect(service.checkSession("session_02")).resolves.toMatchObject({
      status: "compromised",
    });

    await service.issueCredential({
      credentialId: "credential_02",
      accountId: "account_01",
      deviceId: "device_01",
      absoluteExpiresAt: "2026-10-30T00:00:00.000Z",
    });
    await service.issueSession({
      ...base,
      credentialId: "credential_02",
      sessionId: "session_03",
    });
    current = new Date("2026-09-30T00:11:00.000Z");
    await expect(service.checkSession("session_03")).resolves.toMatchObject({
      status: "expired",
    });
    await service.revokeAll("principal_01");
  });

  it("rotates credentials without storing credential material", async () => {
    const store = createInMemoryIdentityLifecycleStore();
    const service = new IdentityLifecycleService(store, {
      now: () => now,
      activeCacheTtlMs: 30_000,
      tombstoneCacheTtlMs: 60_000,
    });
    await service.issueCredential({
      credentialId: "credential_old",
      accountId: "account_01",
      deviceId: "device_01",
      absoluteExpiresAt: "2026-10-30T00:00:00.000Z",
    });

    await service.rotateCredential("credential_old", {
      credentialId: "credential_new",
      absoluteExpiresAt: "2026-11-30T00:00:00.000Z",
    });

    await expect(service.checkCredential("credential_old")).resolves.toMatchObject({
      status: "revoked",
    });
    await expect(service.checkCredential("credential_new")).resolves.toMatchObject({
      status: "active",
      rotatedFromCredentialId: "credential_old",
    });
    expect(JSON.stringify(await service.checkCredential("credential_new"))).not.toContain("token");
  });
});

describe("PgIdentityLifecycleStore and migration", () => {
  it("uses parameterized queries for identity lookups", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const store = new PgIdentityLifecycleStore({ query });
    await store.findAccount("account_01");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("$1"), ["account_01"]);
    await store.findTombstone("account_01");
    expect(query.mock.calls.at(-1)?.[0]).not.toContain("digest(");
    expect(query.mock.calls.at(-1)?.[1]?.[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies and rolls back the additive migration", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [] }));
    await applyConsumerIdentityMigration({ query });
    await rollbackConsumerIdentityMigration({ query });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("CREATE TABLE IF NOT EXISTS identity_accounts");
    expect(query.mock.calls[0]?.[0]).not.toContain("raw_token");
    expect(query.mock.calls[1]?.[0]).toContain("DROP TABLE IF EXISTS identity_credentials");
  });
});
