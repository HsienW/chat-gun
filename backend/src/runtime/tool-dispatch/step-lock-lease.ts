import type { StepLock } from "../lock/step-lock.js";

export interface ToolDispatchStepLockLeaseInput {
  lock: StepLock;
  stepId: string;
  owner: string;
  ttlMs: number;
  signal?: AbortSignal;
}

export class ToolDispatchStepLockLease {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly heartbeatMs: number;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private isReleased = false;
  private extendFailed = false;
  private readonly onParentAbort: () => void;

  private constructor(private readonly input: ToolDispatchStepLockLeaseInput) {
    this.signal = this.controller.signal;
    this.heartbeatMs = Math.max(1, Math.floor(input.ttlMs / 3));
    this.onParentAbort = () => this.controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", this.onParentAbort, { once: true });
    if (input.signal?.aborted) {
      this.onParentAbort();
    }
    this.scheduleHeartbeat();
  }

  static async acquire(
    input: ToolDispatchStepLockLeaseInput
  ): Promise<ToolDispatchStepLockLease | null> {
    const acquired = await input.lock.acquire(
      input.stepId,
      input.owner,
      input.ttlMs
    );
    return acquired ? new ToolDispatchStepLockLease(input) : null;
  }

  hasExtendFailed(): boolean {
    return this.extendFailed;
  }

  async release(): Promise<void> {
    if (this.isReleased) return;
    this.isReleased = true;
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.input.signal?.removeEventListener("abort", this.onParentAbort);
    await this.input.lock.release(this.input.stepId, this.input.owner);
  }

  private scheduleHeartbeat(): void {
    if (this.isReleased || this.signal.aborted) return;
    this.heartbeatTimer = setTimeout(() => {
      void this.extend();
    }, this.heartbeatMs);
  }

  private async extend(): Promise<void> {
    if (this.isReleased || this.signal.aborted) return;
    let extended = false;
    try {
      extended = await this.input.lock.extend(
        this.input.stepId,
        this.input.owner,
        this.input.ttlMs
      );
    } catch {
      extended = false;
    }
    if (!extended) {
      this.extendFailed = true;
      this.controller.abort(new Error("TOOL_STEP_LOCK_EXTEND_FAILED"));
      return;
    }
    this.scheduleHeartbeat();
  }
}
