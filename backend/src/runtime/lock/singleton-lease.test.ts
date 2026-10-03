import { describe, expect, it, vi } from "vitest";

import { RedisSingletonLeaseTokenStore, SingletonLease } from "./singleton-lease.js";
import type { RedisLockClient } from "./step-lock.js";

function createTokenStore() {
  const current = new Map<string, number>();
  return {
    next: vi.fn(async (name: string) => {
      const token = (current.get(name) ?? 0) + 1;
      current.set(name, token);
      return token;
    }),
    isCurrent: vi.fn(async (name: string, token: number) => current.get(name) === token),
  };
}

describe("SingletonLease", () => {
  it("uses Redis INCR as the durable fencing token source", async () => {
    const redis = {
      incr: vi.fn(async () => 7),
      get: vi.fn(async () => "7"),
    };
    const store = new RedisSingletonLeaseTokenStore(redis, "test:");
    await expect(store.next("reaper")).resolves.toBe(7);
    await expect(store.isCurrent("reaper", 7)).resolves.toBe(true);
    expect(redis.incr).toHaveBeenCalledWith("test:reaper");
  });

  it("allows one leader and issues a newer token after lease expiry", async () => {
    const redis: RedisLockClient = {
      set: vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockResolvedValueOnce("OK"),
      eval: vi.fn(async () => 1),
      get: vi.fn(async () => null),
    };
    const lease = new SingletonLease(redis, createTokenStore());

    const first = await lease.acquire("reaper", "instance-a", 1_000);
    expect(first?.fencingToken).toBe(1);
    await expect(lease.acquire("reaper", "instance-b", 1_000)).resolves.toBeNull();
    const afterExpiry = await lease.acquire("reaper", "instance-b", 1_000);
    expect(afterExpiry?.fencingToken).toBe(3);
    await expect(lease.assertCurrent(first!)).rejects.toThrow(
      "STALE_SINGLETON_FENCING_TOKEN"
    );
  });
});
