const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 30_000;
const JITTER_MIN_FACTOR = 0.75;
const JITTER_RANGE = 0.5;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number;
  jitter?: boolean;
}

export type BackoffStrategy = "exponential" | "fixed" | "retry-after-header";

function exponentialDelay(attempt: number, baseMs: number, maxMs: number): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(baseMs * 2 ** (normalizedAttempt - 1), maxMs);
}

export function computeBackoff(
  strategy: BackoffStrategy,
  attempt: number,
  options: BackoffOptions = {}
): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  let delay: number;

  switch (strategy) {
    case "fixed":
      delay = baseMs;
      break;
    case "retry-after-header":
      delay =
        options.retryAfterMs === undefined
          ? exponentialDelay(attempt, baseMs, maxMs)
          : Math.min(options.retryAfterMs, maxMs);
      break;
    case "exponential":
      delay = exponentialDelay(attempt, baseMs, maxMs);
      break;
  }

  if (options.jitter === false) {
    return delay;
  }

  const jitteredDelay = delay * (JITTER_MIN_FACTOR + Math.random() * JITTER_RANGE);
  return strategy === "retry-after-header"
    ? Math.min(jitteredDelay, maxMs)
    : jitteredDelay;
}
