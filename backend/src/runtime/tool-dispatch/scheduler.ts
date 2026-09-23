export interface ToolDispatchScheduler {
  schedule<TResult>(
    concurrencySafe: boolean,
    operation: () => Promise<TResult>
  ): Promise<TResult>;
}

export class BoundedToolDispatchScheduler implements ToolDispatchScheduler {
  private serialTail: Promise<void> = Promise.resolve();
  private activeReads = 0;
  private readonly readWaiters: Array<() => void> = [];

  constructor(private readonly maxConcurrentReads = 4) {
    if (!Number.isSafeInteger(maxConcurrentReads) || maxConcurrentReads < 1) {
      throw new Error("maxConcurrentReads must be a positive integer");
    }
  }

  async schedule<TResult>(
    concurrencySafe: boolean,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    return concurrencySafe
      ? this.runBoundedRead(operation)
      : this.runSerial(operation);
  }

  private async runSerial<TResult>(
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.serialTail;
    this.serialTail = previous.then(() => slot);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runBoundedRead<TResult>(
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    await this.acquireReadSlot();
    try {
      return await operation();
    } finally {
      this.releaseReadSlot();
    }
  }

  private async acquireReadSlot(): Promise<void> {
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.readWaiters.push(() => {
        this.activeReads += 1;
        resolve();
      });
    });
  }

  private releaseReadSlot(): void {
    this.activeReads -= 1;
    this.readWaiters.shift()?.();
  }
}
