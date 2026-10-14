import { describe, expect, it } from "vitest";

import { ExecutionProfileRegistry } from "../../runtime/tool-dispatch/execution-profile.js";
import { createLocalToolRiskPolicies } from "../authorization/tool-authorization.js";
import {
  createLocalExecutionProfileRegistry,
  createLocalRuntimeToolDescriptorRegistry,
  createLocalRuntimeToolDescriptors,
  LOCAL_PRODUCTION_TOOLS,
} from "../production-runtime-tool-descriptors.js";
import {
  CurrentWeatherRegistrationError,
  stageCurrentWeatherSdkDescriptor,
} from "./current-weather-manifest-adapter.js";

function fixture() {
  const descriptor = createLocalRuntimeToolDescriptors().find((entry) => entry.toolName === "current_weather");
  const tool = LOCAL_PRODUCTION_TOOLS.find((entry) => entry.name === "current_weather");
  const riskPolicy = createLocalToolRiskPolicies().find((entry) => entry.toolName === "current_weather");
  if (!descriptor || !tool || !riskPolicy) throw new Error("Current weather fixture is incomplete");
  return { descriptor, tool, riskPolicy, profileRegistry: createLocalExecutionProfileRegistry() };
}

describe("current_weather trusted SDK manifest adapter", () => {
  it("stages the same descriptor in the same registry with additive provenance", async () => {
    const input = fixture();
    const staged = await stageCurrentWeatherSdkDescriptor(input);
    const legacyRegistry = createLocalRuntimeToolDescriptorRegistry();
    const sdkRegistry = createLocalRuntimeToolDescriptorRegistry(
      createLocalRuntimeToolDescriptors().map((entry) => entry.toolName === "current_weather" ? staged : entry)
    );
    expect(legacyRegistry.list()).toHaveLength(sdkRegistry.list().length);
    expect(sdkRegistry.resolve("current_weather")).toBe(staged);
    const { manifestVersion, ...withoutProvenance } = staged;
    expect(manifestVersion).toBe("1.0.0");
    expect(withoutProvenance).toEqual(input.descriptor);
    expect(staged.inputSchema.safeParse({}).success).toBe(input.descriptor.inputSchema.safeParse({}).success);
  });

  it.each([
    ["missing policy", (input: ReturnType<typeof fixture>) => ({ ...input, riskPolicy: null }), "HOST_POLICY_MISSING"],
    ["missing action", (input: ReturnType<typeof fixture>) => ({ ...input, riskPolicy: { ...input.riskPolicy, actions: [] } }), "HOST_POLICY_MISSING"],
    ["missing profile", (input: ReturnType<typeof fixture>) => ({ ...input, profileRegistry: new ExecutionProfileRegistry() }), "HOST_PROFILE_MISSING"],
    ["timeout drift", (input: ReturnType<typeof fixture>) => ({ ...input, descriptor: { ...input.descriptor, timeoutPolicy: { timeoutMs: 1 } } }), "HOST_TIMEOUT_RETRY_UNSUPPORTED"],
    ["schema drift", (input: ReturnType<typeof fixture>) => ({ ...input, descriptor: { ...input.descriptor, inputSchema: { safeParse: () => ({ success: true as const, data: null }) } } }), "HOST_DESCRIPTOR_MISMATCH"],
  ] as const)("rejects %s before publishing a descriptor", async (_name, alter, code) => {
    await expect(stageCurrentWeatherSdkDescriptor(alter(fixture()))).rejects.toMatchObject({
      name: CurrentWeatherRegistrationError.name,
      code,
    });
  });
});
