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
  signalStatus: "available" | "degraded";
  queueDepth?: number;
  activeRunCount?: number;
  stuckRunCount?: number;
  workerSaturation?: number;
  heartbeatFreshnessMs?: number;
  isHeartbeatStale?: boolean;
  missingSignals: string[];
}

export interface RuntimeHealthProjectionInput {
  observedAt: string;
  runs?: readonly RuntimeRunSignal[];
  activeWorkerCount?: number;
  workerCapacity?: number;
  latestOwnershipUpdateAt?: string;
  stuckRunAfterMs: number;
  heartbeatStaleAfterMs: number;
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
    signalStatus: "available",
    missingSignals,
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

  projection.signalStatus = missingSignals.length === 0 ? "available" : "degraded";
  return projection;
}
