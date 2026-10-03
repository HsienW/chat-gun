import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NoopStepLock,
  RedisStepLock,
  type RedisLockClient,
} from "./step-lock.js";

function createRedisClient(): RedisLockClient {
  return {
    eval: vi.fn(async () => 0),
    get: vi.fn(async () => null),
    set: vi.fn(async () => null),
  };
}

const originalRedisUri = process.env.REDIS_URI;
const originalRedisKeyPrefix = process.env.REDIS_KEY_PREFIX;

function restoreEnvironmentVariable(
  name: "REDIS_URI" | "REDIS_KEY_PREFIX",
  originalValue: string | undefined
): void {
  if (originalValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = originalValue;
}

afterEach(() => {
  restoreEnvironmentVariable("REDIS_URI", originalRedisUri);
  restoreEnvironmentVariable("REDIS_KEY_PREFIX", originalRedisKeyPrefix);
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("RedisStepLock", () => {
  it("acquires an unlocked step with SET NX PX", async () => {
    const redisClient = createRedisClient();
    vi.mocked(redisClient.set).mockResolvedValueOnce("OK");
    const lock = new RedisStepLock(redisClient);

    await expect(lock.acquire("step-1", "worker-A", 30_000)).resolves.toBe(
      true
    );
    expect(redisClient.set).toHaveBeenCalledWith(
      "step_lock:step-1",
      "worker-A",
      "PX",
      30_000,
      "NX"
    );
  });

  it("returns false when another worker owns the step", async () => {
    const redisClient = createRedisClient();
    vi.mocked(redisClient.set)
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce(null);
    const lock = new RedisStepLock(redisClient);

    await expect(lock.acquire("step-1", "worker-A", 30_000)).resolves.toBe(
      true
    );
    await expect(lock.acquire("step-1", "worker-B", 30_000)).resolves.toBe(
      false
    );
  });

  it("uses REDIS_KEY_PREFIX in the acquired key", async () => {
    process.env.REDIS_KEY_PREFIX = "prod:";
    const redisClient = createRedisClient();
    vi.mocked(redisClient.set).mockResolvedValueOnce("OK");
    const lock = new RedisStepLock(redisClient);

    await lock.acquire("step-1", "worker-A", 30_000);

    expect(redisClient.set).toHaveBeenCalledWith(
      "prod:step_lock:step-1",
      "worker-A",
      "PX",
      30_000,
      "NX"
    );
  });

  it("uses owner-safe Lua operations for release and extend", async () => {
    const redisClient = createRedisClient();
    vi.mocked(redisClient.eval)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const lock = new RedisStepLock(redisClient);

    await expect(lock.release("step-1", "worker-B")).resolves.toBeUndefined();
    await expect(lock.extend("step-1", "worker-A", 60_000)).resolves.toBe(
      true
    );
    await expect(lock.extend("step-1", "worker-B", 60_000)).resolves.toBe(
      false
    );

    const releaseScript = vi.mocked(redisClient.eval).mock.calls[0]?.[0];
    const extendScript = vi.mocked(redisClient.eval).mock.calls[1]?.[0];
    expect(releaseScript).toContain('redis.call("GET", KEYS[1])');
    expect(releaseScript).toContain('redis.call("DEL", KEYS[1])');
    expect(extendScript).toContain('redis.call("PEXPIRE", KEYS[1], ARGV[2])');
  });

  it.each([Number.NaN, 0, -1])(
    "rejects invalid TTL %s before calling Redis",
    async (ttlMs) => {
      const redisClient = createRedisClient();
      const lock = new RedisStepLock(redisClient);

      await expect(lock.acquire("step-1", "worker-A", ttlMs)).rejects.toThrow(
        "Lock TTL must be a positive integer"
      );
      await expect(lock.extend("step-1", "worker-A", ttlMs)).rejects.toThrow(
        "Lock TTL must be a positive integer"
      );
      expect(redisClient.set).not.toHaveBeenCalled();
      expect(redisClient.eval).not.toHaveBeenCalled();
    }
  );

  it("allows another worker to acquire after the TTL expires", async () => {
    let nowMs = 0;
    let entry: { expiresAt: number; owner: string } | undefined;
    const redisClient: RedisLockClient = {
      eval: vi.fn(async () => 0),
      get: vi.fn(async () =>
        entry && entry.expiresAt > nowMs ? entry.owner : null
      ),
      set: vi.fn(
        async (_key, owner, _expirationMode, ttlMs): Promise<"OK" | null> => {
          if (entry && entry.expiresAt > nowMs) {
            return null;
          }
          entry = { expiresAt: nowMs + ttlMs, owner };
          return "OK";
        }
      ),
    };
    const lock = new RedisStepLock(redisClient);

    await expect(lock.acquire("step-1", "worker-A", 1_000)).resolves.toBe(
      true
    );
    await expect(lock.acquire("step-1", "worker-B", 30_000)).resolves.toBe(
      false
    );
    nowMs = 1_001;
    await expect(lock.acquire("step-1", "worker-B", 30_000)).resolves.toBe(
      true
    );
  });

  it("returns the current owner as best-effort diagnostics", async () => {
    const redisClient = createRedisClient();
    vi.mocked(redisClient.get).mockResolvedValueOnce("worker-A");
    const lock = new RedisStepLock(redisClient);

    await expect(lock.getCurrentOwner("step-1")).resolves.toBe("worker-A");
  });
});

describe("NoopStepLock", () => {
  it("allows acquire and extend while release is a no-op", async () => {
    const lock = new NoopStepLock();

    await expect(lock.acquire("step-1", "worker-A", 30_000)).resolves.toBe(
      true
    );
    await expect(lock.release("step-1", "worker-A")).resolves.toBeUndefined();
    await expect(lock.extend("step-1", "worker-A", 30_000)).resolves.toBe(
      true
    );
  });
});

describe("createStepLock", () => {
  it("fails closed without Redis in multi-instance mode", async () => {
    process.env.REDIS_URI = "";
    const { createStepLock } = await import("./step-lock.js");

    expect(() => createStepLock({ multiInstanceEnabled: true })).toThrow(
      "LOCK_INFRASTRUCTURE_UNAVAILABLE"
    );
  });

  it("creates NoopStepLock when REDIS_URI is blank", async () => {
    process.env.REDIS_URI = "";
    const { createStepLock, NoopStepLock: DynamicNoopStepLock } = await import(
      "./step-lock.js"
    );

    expect(createStepLock()).toBeInstanceOf(DynamicNoopStepLock);
  });

  it("creates RedisStepLock when REDIS_URI is configured", async () => {
    process.env.REDIS_URI = "redis://localhost:6379";
    const { createStepLock, RedisStepLock: DynamicRedisStepLock } = await import(
      "./step-lock.js"
    );

    expect(createStepLock()).toBeInstanceOf(DynamicRedisStepLock);
  });
});
