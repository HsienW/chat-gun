import type { RetryPolicy } from "@gun-ai/harness-contracts";

export type { RetryPolicy } from "@gun-ai/harness-contracts";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 60_000,
  retryableCategories: ["timeout", "rate_limit", "server_error"],
  backoffStrategy: "exponential",
  jitter: true,
};
