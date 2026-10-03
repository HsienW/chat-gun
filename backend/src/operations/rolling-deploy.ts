import { z } from "zod";

import type { CanaryResult } from "./canary.js";
import type { DrainResult } from "./drain.js";
import { assertResumeVersionCompatible, type VersionCompatibility } from "../runtime/persistence/version-compatibility.js";

const rollingDeployPlanSchema = z.object({
  deploymentId: z.string().trim().min(1).max(128),
  oldInstanceId: z.string().trim().min(1).max(128),
  newInstanceId: z.string().trim().min(1).max(128),
}).strict();

export interface RollingDeployDependencies {
  drainOldInstance(instanceId: string): Promise<DrainResult>;
  checkResumeCompatibility(instanceId: string): Promise<VersionCompatibility>;
  runCanary(instanceId: string): Promise<CanaryResult>;
  shiftTraffic(instanceId: string): Promise<void>;
}

export type RollingDeployResult =
  | { status: "completed"; drain: DrainResult; canary: CanaryResult }
  | { status: "stopped"; reasonCode: "DRAIN_UNRESOLVED" | "VERSION_INCOMPATIBLE" | "CANARY_UNHEALTHY"; drain: DrainResult; canary?: CanaryResult };

export async function runRollingDeployment(
  planValue: unknown,
  dependencies: RollingDeployDependencies
): Promise<RollingDeployResult> {
  const plan = rollingDeployPlanSchema.parse(planValue);
  const drain = await dependencies.drainOldInstance(plan.oldInstanceId);
  if (!drain.canShutdown || drain.unresolvedRunIds.length > 0) {
    return { status: "stopped", reasonCode: "DRAIN_UNRESOLVED", drain };
  }
  try {
    assertResumeVersionCompatible(
      await dependencies.checkResumeCompatibility(plan.newInstanceId)
    );
  } catch {
    return { status: "stopped", reasonCode: "VERSION_INCOMPATIBLE", drain };
  }
  const canary = await dependencies.runCanary(plan.newInstanceId);
  if (canary.status !== "healthy") {
    return { status: "stopped", reasonCode: "CANARY_UNHEALTHY", drain, canary };
  }
  await dependencies.shiftTraffic(plan.newInstanceId);
  return { status: "completed", drain, canary };
}

export function parseRollingDeployPlan(value: unknown) {
  return rollingDeployPlanSchema.parse(value);
}
