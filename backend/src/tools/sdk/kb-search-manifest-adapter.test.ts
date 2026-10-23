import { describe, expect, it } from "vitest";

import { createLocalToolRiskPolicies } from "../authorization/tool-authorization.js";
import {
  createLocalExecutionProfileRegistry,
  createLocalRuntimeToolDescriptors,
  LOCAL_PRODUCTION_TOOLS,
} from "../production-runtime-tool-descriptors.js";
import { knowledgeEgressDestinations, readKnowledgeConfig } from "../../knowledge/config.js";
import { stageKbSearchSdkDescriptor } from "./kb-search-manifest-adapter.js";

const EXPECTED_DESTINATIONS = knowledgeEgressDestinations(readKnowledgeConfig());

function stagingInput() {
  const descriptor = createLocalRuntimeToolDescriptors().find((candidate) => candidate.toolName === "kb_search");
  const tool = LOCAL_PRODUCTION_TOOLS.find((candidate) => candidate.name === "kb_search");
  const riskPolicy = createLocalToolRiskPolicies().find((policy) => policy.toolName === "kb_search") ?? null;
  if (descriptor === undefined || tool === undefined) throw new Error("kb_search is not registered locally");
  return { tool, descriptor, riskPolicy, profileRegistry: createLocalExecutionProfileRegistry() };
}

describe("kb_search SDK manifest staging", () => {
  it("registers a complete read-only manifest that resolves through trusted host contracts", async () => {
    const staged = await stageKbSearchSdkDescriptor(stagingInput());
    expect(staged).toMatchObject({ toolName: "kb_search", isReadOnly: true, riskTier: "read" });
    expect(staged.manifestVersion).toBeDefined();
    expect(staged.secretRequirements).toEqual([{ secretRef: "env:QWEN_API_KEY", secretName: "QWEN_API_KEY", scope: "tool:kb_search" }]);
    expect(staged.egressRequirements?.destinations).toEqual(EXPECTED_DESTINATIONS);
  });

  it("uses a trusted in-process profile whose egress only reaches the model service", () => {
    const { descriptor, profileRegistry } = stagingInput();
    const profile = descriptor.executionProfileRef ? profileRegistry.resolve(descriptor.executionProfileRef) : null;
    expect(profile).toMatchObject({
      mode: "trusted_in_process",
      filesystem: { writeMode: "read_only" },
      process: { creation: "deny" },
      env: { allowedVariables: ["QWEN_API_KEY"] },
    });
    expect(profile?.egress.destinations).toEqual(EXPECTED_DESTINATIONS);
  });

  it.each([
    ["the secret requirement is missing", (input: ReturnType<typeof stagingInput>) => ({ ...input, descriptor: { ...input.descriptor, secretRequirements: [] } }), "HOST_SECRET_MISSING"],
    ["the risk policy is missing", (input: ReturnType<typeof stagingInput>) => ({ ...input, riskPolicy: null }), "HOST_POLICY_MISSING"],
    [
      "egress differs from the profile",
      (input: ReturnType<typeof stagingInput>) => ({ ...input, descriptor: { ...input.descriptor, egressRequirements: { destinations: ["evil.example"], protocols: ["https" as const] } } }),
      "HOST_PROFILE_MISSING",
    ],
    ["the tool claims a side effect", (input: ReturnType<typeof stagingInput>) => ({ ...input, descriptor: { ...input.descriptor, isReadOnly: false } }), "HOST_DESCRIPTOR_MISMATCH"],
  ])("fails closed when %s", async (_name, mutate, code) => {
    await expect(stageKbSearchSdkDescriptor(mutate(stagingInput()))).rejects.toMatchObject({ code });
  });
});
