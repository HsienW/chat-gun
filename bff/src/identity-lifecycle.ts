import { createHash } from "node:crypto";

import type { AccountStatus, SessionStatus } from "./identity-provider.js";

export type AccountRecord = {
  accountId: string;
  userId: string;
  tenantId: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
};

export type AccountTombstone = {
  accountIdHash: string;
  deletedAt: string;
  tombstoneVersion: 1;
  deletionReason: string;
};

export type SessionRecord = {
  sessionId: string;
  accountId: string;
  principalId: string;
  deviceId: string;
  credentialId: string;
  status: SessionStatus;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CredentialRecord = {
  credentialId: string;
  accountId: string;
  deviceId: string;
  status: "active" | "expired" | "revoked" | "compromised";
  rotatedFromCredentialId?: string;
  absoluteExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export interface AccountStorePort {
  findAccount(accountId: string): Promise<AccountRecord | null>;
  saveAccount(account: AccountRecord): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  findTombstone(accountId: string): Promise<AccountTombstone | null>;
  saveTombstone(accountId: string, tombstone: AccountTombstone): Promise<void>;
}

export interface UserStorePort {
  saveUser(userId: string, accountId: string, updatedAt: string): Promise<void>;
}

export interface TenantStorePort {
  savePersonalTenant(tenantId: string, accountId: string, updatedAt: string): Promise<void>;
}

export interface SessionStorePort {
  findSession(sessionId: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  listSessionsByPrincipal(principalId: string): Promise<SessionRecord[]>;
  listSessionsByCredential(credentialId: string): Promise<SessionRecord[]>;
}

export interface CredentialStorePort {
  findCredential(credentialId: string): Promise<CredentialRecord | null>;
  saveCredential(credential: CredentialRecord): Promise<void>;
  markCredentialCompromised(credentialId: string, updatedAt: string): Promise<void>;
}

export type IdentityLifecycleStorePort = AccountStorePort &
  UserStorePort &
  TenantStorePort &
  SessionStorePort &
  CredentialStorePort;

const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  pending_verification: ["active"],
  active: ["recovery_restricted", "suspended", "deletion_pending"],
  recovery_restricted: ["active", "suspended", "deletion_pending"],
  suspended: ["active", "deletion_pending"],
  deletion_pending: ["deleted"],
  deleted: [],
};

function domainError(code: string): Error {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}

function accountIdHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

export function createInMemoryIdentityLifecycleStore(): IdentityLifecycleStorePort {
  const accounts = new Map<string, AccountRecord>();
  const tombstones = new Map<string, AccountTombstone>();
  const sessions = new Map<string, SessionRecord>();
  const users = new Map<string, string>();
  const tenants = new Map<string, string>();
  const compromisedCredentials = new Set<string>();
  const credentials = new Map<string, CredentialRecord>();
  return {
    findAccount: async (accountId) => accounts.get(accountId) ?? null,
    saveAccount: async (account) => {
      accounts.set(account.accountId, { ...account });
    },
    removeAccount: async (accountId) => {
      accounts.delete(accountId);
    },
    findTombstone: async (accountId) => tombstones.get(accountId) ?? null,
    saveTombstone: async (accountId, tombstone) => {
      tombstones.set(accountId, { ...tombstone });
    },
    saveUser: async (userId, accountId) => {
      users.set(userId, accountId);
    },
    savePersonalTenant: async (tenantId, accountId) => {
      tenants.set(tenantId, accountId);
    },
    findSession: async (sessionId) => sessions.get(sessionId) ?? null,
    saveSession: async (session) => {
      sessions.set(session.sessionId, { ...session });
    },
    listSessionsByPrincipal: async (principalId) =>
      [...sessions.values()].filter((session) => session.principalId === principalId),
    listSessionsByCredential: async (credentialId) =>
      [...sessions.values()].filter((session) => session.credentialId === credentialId),
    findCredential: async (credentialId) => credentials.get(credentialId) ?? null,
    saveCredential: async (credential) => {
      credentials.set(credential.credentialId, { ...credential });
    },
    markCredentialCompromised: async (credentialId) => {
      compromisedCredentials.add(credentialId);
      const credential = credentials.get(credentialId);
      if (credential) {
        credentials.set(credentialId, { ...credential, status: "compromised" });
      }
    },
  };
}

export class IdentityLifecycleService {
  constructor(
    private readonly store: IdentityLifecycleStorePort,
    private readonly options: {
      now: () => Date;
      activeCacheTtlMs: number;
      tombstoneCacheTtlMs: number;
    },
  ) {
    if (options.tombstoneCacheTtlMs < options.activeCacheTtlMs) {
      throw domainError("TOMBSTONE_CACHE_TTL_TOO_SHORT");
    }
  }

  async createAccount(input: {
    accountId: string;
    userId: string;
    tenantId: string;
  }): Promise<AccountRecord> {
    if (await this.store.findTombstone(input.accountId)) {
      throw domainError("ACCOUNT_TOMBSTONED");
    }
    if (await this.store.findAccount(input.accountId)) {
      throw domainError("ACCOUNT_ALREADY_EXISTS");
    }
    const timestamp = this.options.now().toISOString();
    const account: AccountRecord = {
      ...input,
      status: "pending_verification",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveAccount(account);
    await Promise.all([
      this.store.saveUser(input.userId, input.accountId, timestamp),
      this.store.savePersonalTenant(input.tenantId, input.accountId, timestamp),
    ]);
    return account;
  }

  async transitionAccount(
    accountId: string,
    nextStatus: AccountStatus,
  ): Promise<AccountRecord> {
    const account = await this.store.findAccount(accountId);
    if (!account) throw domainError("ACCOUNT_NOT_FOUND");
    if (!ALLOWED_TRANSITIONS[account.status].includes(nextStatus)) {
      throw domainError("INVALID_ACCOUNT_TRANSITION");
    }
    const updated = {
      ...account,
      status: nextStatus,
      updatedAt: this.options.now().toISOString(),
    };
    await this.store.saveAccount(updated);
    return updated;
  }

  async deleteAccount(accountId: string, deletionReason: string): Promise<AccountTombstone> {
    const account = await this.store.findAccount(accountId);
    if (!account) throw domainError("ACCOUNT_NOT_FOUND");
    if (account.status !== "deletion_pending") {
      throw domainError("INVALID_ACCOUNT_TRANSITION");
    }
    const tombstone: AccountTombstone = {
      accountIdHash: accountIdHash(accountId),
      deletedAt: this.options.now().toISOString(),
      tombstoneVersion: 1,
      deletionReason,
    };
    await this.store.saveTombstone(accountId, tombstone);
    await this.store.removeAccount(accountId);
    return tombstone;
  }

  async getAccount(accountId: string): Promise<
    | { status: "active"; account: AccountRecord }
    | { status: "deleted"; tombstone: AccountTombstone }
    | { status: "not_found" }
  > {
    const tombstone = await this.store.findTombstone(accountId);
    if (tombstone) return { status: "deleted", tombstone };
    const account = await this.store.findAccount(accountId);
    return account ? { status: "active", account } : { status: "not_found" };
  }

  async handleLateAccountEvent(
    accountId: string,
    policy: "reject" | "quarantine" | "redact",
  ): Promise<"accepted" | "rejected" | "quarantined" | "redacted"> {
    if (!(await this.store.findTombstone(accountId))) return "accepted";
    return policy === "reject"
      ? "rejected"
      : policy === "quarantine"
        ? "quarantined"
        : "redacted";
  }

  async issueSession(input: Omit<SessionRecord, "status" | "createdAt" | "updatedAt">): Promise<SessionRecord> {
    const credential = await this.checkCredential(input.credentialId);
    if (
      !credential ||
      credential.status !== "active" ||
      credential.accountId !== input.accountId ||
      credential.deviceId !== input.deviceId
    ) {
      throw domainError("CREDENTIAL_NOT_ACTIVE");
    }
    const timestamp = this.options.now().toISOString();
    const session: SessionRecord = {
      ...input,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveSession(session);
    return session;
  }

  async issueCredential(input: {
    credentialId: string;
    accountId: string;
    deviceId: string;
    absoluteExpiresAt: string;
    rotatedFromCredentialId?: string;
  }): Promise<CredentialRecord> {
    if (await this.store.findCredential(input.credentialId)) {
      throw domainError("CREDENTIAL_ALREADY_EXISTS");
    }
    const timestamp = this.options.now().toISOString();
    const credential: CredentialRecord = {
      ...input,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveCredential(credential);
    return credential;
  }

  async checkCredential(credentialId: string): Promise<CredentialRecord | null> {
    const credential = await this.store.findCredential(credentialId);
    if (!credential || credential.status !== "active") return credential;
    if (Date.parse(credential.absoluteExpiresAt) <= this.options.now().getTime()) {
      const expired: CredentialRecord = {
        ...credential,
        status: "expired",
        updatedAt: this.options.now().toISOString(),
      };
      await this.store.saveCredential(expired);
      return expired;
    }
    return credential;
  }

  async rotateCredential(
    credentialId: string,
    replacement: { credentialId: string; absoluteExpiresAt: string },
  ): Promise<CredentialRecord> {
    const current = await this.store.findCredential(credentialId);
    if (!current || current.status !== "active") {
      throw domainError("CREDENTIAL_NOT_ACTIVE");
    }
    const timestamp = this.options.now().toISOString();
    await this.store.saveCredential({ ...current, status: "revoked", updatedAt: timestamp });
    return this.issueCredential({
      ...replacement,
      accountId: current.accountId,
      deviceId: current.deviceId,
      rotatedFromCredentialId: current.credentialId,
    });
  }

  async checkSession(sessionId: string): Promise<SessionRecord | null> {
    const session = await this.store.findSession(sessionId);
    if (!session || session.status !== "active") return session;
    const now = this.options.now().getTime();
    if (Date.parse(session.idleExpiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) {
      const expired = { ...session, status: "expired" as const, updatedAt: this.options.now().toISOString() };
      await this.store.saveSession(expired);
      return expired;
    }
    return session;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const session = await this.store.findSession(sessionId);
    if (!session) return;
    await this.store.saveSession({
      ...session,
      status: "revoked",
      updatedAt: this.options.now().toISOString(),
    });
  }

  async revokeAll(principalId: string): Promise<void> {
    const sessions = await this.store.listSessionsByPrincipal(principalId);
    await Promise.all(sessions.map((session) => this.revokeSession(session.sessionId)));
  }

  async compromiseCredential(credentialId: string): Promise<void> {
    const timestamp = this.options.now().toISOString();
    await this.store.markCredentialCompromised(credentialId, timestamp);
    const sessions = await this.store.listSessionsByCredential(credentialId);
    await Promise.all(sessions.map((session) => this.store.saveSession({
      ...session,
      status: "compromised",
      updatedAt: timestamp,
    })));
  }
}
