import { z } from "zod";

const drainPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive(),
  })
  .strict();
const drainWorkSchema = z
  .object({
    taskId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    isReplaySafe: z.boolean(),
    sideEffectState: z.enum([
      "none",
      "not_started",
      "committed",
      "unknown",
    ]),
  })
  .strict();
const drainWorkListSchema = z.array(drainWorkSchema);

export type DrainWork = z.infer<typeof drainWorkSchema>;
export type DrainSettleOutcome = "completed" | "checkpointed" | "pending";
export type DrainReconciliationOutcome =
  | "reconciled"
  | "not_committed"
  | "unknown";

export interface DrainDependencies {
  stopNewClaims(): Promise<void>;
  listInFlight(): Promise<unknown>;
  settleSafeWork(
    work: DrainWork,
    signal: AbortSignal
  ): Promise<DrainSettleOutcome>;
  reconcileAmbiguousEffect(
    work: DrainWork,
    signal: AbortSignal
  ): Promise<DrainReconciliationOutcome>;
  persistRecoverableState(work: DrainWork): Promise<boolean>;
  parkManual(work: DrainWork, reasonCode: string): Promise<boolean>;
}

export interface DrainResult {
  status: "drained" | "drained_with_recovery" | "blocked";
  canShutdown: boolean;
  completedRunIds: string[];
  checkpointedRunIds: string[];
  parkedRunIds: string[];
  reconciledRunIds: string[];
  unresolvedRunIds: string[];
  timedOut: boolean;
}

interface MutableDrainResult {
  completedRunIds: string[];
  checkpointedRunIds: string[];
  parkedRunIds: string[];
  reconciledRunIds: string[];
  unresolvedRunIds: string[];
  timedOut: boolean;
}

class DrainTimeoutError extends Error {
  constructor() {
    super("DRAIN_TIMEOUT");
    this.name = "DrainTimeoutError";
  }
}

function awaitWithAbort<TResult>(
  operation: Promise<TResult>,
  signal: AbortSignal
): Promise<TResult> {
  if (signal.aborted) return Promise.reject(new DrainTimeoutError());
  return new Promise<TResult>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DrainTimeoutError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function recoverWork(
  work: DrainWork,
  dependencies: DrainDependencies,
  mutableResult: MutableDrainResult,
  reasonCode: string
): Promise<void> {
  if (work.sideEffectState !== "unknown") {
    const persisted = await dependencies.persistRecoverableState(work);
    if (persisted) {
      mutableResult.checkpointedRunIds.push(work.runId);
      return;
    }
  }
  const parked = await dependencies.parkManual(work, reasonCode);
  if (parked) {
    mutableResult.parkedRunIds.push(work.runId);
  } else {
    mutableResult.unresolvedRunIds.push(work.runId);
  }
}

async function processDrainWork(
  work: DrainWork,
  dependencies: DrainDependencies,
  signal: AbortSignal,
  mutableResult: MutableDrainResult
): Promise<void> {
  let isEffectClassified = work.sideEffectState !== "unknown";
  if (!isEffectClassified) {
    const reconciliation = await awaitWithAbort(
      dependencies.reconcileAmbiguousEffect(work, signal),
      signal
    );
    if (reconciliation === "unknown") {
      await recoverWork(
        work,
        dependencies,
        mutableResult,
        "EFFECT_UNKNOWN_AFTER_RECONCILIATION"
      );
      return;
    }
    isEffectClassified = true;
    mutableResult.reconciledRunIds.push(work.runId);
  }

  if (!isEffectClassified || !work.isReplaySafe) {
    await recoverWork(
      work,
      dependencies,
      mutableResult,
      "DRAIN_UNSAFE_WORK"
    );
    return;
  }

  const settlement = await awaitWithAbort(
    dependencies.settleSafeWork(work, signal),
    signal
  );
  if (settlement === "completed") {
    mutableResult.completedRunIds.push(work.runId);
    return;
  }
  if (settlement === "checkpointed") {
    mutableResult.checkpointedRunIds.push(work.runId);
    return;
  }
  await recoverWork(work, dependencies, mutableResult, "DRAIN_PENDING_WORK");
}

function toDrainResult(mutableResult: MutableDrainResult): DrainResult {
  const canShutdown = mutableResult.unresolvedRunIds.length === 0;
  const hasRecovery =
    mutableResult.checkpointedRunIds.length > 0 ||
    mutableResult.parkedRunIds.length > 0 ||
    mutableResult.reconciledRunIds.length > 0;
  return {
    status: !canShutdown
      ? "blocked"
      : hasRecovery
        ? "drained_with_recovery"
        : "drained",
    canShutdown,
    ...mutableResult,
  };
}

export async function drainRuntime(
  policyValue: unknown,
  dependencies: DrainDependencies
): Promise<DrainResult> {
  const policy = drainPolicySchema.parse(policyValue);
  await dependencies.stopNewClaims();
  const inFlight = drainWorkListSchema.parse(
    await dependencies.listInFlight()
  );
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new DrainTimeoutError()),
    policy.timeoutMs
  );
  timeout.unref?.();
  const mutableResult: MutableDrainResult = {
    completedRunIds: [],
    checkpointedRunIds: [],
    parkedRunIds: [],
    reconciledRunIds: [],
    unresolvedRunIds: [],
    timedOut: false,
  };

  try {
    for (let index = 0; index < inFlight.length; index += 1) {
      const work = inFlight[index];
      if (!work) continue;
      try {
        await processDrainWork(
          work,
          dependencies,
          abortController.signal,
          mutableResult
        );
      } catch (error) {
        if (!(error instanceof DrainTimeoutError)) throw error;
        mutableResult.timedOut = true;
        for (const pendingWork of inFlight.slice(index)) {
          await recoverWork(
            pendingWork,
            dependencies,
            mutableResult,
            "DRAIN_TIMEOUT"
          );
        }
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  return toDrainResult(mutableResult);
}
