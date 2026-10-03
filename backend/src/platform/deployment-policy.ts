import { z } from "zod";

import { getEnv } from "./env.js";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const deploymentPolicySchema = z
  .object({
    version: z.literal("1"),
    availabilityTarget: z.number().min(0).max(1),
    latencyBudgetMs: positiveSafeInteger,
    errorBudgetRatio: z.number().min(0).max(1),
    recoveryTimeObjectiveMs: positiveSafeInteger,
    recoveryPointObjectiveMs: positiveSafeInteger,
    backupCadenceMs: positiveSafeInteger,
    retentionMs: positiveSafeInteger,
    restoreDrill: z
      .object({
        maximumRecoveryTimeMs: positiveSafeInteger,
        maximumRecoveryPointMs: positiveSafeInteger,
      })
      .strict(),
    multiInstanceEnabled: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.recoveryTimeObjectiveMs < policy.recoveryPointObjectiveMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoveryTimeObjectiveMs"],
        message:
          "recoveryTimeObjectiveMs must be greater than or equal to recoveryPointObjectiveMs",
      });
    }
    if (policy.retentionMs < policy.backupCadenceMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionMs"],
        message: "retentionMs must be greater than or equal to backupCadenceMs",
      });
    }
  });

export type DeploymentPolicy = z.infer<typeof deploymentPolicySchema>;

export type LoadedDeploymentPolicy =
  | { source: "default"; policy: DeploymentPolicy }
  | { source: "environment"; policy: DeploymentPolicy };

function createSafeDefaultPolicy(): DeploymentPolicy {
  const noDeclaredRecoveryTarget = Number.MAX_SAFE_INTEGER;
  return {
    version: "1",
    availabilityTarget: 0,
    latencyBudgetMs: noDeclaredRecoveryTarget,
    errorBudgetRatio: 1,
    recoveryTimeObjectiveMs: noDeclaredRecoveryTarget,
    recoveryPointObjectiveMs: noDeclaredRecoveryTarget,
    backupCadenceMs: noDeclaredRecoveryTarget,
    retentionMs: noDeclaredRecoveryTarget,
    restoreDrill: {
      maximumRecoveryTimeMs: noDeclaredRecoveryTarget,
      maximumRecoveryPointMs: noDeclaredRecoveryTarget,
    },
    multiInstanceEnabled: false,
  };
}

export function loadDeploymentPolicy(): LoadedDeploymentPolicy {
  const rawPolicy = getEnv("DEPLOYMENT_POLICY_JSON").trim();
  if (!rawPolicy) {
    return {
      source: "default",
      policy: deploymentPolicySchema.parse(createSafeDefaultPolicy()),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawPolicy);
  } catch {
    throw new Error("DEPLOYMENT_POLICY_JSON must be valid JSON");
  }

  return {
    source: "environment",
    policy: deploymentPolicySchema.parse(decoded),
  };
}
