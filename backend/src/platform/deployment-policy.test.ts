import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deploymentPolicySchema,
  loadDeploymentPolicy,
} from "./deployment-policy.js";

const VALID_POLICY = {
  version: "1",
  availabilityTarget: 0.999,
  latencyBudgetMs: 2_000,
  errorBudgetRatio: 0.001,
  recoveryTimeObjectiveMs: 60_000,
  recoveryPointObjectiveMs: 30_000,
  backupCadenceMs: 15_000,
  retentionMs: 604_800_000,
  restoreDrill: {
    maximumRecoveryTimeMs: 60_000,
    maximumRecoveryPointMs: 30_000,
  },
  multiInstanceEnabled: true,
} as const;

describe("deployment policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses a complete versioned policy", () => {
    expect(deploymentPolicySchema.parse(VALID_POLICY)).toEqual(VALID_POLICY);
  });

  it("fails closed for unknown fields", () => {
    expect(() =>
      deploymentPolicySchema.parse({ ...VALID_POLICY, futureField: true })
    ).toThrow();
  });

  it("rejects an RTO lower than the RPO", () => {
    expect(() =>
      deploymentPolicySchema.parse({
        ...VALID_POLICY,
        recoveryTimeObjectiveMs: 10_000,
        recoveryPointObjectiveMs: 20_000,
      })
    ).toThrow("recoveryTimeObjectiveMs must be greater than or equal to recoveryPointObjectiveMs");
  });

  it("loads DEPLOYMENT_POLICY_JSON and marks it as explicit", () => {
    vi.stubEnv("DEPLOYMENT_POLICY_JSON", JSON.stringify(VALID_POLICY));

    expect(loadDeploymentPolicy()).toEqual({
      source: "environment",
      policy: VALID_POLICY,
    });
  });

  it("uses a safe single-instance default and marks it as default", () => {
    vi.stubEnv("DEPLOYMENT_POLICY_JSON", "");

    const loaded = loadDeploymentPolicy();
    expect(loaded.source).toBe("default");
    expect(loaded.policy.multiInstanceEnabled).toBe(false);
    expect(loaded.policy.recoveryTimeObjectiveMs).toBeGreaterThanOrEqual(
      loaded.policy.recoveryPointObjectiveMs
    );
  });

  it("fails closed for invalid JSON", () => {
    vi.stubEnv("DEPLOYMENT_POLICY_JSON", "{");
    expect(() => loadDeploymentPolicy()).toThrow("DEPLOYMENT_POLICY_JSON must be valid JSON");
  });
});
