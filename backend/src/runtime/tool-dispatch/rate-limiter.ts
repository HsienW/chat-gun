import type { ToolRateLimitPolicy } from "./runtime-tool-descriptor.js";

export type RateLimitDecision =
  | { type: "allow" }
  | { type: "defer"; retryAfterMs: number }
  | { type: "deny"; errorCode: "TOOL_RATE_LIMITED" };

export interface ToolRateLimiter {
  check(
    toolName: string,
    policy: ToolRateLimitPolicy | undefined,
    signal?: AbortSignal
  ): RateLimitDecision;
}

interface ToolWindowState {
  windowStartedAt: number;
  requestCount: number;
  maxRequestsPerWindow: number;
  windowMs: number;
}

export class FixedWindowToolRateLimiter implements ToolRateLimiter {
  private readonly windows = new Map<string, ToolWindowState>();

  constructor(
    private readonly toolRetryAfterMaxMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(toolRetryAfterMaxMs) || toolRetryAfterMaxMs <= 0) {
      throw new Error("toolRetryAfterMaxMs must be a positive integer");
    }
  }

  check(
    toolName: string,
    policy: ToolRateLimitPolicy | undefined,
    signal?: AbortSignal
  ): RateLimitDecision {
    signal?.throwIfAborted();
    if (policy === undefined) {
      return { type: "allow" };
    }

    const checkedAt = this.now();
    const currentWindow = this.windows.get(toolName);
    const shouldStartWindow =
      currentWindow === undefined ||
      checkedAt >= currentWindow.windowStartedAt + currentWindow.windowMs ||
      currentWindow.maxRequestsPerWindow !== policy.maxRequestsPerWindow ||
      currentWindow.windowMs !== policy.windowMs;

    if (shouldStartWindow) {
      this.windows.set(toolName, {
        windowStartedAt: checkedAt,
        requestCount: 1,
        maxRequestsPerWindow: policy.maxRequestsPerWindow,
        windowMs: policy.windowMs,
      });
      return { type: "allow" };
    }

    if (currentWindow.requestCount < policy.maxRequestsPerWindow) {
      currentWindow.requestCount += 1;
      return { type: "allow" };
    }

    const windowEndsAt = currentWindow.windowStartedAt + currentWindow.windowMs;
    return {
      type: "defer",
      retryAfterMs: Math.min(
        Math.max(0, windowEndsAt - checkedAt),
        this.toolRetryAfterMaxMs
      ),
    };
  }
}

export type { ToolRateLimitPolicy } from "./runtime-tool-descriptor.js";
