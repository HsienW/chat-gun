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
