import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameworkAdapterRegistry, FRAMEWORK_ADAPTER_CAPABILITIES, type FrameworkAdapterPort } from "./registry.js";

function adapter(adapterId = "reference"): FrameworkAdapterPort {
  return {
    descriptor: { adapterId, contractVersion: "1.0.0", capabilities: [...FRAMEWORK_ADAPTER_CAPABILITIES] },
    invoke: async () => ({ status: "completed", output: null }),
    resume: async () => ({ status: "completed", output: null }),
    cancel: async () => {},
  };
}

afterEach(() => vi.useRealTimers());

describe("private framework adapter registration", () => {
  it("preserves receiver binding while freezing the published descriptor", async () => {
    const candidate = adapter();
    candidate.cancel = async function () { expect(this).toBe(candidate); };
    const registry = new FrameworkAdapterRegistry();
    await registry.register([async () => candidate], { timeoutMs: 100 });
    await registry.get("reference")?.cancel("run-1");
    expect(Object.isFrozen(registry.get("reference")?.descriptor.capabilities)).toBe(true);
  });

  it("publishes only after every loader is ready and preserves the old collection on failure", async () => {
    const registry = new FrameworkAdapterRegistry();
    await registry.register([async () => adapter("existing")], { timeoutMs: 1000 });
    let resolvePending!: (port: FrameworkAdapterPort) => void;
    const pending = registry.register([async () => adapter("first"), () => new Promise((resolve) => { resolvePending = resolve; })], { timeoutMs: 1000 });
    await Promise.resolve();
    expect(registry.get("first")).toBeUndefined();
    resolvePending(adapter("second"));
    await pending;
    expect(registry.get("first")).toBeDefined();
    expect(registry.get("second")).toBeDefined();
    await expect(registry.register([async () => adapter("new"), async () => { throw new Error("internal details"); }], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED" });
    expect(registry.get("new")).toBeUndefined();
    expect(registry.get("existing")).toBeDefined();
  });

  it.each(["cancel", "waitResume", "checkpoint"])("rejects missing %s capability", async (capability) => {
    const registry = new FrameworkAdapterRegistry();
    const candidate = adapter();
    candidate.descriptor.capabilities = candidate.descriptor.capabilities.filter((entry) => entry !== capability);
    await expect(registry.register([async () => candidate], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ADAPTER_UNSUPPORTED" });
    expect(registry.get("reference")).toBeUndefined();
  });

  it("rejects unknown versions and duplicate identifiers", async () => {
    const registry = new FrameworkAdapterRegistry();
    const candidate = adapter();
    candidate.descriptor.contractVersion = "2.0.0";
    await expect(registry.register([async () => candidate], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ADAPTER_UNSUPPORTED" });
    await expect(registry.register([async () => adapter(), async () => adapter()], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ADAPTER_DUPLICATE" });
    expect(registry.get("reference")).toBeUndefined();
  });

  it("bounds initialization and ignores late completion", async () => {
    vi.useFakeTimers();
    const registry = new FrameworkAdapterRegistry();
    let resolvePending!: (port: FrameworkAdapterPort) => void;
    let initializationSignal: AbortSignal | undefined;
    const pending = registry.register([(signal) => { initializationSignal = signal; return new Promise((resolve) => { resolvePending = resolve; }); }], { timeoutMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({ code: "ADAPTER_OPERATION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(initializationSignal?.aborted).toBe(true);
    resolvePending(adapter());
    await Promise.resolve();
    expect(registry.get("reference")).toBeUndefined();
  });

  it("cancels initialization without partial publication", async () => {
    const registry = new FrameworkAdapterRegistry();
    const controller = new AbortController();
    const pending = registry.register([async () => adapter("first"), () => new Promise(() => {})], { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(registry.get("first")).toBeUndefined();
  });
});
