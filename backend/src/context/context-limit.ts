import type { LlmCapabilities } from "../platform/llm-gateway.js";
import { ContextHardLimitError } from "./context-errors.js";

export interface ContextLimitConfig {
  contextBudgetTotal: number;
  contextOutputReserveTokens: number;
}

export interface EffectiveContextLimit {
  effectiveLimit: number;
  outputReserve: number;
  reasonCode?: "provider_window_unknown";
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function resolveEffectiveContextLimit(
  config: ContextLimitConfig,
  capabilities: Pick<LlmCapabilities, "contextWindowTokens" | "maxOutputTokens">
): EffectiveContextLimit {
  if (
    !isPositiveInteger(config.contextBudgetTotal) ||
    !isPositiveInteger(config.contextOutputReserveTokens) ||
    !Number.isSafeInteger(capabilities.contextWindowTokens) ||
    capabilities.contextWindowTokens < 0 ||
    !Number.isSafeInteger(capabilities.maxOutputTokens) ||
    capabilities.maxOutputTokens < 0
  ) {
    throw new ContextHardLimitError(
      "context_config_invalid",
      "Context limits must be safe non-negative integers."
    );
  }

  const outputReserve = Math.max(
    config.contextOutputReserveTokens,
    capabilities.maxOutputTokens
  );
  if (capabilities.contextWindowTokens === 0) {
    return {
      effectiveLimit: config.contextBudgetTotal,
      outputReserve,
      reasonCode: "provider_window_unknown",
    };
  }
  if (outputReserve >= capabilities.contextWindowTokens) {
    throw new ContextHardLimitError(
      "context_config_invalid",
      "The output reserve must be smaller than the provider context window.",
      { outputReserve, contextWindowTokens: capabilities.contextWindowTokens }
    );
  }
  return {
    effectiveLimit: Math.min(
      config.contextBudgetTotal,
      capabilities.contextWindowTokens - outputReserve
    ),
    outputReserve,
  };
}
