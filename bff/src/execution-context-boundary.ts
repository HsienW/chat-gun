const RESERVED_CONFIG_KEYS = new Set([
  "execution_context", "taskId", "task_id", "stepId", "step_id",
  "toolCallId", "tool_call_id", "toolExecutionId", "tool_execution_id",
  "requestId", "request_id", "x-request-id", "runId", "run_id", "threadId", "thread_id",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasReservedConfig(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const record = pending.pop();
    if (Array.isArray(record)) {
      for (const element of record) pending.push(element);
      continue;
    }
    if (!isRecord(record)) continue;
    for (const [key, nested] of Object.entries(record)) {
      if (RESERVED_CONFIG_KEYS.has(key) || key.toLowerCase().startsWith("x-bff-")) return true;
      if (nested !== null && typeof nested === "object") pending.push(nested);
    }
  }
  return false;
}

export function containsUntrustedExecutionContext(body: Buffer | undefined): boolean {
  if (!body?.length) return false;
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return false; }
  const requests = Array.isArray(payload) ? payload : [payload];
  return requests.some((request) => {
    if (!isRecord(request)) return false;
    if ([request.config, request.configurable, request.metadata].some(hasReservedConfig)) return true;
    return [request.input, request.values].some((state) =>
      isRecord(state) && ("executionTaskId" in state),
    );
  });
}
