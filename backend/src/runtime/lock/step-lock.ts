import {
  createStepLockKey,
  getRedis,
} from "./redis-client.js";
import { loadDeploymentPolicy } from "../../platform/deployment-policy.js";

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const EXTEND_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface StepLock {
  acquire(stepId: string, owner: string, ttlMs: number): Promise<boolean>;
  release(stepId: string, owner: string): Promise<void>;
  extend(stepId: string, owner: string, ttlMs: number): Promise<boolean>;
}

export interface RedisLockClient {
  set(
    key: string,
    owner: string,
    expirationMode: "PX",
    ttlMs: number,
    condition: "NX"
  ): Promise<"OK" | null>;
  eval(
    script: string,
    numberOfKeys: number,
    key: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export class RedisStepLock implements StepLock {
  constructor(private readonly redisClient: RedisLockClient) {}

  async acquire(
    stepId: string,
    owner: string,
    ttlMs: number
  ): Promise<boolean> {
    validateLockTtl(ttlMs);
    const response = await this.redisClient.set(
      createStepLockKey(stepId),
      owner,
      "PX",
      ttlMs,
      "NX"
    );
    return response === "OK";
  }

  async release(stepId: string, owner: string): Promise<void> {
    await this.redisClient.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      createStepLockKey(stepId),
      owner
    );
  }

  async extend(
    stepId: string,
    owner: string,
    ttlMs: number
  ): Promise<boolean> {
    validateLockTtl(ttlMs);
    const response = await this.redisClient.eval(
      EXTEND_LOCK_SCRIPT,
      1,
      createStepLockKey(stepId),
      owner,
      ttlMs
    );
    return response === 1;
  }

  async getCurrentOwner(stepId: string): Promise<string | undefined> {
    return (await this.redisClient.get(createStepLockKey(stepId))) ?? undefined;
  }
}

export class NoopStepLock implements StepLock {
  async acquire(
    _stepId: string,
    _owner: string,
    _ttlMs: number
  ): Promise<boolean> {
    return true;
  }

  async release(_stepId: string, _owner: string): Promise<void> {}

  async extend(
    _stepId: string,
    _owner: string,
    _ttlMs: number
  ): Promise<boolean> {
    return true;
  }
}

export interface CreateStepLockOptions {
  multiInstanceEnabled?: boolean;
}

export function createStepLock(options: CreateStepLockOptions = {}): StepLock {
  const redisClient = getRedis();
  const multiInstanceEnabled =
    options.multiInstanceEnabled ?? loadDeploymentPolicy().policy.multiInstanceEnabled;
  if (!redisClient && multiInstanceEnabled) {
    throw new Error("LOCK_INFRASTRUCTURE_UNAVAILABLE");
  }
  return redisClient ? new RedisStepLock(redisClient) : new NoopStepLock();
}

function validateLockTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Lock TTL must be a positive integer");
  }
}
