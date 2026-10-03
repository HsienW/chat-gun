import type { RedisLockClient } from "./step-lock.js";

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface SingletonLeaseGrant {
  name: string;
  owner: string;
  fencingToken: number;
}

export interface SingletonLeaseTokenStore {
  next(name: string): Promise<number>;
  isCurrent(name: string, fencingToken: number): Promise<boolean>;
}

export interface RedisFencingTokenClient {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

export class RedisSingletonLeaseTokenStore implements SingletonLeaseTokenStore {
  constructor(
    private readonly redis: RedisFencingTokenClient,
    private readonly keyPrefix = "singleton_fencing:"
  ) {}

  next(name: string): Promise<number> {
    return this.redis.incr(`${this.keyPrefix}${name}`);
  }

  async isCurrent(name: string, fencingToken: number): Promise<boolean> {
    const current = await this.redis.get(`${this.keyPrefix}${name}`);
    return current !== null && Number(current) === fencingToken;
  }
}

export class SingletonLease {
  constructor(
    private readonly redis: RedisLockClient,
    private readonly tokens: SingletonLeaseTokenStore,
    private readonly keyPrefix = "singleton_lease:"
  ) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<SingletonLeaseGrant | null> {
    assertLeaseInput(name, owner, ttlMs);
    const fencingToken = await this.tokens.next(name);
    const value = `${fencingToken}:${owner}`;
    const acquired = await this.redis.set(
      `${this.keyPrefix}${name}`,
      value,
      "PX",
      ttlMs,
      "NX"
    );
    return acquired === "OK" ? { name, owner, fencingToken } : null;
  }

  async renew(grant: SingletonLeaseGrant, ttlMs: number): Promise<boolean> {
    assertLeaseInput(grant.name, grant.owner, ttlMs);
    if (!(await this.tokens.isCurrent(grant.name, grant.fencingToken))) return false;
    const renewed = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      `${this.keyPrefix}${grant.name}`,
      `${grant.fencingToken}:${grant.owner}`,
      ttlMs
    );
    return renewed === 1;
  }

  async assertCurrent(grant: SingletonLeaseGrant): Promise<void> {
    if (!(await this.tokens.isCurrent(grant.name, grant.fencingToken))) {
      throw new Error("STALE_SINGLETON_FENCING_TOKEN");
    }
  }
}

function assertLeaseInput(name: string, owner: string, ttlMs: number): void {
  if (!name.trim() || !owner.trim()) throw new Error("Invalid singleton lease identity");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Singleton lease TTL must be a positive integer");
  }
}
