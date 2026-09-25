import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RuntimeToolDescriptor } from "./runtime-tool-descriptor.js";
import { RuntimeToolDescriptorRegistry } from "./runtime-tool-descriptor.js";

const inputSchema = z.object({ value: z.string() }).strict();
const outputSchema = z.string();

function createReadOnlyDescriptor(
  overrides: Partial<RuntimeToolDescriptor<{ value: string }, string>> = {}
): RuntimeToolDescriptor<{ value: string }, string> {
  return {
    toolName: "read_tool",
    toolVersion: "1.0",
    inputSchema,
    outputSchema,
    riskTier: "read",
    isReadOnly: true,
    isConcurrencySafe: () => true,
    timeoutPolicy: { timeoutMs: 1_000 },
    retryPolicy: {
      maxAttempts: 2,
      maxElapsedMs: 5_000,
      retryableCategories: ["timeout"],
      backoffStrategy: "fixed",
      jitter: false,
    },
    interruptBehavior: "cancel_safe",
    ...overrides,
  };
}

describe("RuntimeToolDescriptorRegistry", () => {
  it("registers and resolves a descriptor from one registry", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = createReadOnlyDescriptor();

    registry.register(
      { toolName: "read_tool", toolVersion: "1.0" },
      descriptor
    );

    expect(registry.resolve("read_tool")).toBe(descriptor);
    expect(registry.list()).toEqual([descriptor]);
  });

  it("registers valid rate-limit and circuit-breaker policies", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = createReadOnlyDescriptor({
      rateLimitPolicy: {
        maxRequestsPerWindow: 10,
        windowMs: 1_000,
      },
      circuitBreakerPolicy: {
        failureThreshold: 3,
        successThreshold: 2,
        resetTimeoutMs: 30_000,
        halfOpenMaxProbes: 2,
      },
    });

    expect(() =>
      registry.register(
        { toolName: "read_tool", toolVersion: "1.0" },
        descriptor
      )
    ).not.toThrow();
    expect(registry.resolve("read_tool")).toBe(descriptor);
  });

  it("keeps existing descriptors valid when resilience policies are omitted", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = createReadOnlyDescriptor();

    registry.register(
      { toolName: "read_tool", toolVersion: "1.0" },
      descriptor
    );

    expect(registry.resolve("read_tool")).toMatchObject({
      toolName: "read_tool",
      toolVersion: "1.0",
    });
  });

  it.each([
    ["rateLimitPolicy.maxRequestsPerWindow", { rateLimitPolicy: { maxRequestsPerWindow: 0, windowMs: 1_000 } }],
    ["rateLimitPolicy.windowMs", { rateLimitPolicy: { maxRequestsPerWindow: 1, windowMs: -1 } }],
    ["circuitBreakerPolicy.failureThreshold", { circuitBreakerPolicy: { failureThreshold: 0, successThreshold: 1, resetTimeoutMs: 1_000, halfOpenMaxProbes: 1 } }],
    ["circuitBreakerPolicy.successThreshold", { circuitBreakerPolicy: { failureThreshold: 1, successThreshold: 1.5, resetTimeoutMs: 1_000, halfOpenMaxProbes: 1 } }],
    ["circuitBreakerPolicy.resetTimeoutMs", { circuitBreakerPolicy: { failureThreshold: 1, successThreshold: 1, resetTimeoutMs: 0, halfOpenMaxProbes: 1 } }],
    ["circuitBreakerPolicy.halfOpenMaxProbes", { circuitBreakerPolicy: { failureThreshold: 1, successThreshold: 1, resetTimeoutMs: 1_000, halfOpenMaxProbes: -1 } }],
  ])("fails closed for invalid %s", (fieldName, overrides) => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = createReadOnlyDescriptor(
      overrides as Partial<RuntimeToolDescriptor<{ value: string }, string>>
    );

    expect(() =>
      registry.register(
        { toolName: "read_tool", toolVersion: "1.0" },
        descriptor
      )
    ).toThrow(fieldName);
  });

  it("fails closed for a malformed policy type received at runtime", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = {
      ...createReadOnlyDescriptor(),
      rateLimitPolicy: {
        maxRequestsPerWindow: "ten",
        windowMs: 1_000,
      },
    } as unknown as RuntimeToolDescriptor<{ value: string }, string>;

    expect(() =>
      registry.register(
        { toolName: "read_tool", toolVersion: "1.0" },
        descriptor
      )
    ).toThrow("rateLimitPolicy.maxRequestsPerWindow");
  });

  it("fails closed when descriptor identity does not match the registered tool", () => {
    const registry = new RuntimeToolDescriptorRegistry();

    expect(() =>
      registry.register(
        { toolName: "actual_tool", toolVersion: "1.0" },
        createReadOnlyDescriptor()
      )
    ).toThrow("Runtime tool descriptor identity mismatch");
  });

  it("fails closed when a mutation descriptor omits side-effect semantics", () => {
    const registry = new RuntimeToolDescriptorRegistry();
    const descriptor = createReadOnlyDescriptor({
      toolName: "mutation_tool",
      isReadOnly: false,
      riskTier: "write",
    });

    expect(() =>
      registry.register(
        { toolName: "mutation_tool", toolVersion: "1.0" },
        descriptor
      )
    ).toThrow("Mutation runtime tool descriptor requires sideEffect");
  });

  it("does not synthesize a descriptor for an unknown tool", () => {
    const registry = new RuntimeToolDescriptorRegistry();

    expect(registry.resolve("unknown_tool")).toBeNull();
  });
});
