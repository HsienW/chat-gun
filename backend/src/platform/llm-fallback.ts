import type { StructuredToolInterface } from "@langchain/core/tools";

import type {
  ChatModelInvoker,
  ChatModelInvokeOptions,
  ChatModelOptions,
  LlmProviderName,
} from "./llm-gateway.js";
import {
  AnswerStreamRefusedError,
  isRetryBlockedByPublishedAnswer,
  toAnswerStreamInterruptedError,
} from "./answer-text-sink.js";
import { auditLogger, recordMetric } from "./observability.js";
import {
  classifyProviderError,
  isFallbackEligibleCategory,
  type ProviderErrorCategory,
} from "./provider-error-category.js";

export type RepairStrategy = "none" | "retry_once" | "retry_with_hint";

export interface ModelFallbackPolicy {
  primaryProvider: LlmProviderName;
  fallbackProviders: LlmProviderName[];
  maxTotalAttempts: number;
  repairStrategy: RepairStrategy;
  perProviderTimeoutMs: number;
  /** With an answer sink, replaces `perProviderTimeoutMs` until the first fragment is published. */
  streamFirstChunkTimeoutMs?: number;
}

export type ProviderInvoker = {
  provider: LlmProviderName;
  invoker: ChatModelInvoker;
};

export type ProviderAttemptFailure = {
  provider: LlmProviderName;
  category: ProviderErrorCategory;
  error: unknown;
};

export interface FallbackObservability {
  recordMetric(name: string, payload: Record<string, unknown>): Promise<void> | void;
  recordAudit(name: string, payload: Record<string, unknown>): Promise<void> | void;
}

const defaultObservability: FallbackObservability = {
  recordMetric,
  recordAudit: (name, payload) => auditLogger.record(name, payload),
};

export class ProviderExhaustedError extends Error {
  constructor(readonly attempts: readonly ProviderAttemptFailure[]) {
    super(
      `LLM providers exhausted: ${attempts
        .map(({ provider, category }) => `${provider}:${category}`)
        .join(", ")}`
    );
    this.name = "ProviderExhaustedError";
  }
}

function createTimeoutError(provider: LlmProviderName): Error {
  const error = Object.assign(new Error(`Provider ${provider} timed out`), {
    code: "provider_timeout",
  });
  error.name = "AbortError";
  return error;
}

async function safeObserve(
  operation: () => Promise<void> | void
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "fallback_observability_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    );
  }
}

async function invokeWithTimeout(
  providerInvoker: ProviderInvoker,
  input: unknown,
  options: ChatModelInvokeOptions | undefined,
  timeoutMs: number
) {
  const abortController = new AbortController();
  const timeoutError = createTimeoutError(providerInvoker.provider);
  // After answer text is published the attempt is governed by its own stream deadlines only.
  const timer = setTimeout(() => {
    if (options?.answerTextSink?.hasPublished) return;
    abortController.abort(timeoutError);
  }, timeoutMs);
  const onCallerAbort = () => abortController.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener(
      "abort",
      () => reject(abortController.signal.reason ?? timeoutError),
      { once: true }
    );
  });

  try {
    if (options?.signal?.aborted) {
      throw options.signal.reason;
    }
    return await Promise.race([
      providerInvoker.invoker.invoke(input, {
        ...options,
        signal: abortController.signal,
      }),
      abortPromise,
    ]);
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function attemptTimeoutMs(policy: ModelFallbackPolicy, options: ChatModelInvokeOptions | undefined): number {
  return options?.answerTextSink && policy.streamFirstChunkTimeoutMs !== undefined
    ? policy.streamFirstChunkTimeoutMs
    : policy.perProviderTimeoutMs;
}

export class FallbackChatModelInvoker implements ChatModelInvoker {
  constructor(
    private readonly providers: readonly ProviderInvoker[],
    private readonly policy: ModelFallbackPolicy,
    private readonly observability: FallbackObservability = defaultObservability
  ) {
    if (providers.length === 0) {
      throw new Error("FallbackChatModelInvoker requires at least one provider.");
    }
  }

  bindTools(
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ): ChatModelInvoker {
    const boundProviders = this.providers.map(({ provider, invoker }) => {
      if (!invoker.bindTools) {
        throw new Error(`Provider ${provider} does not support tool binding.`);
      }
      return { provider, invoker: invoker.bindTools(tools, kwargs) };
    });
    return new FallbackChatModelInvoker(
      boundProviders,
      this.policy,
      this.observability
    );
  }

  async invoke(input: unknown, options?: ChatModelInvokeOptions) {
    const attempts: ProviderAttemptFailure[] = [];
    const callId = crypto.randomUUID();
    const budget = Math.max(1, Math.trunc(this.policy.maxTotalAttempts));
    const providers = this.providers.slice(0, budget);

    await safeObserve(() =>
      this.observability.recordMetric("model.call", {
        callId,
        primaryProvider: this.policy.primaryProvider,
      })
    );

    for (let index = 0; index < providers.length; index += 1) {
      const current = providers[index];
      if (!current) break;

      try {
        return await invokeWithTimeout(
          current,
          input,
          options,
          Math.max(1, Math.trunc(attemptTimeoutMs(this.policy, options)))
        );
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        if (error instanceof AnswerStreamRefusedError) throw error;
        if (isRetryBlockedByPublishedAnswer(options)) {
          throw toAnswerStreamInterruptedError(error, "provider_fallback");
        }

        const category = classifyProviderError(error);
        if (!isFallbackEligibleCategory(category)) throw error;
        attempts.push({ provider: current.provider, category, error });

        const next = providers[index + 1];
        if (!next) break;
        const payload = {
          callId,
          fromProvider: current.provider,
          toProvider: next.provider,
          reason: category,
        };
        await safeObserve(() =>
          this.observability.recordMetric("model.fallback.attempt", payload)
        );
        await safeObserve(() =>
          this.observability.recordAudit("model.fallback.attempt", payload)
        );
      }
    }

    await safeObserve(() =>
      this.observability.recordMetric("modelFallbackExhausted", {
        callId,
        attemptCount: attempts.length,
      })
    );
    throw new ProviderExhaustedError(attempts);
  }
}
