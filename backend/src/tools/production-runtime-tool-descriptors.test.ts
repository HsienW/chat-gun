import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_PRODUCTION_TOOL_NAMES } from "./authorization/tool-authorization.js";
import {
  createLocalRuntimeToolDescriptorRegistry,
  LOCAL_PRODUCTION_TOOLS,
} from "./production-runtime-tool-descriptors.js";

describe("local production runtime tool descriptors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers every local production tool in one descriptor registry", () => {
    const registry = createLocalRuntimeToolDescriptorRegistry();

    expect(LOCAL_PRODUCTION_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [...LOCAL_PRODUCTION_TOOL_NAMES].sort()
    );
    expect(
      registry.list().map((descriptor) => descriptor.toolName).sort()
    ).toEqual([...LOCAL_PRODUCTION_TOOL_NAMES].sort());
    expect(
      registry.list().every((descriptor) => descriptor.isReadOnly)
    ).toBe(true);
  });

  it("uses existing per-tool timeout environment overrides during assembly", () => {
    vi.stubEnv("TOOL_TIMEOUT_MS", "2000");
    vi.stubEnv("TOOL_CALCULATOR_TOOL_TIMEOUT_MS", "3456");

    const registry = createLocalRuntimeToolDescriptorRegistry();

    expect(
      registry.resolve("calculator_tool")?.timeoutPolicy.timeoutMs
    ).toBe(3456);
    expect(registry.resolve("web_search")?.timeoutPolicy.timeoutMs).toBe(2000);
  });

  it("uses runtime schemas for local tool input and output", () => {
    const registry = createLocalRuntimeToolDescriptorRegistry();
    const calculator = registry.resolve("calculator_tool");

    expect(calculator?.inputSchema.safeParse({ expression: "2+2" }).success).toBe(
      true
    );
    expect(calculator?.inputSchema.safeParse({}).success).toBe(false);
    expect(calculator?.outputSchema.safeParse("4").success).toBe(true);
    expect(calculator?.outputSchema.safeParse(4).success).toBe(false);
  });
});
