export const RUNTIME_RUN_STATUSES = [
  "pending",
  "running",
  "error",
  "success",
  "timeout",
  "interrupted",
] as const;

export type RuntimeRunStatus = (typeof RUNTIME_RUN_STATUSES)[number];

export interface RuntimeRunSignal {
  status: RuntimeRunStatus;
  updatedAt: string;
}

export interface RuntimeHealthProjection {
  alive: HealthLayer;
  reachable: HealthLayer;
  acceptNewWork: HealthLayer;
  resumeDurableWork: HealthLayer;
  degraded: { status: "normal" | "read_only"; reasonCodes: string[] };
  deploymentPolicySource: "default" | "environment";
  multiInstanceSafe: boolean;
  queueDepth?: number;
  activeRunCount?: number;
  stuckRunCount?: number;
  workerSaturation?: number;
  heartbeatFreshnessMs?: number;
  isHeartbeatStale?: boolean;
  missingSignals: string[];
}

export interface HealthLayer {
  status: "ready" | "not_ready";
  reasonCodes: string[];
}

export interface RuntimeHealthProjectionInput {
  observedAt: string;
  runs?: readonly RuntimeRunSignal[];
  activeWorkerCount?: number;
  workerCapacity?: number;
  latestOwnershipUpdateAt?: string;
  stuckRunAfterMs: number;
  heartbeatStaleAfterMs: number;
  processAlive?: boolean;
  redisReachable?: boolean;
  postgresReachable?: boolean;
  checkpointReachable?: boolean;
  recoveryReachable?: boolean;
  acceptsNewWork?: boolean;
  isDraining?: boolean;
  readOnlyDegraded?: boolean;
  deploymentPolicySource?: "default" | "environment";
  multiInstanceSafe?: boolean;
}

function elapsedMs(observedAt: string, updatedAt: string): number | undefined {
  const observedTimestamp = Date.parse(observedAt);
  const updatedTimestamp = Date.parse(updatedAt);
  if (!Number.isFinite(observedTimestamp) || !Number.isFinite(updatedTimestamp)) {
    return undefined;
  }
  return Math.max(0, observedTimestamp - updatedTimestamp);
}

export function projectRuntimeHealth(
  input: RuntimeHealthProjectionInput
): RuntimeHealthProjection {
  const missingSignals: string[] = [];
  const projection: RuntimeHealthProjection = {
    alive: {
      status: input.processAlive === false ? "not_ready" : "ready",
      reasonCodes: input.processAlive === false ? ["process_unavailable"] : [],
    },
    reachable: { status: "not_ready", reasonCodes: [] },
    acceptNewWork: { status: "not_ready", reasonCodes: [] },
    resumeDurableWork: { status: "not_ready", reasonCodes: [] },
    degraded: {
      status: input.readOnlyDegraded ? "read_only" : "normal",
      reasonCodes: input.readOnlyDegraded ? ["write_dependency_degraded"] : [],
    },
    deploymentPolicySource: input.deploymentPolicySource ?? "default",
    multiInstanceSafe: input.multiInstanceSafe ?? false,
    missingSignals,
  };

  const dependencyReasons: string[] = [];
  if (input.redisReachable !== true) dependencyReasons.push("redis_unreachable");
  if (input.postgresReachable !== true) dependencyReasons.push("postgres_unreachable");
  if (input.checkpointReachable !== true) dependencyReasons.push("checkpoint_unreachable");
  projection.reachable = {
    status: dependencyReasons.length === 0 ? "ready" : "not_ready",
    reasonCodes: dependencyReasons,
  };
  const acceptReasons = [...dependencyReasons];
  if (input.acceptsNewWork !== true) acceptReasons.push("new_work_disabled");
  if (input.isDraining) acceptReasons.push("draining");
  projection.acceptNewWork = {
    status: acceptReasons.length === 0 ? "ready" : "not_ready",
    reasonCodes: acceptReasons,
  };
  const resumeReasons = dependencyReasons.filter((reason) => reason !== "redis_unreachable");
  if (input.recoveryReachable !== true) resumeReasons.push("recovery_unreachable");
  projection.resumeDurableWork = {
    status: resumeReasons.length === 0 ? "ready" : "not_ready",
    reasonCodes: resumeReasons,
  };

  if (input.runs === undefined) {
    missingSignals.push("run_status");
  } else {
    projection.queueDepth = input.runs.filter((run) => run.status === "pending").length;
    projection.activeRunCount = input.runs.filter((run) => run.status === "running").length;
    projection.stuckRunCount = input.runs.filter((run) => {
      const age = elapsedMs(input.observedAt, run.updatedAt);
      return run.status === "running" && age !== undefined && age >= input.stuckRunAfterMs;
    }).length;
  }

  if (
    input.activeWorkerCount === undefined ||
    input.workerCapacity === undefined ||
    input.workerCapacity <= 0
  ) {
    missingSignals.push("worker_capacity");
  } else {
    projection.workerSaturation = Math.min(
      1,
      Math.max(0, input.activeWorkerCount / input.workerCapacity)
    );
  }

  const freshness = input.latestOwnershipUpdateAt === undefined
    ? undefined
    : elapsedMs(input.observedAt, input.latestOwnershipUpdateAt);
  if (freshness === undefined) {
    missingSignals.push("ownership_progress");
  } else {
    projection.heartbeatFreshnessMs = freshness;
    projection.isHeartbeatStale = freshness >= input.heartbeatStaleAfterMs;
  }

  return projection;
}
