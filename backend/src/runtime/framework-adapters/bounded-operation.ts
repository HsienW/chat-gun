export type AdapterErrorCode =
  | "ADAPTER_OPERATION_TIMEOUT" | "ADAPTER_OPERATION_CANCELLED" | "ADAPTER_OPERATION_FAILED"
  | "ADAPTER_INVALID_DEADLINE" | "ADAPTER_UNSUPPORTED" | "ADAPTER_INVALID" | "ADAPTER_DUPLICATE"
  | "COMPOSITION_DEPENDENCY_UNAVAILABLE" | "COMPOSITION_VERSION_UNSUPPORTED" | "COMPOSITION_BUSY"
  | "CHECKPOINT_STATE_INVALID" | "CHECKPOINT_PARKED" | "CHECKPOINT_NOT_FOUND"
  | "ADAPTER_INITIALIZATION_FAILED" | "ADAPTER_NODE_FAILED" | "ADAPTER_STEP_LIMIT"
  | "ADAPTER_STREAM_INTERRUPTED" | "ADAPTER_EVENT_INVALID" | "ADAPTER_EVENT_CONFLICT" | "ADAPTER_EVENT_LIMIT";

export class FrameworkAdapterError extends Error {
  readonly name = "FrameworkAdapterError";
  constructor(readonly code: AdapterErrorCode) { super(code); }
}

export interface BoundedOperationOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export async function runBoundedAdapterOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: BoundedOperationOptions,
): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) throw new FrameworkAdapterError("ADAPTER_INVALID_DEADLINE");
  if (options.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
  const controller = new AbortController();
  let rejectAbort!: (reason: FrameworkAdapterError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (code: "ADAPTER_OPERATION_TIMEOUT" | "ADAPTER_OPERATION_CANCELLED") => {
    const error = new FrameworkAdapterError(code);
    rejectAbort(error);
    controller.abort(error);
  };
  const onCancel = () => abort("ADAPTER_OPERATION_CANCELLED");
  options.signal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => abort("ADAPTER_OPERATION_TIMEOUT"), options.timeoutMs);
  try {
    const output = await Promise.race([operation(controller.signal), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return output;
  } catch (error) {
    controller.abort(error);
    if (error instanceof FrameworkAdapterError) throw error;
    throw new FrameworkAdapterError("ADAPTER_OPERATION_FAILED");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}
