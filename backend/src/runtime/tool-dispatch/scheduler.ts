export type ConcurrencyClassification = "concurrent_safe" | "serial";

export interface ResilienceSchedulingOptions {
  runId?: string;
  signal?: AbortSignal;
}

export interface ToolDispatchScheduler {
  schedule<TResult>(
    classification: ConcurrencyClassification,
    operation: () => Promise<TResult>,
    options?: ResilienceSchedulingOptions
  ): Promise<TResult>;
}

export interface ToolDispatchSchedulerCapacity {
  maxConcurrentReads: number;
  maxConcurrentReadsPerRun: number;
}

export type ToolSchedulingErrorCode =
  | "TOOL_RUN_CAPACITY_EXCEEDED"
  | "USER_CANCELLED";

export class ToolSchedulingError extends Error {
  readonly code: ToolSchedulingErrorCode;

  constructor(code: ToolSchedulingErrorCode) {
    super(code);
    this.name = "ToolSchedulingError";
    this.code = code;
  }
}

interface ReadWaiter {
  grant(): void;
  cancel(): void;
}

interface RunCapacity {
  active: number;
  max: number;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ToolSchedulingError("USER_CANCELLED");
  }
}

async function waitForTurn(
  turn: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfCancelled(signal);
  if (signal === undefined) {
    await turn;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new ToolSchedulingError("USER_CANCELLED"));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    turn.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export class BoundedToolDispatchScheduler implements ToolDispatchScheduler {
  private serialTail: Promise<void> = Promise.resolve();
  private activeReads = 0;
  private readonly readWaiters: ReadWaiter[] = [];
  private readonly runCapacities = new Map<string, RunCapacity>();
  private readonly maxConcurrentReads: number;
  private readonly maxConcurrentReadsPerRun: number;

  constructor(capacity: ToolDispatchSchedulerCapacity) {
    validateCapacity(capacity.maxConcurrentReads, "maxConcurrentReads");
    validateCapacity(
      capacity.maxConcurrentReadsPerRun,
      "maxConcurrentReadsPerRun"
    );
    this.maxConcurrentReads = capacity.maxConcurrentReads;
    this.maxConcurrentReadsPerRun = capacity.maxConcurrentReadsPerRun;
  }

  async schedule<TResult>(
    classification: ConcurrencyClassification,
    operation: () => Promise<TResult>,
    options: ResilienceSchedulingOptions = {}
  ): Promise<TResult> {
    return classification === "concurrent_safe" && options.runId !== undefined
      ? this.runBoundedRead(options.runId, operation, options.signal)
      : this.runSerial(operation, options.signal);
  }

  getTrackedRunCount(): number {
    return this.runCapacities.size;
  }

  private async runSerial<TResult>(
    operation: () => Promise<TResult>,
    signal: AbortSignal | undefined
  ): Promise<TResult> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.serialTail;
    this.serialTail = previous.then(() => slot);
    try {
      await waitForTurn(previous, signal);
      throwIfCancelled(signal);
      return await operation();
    } finally {
      release();
    }
  }

  private async runBoundedRead<TResult>(
    runId: string,
    operation: () => Promise<TResult>,
    signal: AbortSignal | undefined
  ): Promise<TResult> {
    this.reserveRunCapacity(runId);
    let hasReadSlot = false;
    try {
      await this.acquireReadSlot(signal);
      hasReadSlot = true;
      throwIfCancelled(signal);
      return await operation();
    } finally {
      if (hasReadSlot) {
        this.releaseReadSlot();
      }
      this.releaseRunCapacity(runId);
    }
  }

  private reserveRunCapacity(runId: string): void {
    const current = this.runCapacities.get(runId) ?? {
      active: 0,
      max: this.maxConcurrentReadsPerRun,
    };
    if (current.active >= current.max) {
      throw new ToolSchedulingError("TOOL_RUN_CAPACITY_EXCEEDED");
    }
    this.runCapacities.set(runId, {
      ...current,
      active: current.active + 1,
    });
  }

  private releaseRunCapacity(runId: string): void {
    const current = this.runCapacities.get(runId);
    if (current === undefined) {
      return;
    }
    const active = current.active - 1;
    if (active <= 0) {
      this.runCapacities.delete(runId);
      return;
    }
    this.runCapacities.set(runId, { ...current, active });
  }

  private async acquireReadSlot(signal: AbortSignal | undefined): Promise<void> {
    throwIfCancelled(signal);
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let isSettled = false;
      const onAbort = () => waiter.cancel();
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const waiter: ReadWaiter = {
        grant: () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          this.activeReads += 1;
          resolve();
        },
        cancel: () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          const index = this.readWaiters.indexOf(waiter);
          if (index >= 0) {
            this.readWaiters.splice(index, 1);
          }
          reject(new ToolSchedulingError("USER_CANCELLED"));
        },
      };
      this.readWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        waiter.cancel();
      }
    });
  }

  private releaseReadSlot(): void {
    this.activeReads -= 1;
    this.readWaiters.shift()?.grant();
  }
}

function validateCapacity(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}
