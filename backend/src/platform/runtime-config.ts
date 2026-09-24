import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../context/context-budget.js";
import { getEnv } from "./env.js";
import type { ImAgentContextPack } from "./im-context-pack.js";

const SUPPORTED_LOCALES = ["zh-TW", "zh-CN", "en"] as const;

export type AgentLocale = (typeof SUPPORTED_LOCALES)[number];
export type LlmRepairStrategy = "none" | "retry_once" | "retry_with_hint";
export type OtelExporterProtocol = "grpc" | "http";

export type AgentRuntimeConfig = {
  locale: AgentLocale;
  timeZone: string;
  contextBudgetTotal: number;
  contextTokensPerSource: number;
  fallbackRequiredSourceCount: number;
  metricsEnabled: boolean;
  metricsBufferSize: number;
  metricsBackendUrl: string;
  llmFallbackEnabled: boolean;
  llmFallbackProviders: string[];
  llmFallbackMaxAttempts: number;
  llmFallbackTimeoutMs: number;
  llmRepairStrategy: LlmRepairStrategy;
  llmProviderResponseMaxBytes: number;
  llmToolArgumentMaxBytes: number;
  llmJsonMaxDepth: number;
  otelEnabled: boolean;
  otelServiceName: string;
  otelExporterEndpoint?: string;
  otelExporterProtocol: OtelExporterProtocol;
  otelSampleRate: number;
  /** Enables the development-only Opik tracing and evaluation integration. */
  opikEnabled: boolean;
  /** Opik Cloud API key. Undefined keeps the integration in no-op mode. */
  opikApiKey?: string;
  /** Opik workspace name. Undefined uses the SDK account default. */
  opikWorkspace?: string;
  /** Opik API base URL. */
  opikHost: string;
  /** Project name attached to Opik traces and datasets. */
  opikProjectName: string;
  /** Must remain true; false fails closed and disables Opik export. */
  opikRedactEnabled: boolean;
  /** Local directory for offline Opik evaluation result JSON files. */
  opikEvalOutputDir: string;
};

const DEFAULT_OPIK_HOST = "https://www.comet.com/opik/api";
const DEFAULT_OPIK_PROJECT_NAME = "chat-gun";
const DEFAULT_LLM_PROVIDER_RESPONSE_MAX_BYTES = 1_048_576;
const DEFAULT_LLM_TOOL_ARGUMENT_MAX_BYTES = 65_536;
const DEFAULT_LLM_JSON_MAX_DEPTH = 64;

function readPositiveInt(name: string, fallback: number): number {
  const rawValue = getEnv(name);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readLocale(): AgentLocale {
  const rawLocale = getEnv("AGENT_LOCALE", "zh-TW");
  return SUPPORTED_LOCALES.includes(rawLocale as AgentLocale)
    ? (rawLocale as AgentLocale)
    : "zh-TW";
}

function readBoolean(name: string, fallback: boolean): boolean {
  const rawValue = getEnv(name);
  if (!rawValue) return fallback;

  const normalizedValue = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalizedValue)) return true;
  if (["0", "false", "no", "off"].includes(normalizedValue)) return false;
  return fallback;
}

function readUrl(name: string, fallback: string): string {
  const rawValue = getEnv(name, fallback);
  try {
    return new URL(rawValue).toString();
  } catch {
    return new URL(fallback).toString();
  }
}

function readCsv(name: string): string[] {
  return Array.from(
    new Set(
      getEnv(name)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function readRepairStrategy(): LlmRepairStrategy {
  const value = getEnv("LLM_REPAIR_STRATEGY", "retry_once").trim();
  return value === "none" || value === "retry_once" || value === "retry_with_hint"
    ? value
    : "retry_once";
}

function readOptionalUrl(name: string): string | undefined {
  const value = getEnv(name).trim();
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function readOptionalString(name: string): string | undefined {
  const value = getEnv(name).trim();
  return value || undefined;
}

function readOtelProtocol(): OtelExporterProtocol {
  const value = getEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http").trim().toLowerCase();
  return value === "grpc" || value === "http" ? value : "http";
}

function readSampleRate(): number {
  const rawValue = getEnv("OTEL_SAMPLE_RATE").trim();
  if (!rawValue) return 1;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    locale: readLocale(),
    timeZone: getEnv("AGENT_TIME_ZONE", "Asia/Taipei"),
    contextBudgetTotal: readPositiveInt(
      "AGENT_CONTEXT_BUDGET_TOTAL",
      DEFAULT_CONTEXT_TOKEN_BUDGET
    ),
    contextTokensPerSource: readPositiveInt("AGENT_CONTEXT_TOKENS_PER_SOURCE", 2_000),
    fallbackRequiredSourceCount: readPositiveInt("AGENT_FALLBACK_REQUIRED_SOURCE_COUNT", 3),
    metricsEnabled: readBoolean("AGENT_METRICS_ENABLED", true),
    metricsBufferSize: readPositiveInt("AGENT_METRICS_BUFFER_SIZE", 10_000),
    metricsBackendUrl: readUrl("AGENT_METRICS_BACKEND_URL", "http://localhost:2024"),
    llmFallbackEnabled: readBoolean("LLM_FALLBACK_ENABLED", false),
    llmFallbackProviders: readCsv("LLM_FALLBACK_PROVIDERS"),
    llmFallbackMaxAttempts: readPositiveInt("LLM_FALLBACK_MAX_ATTEMPTS", 3),
    llmFallbackTimeoutMs: readPositiveInt("LLM_FALLBACK_TIMEOUT_MS", 30_000),
    llmRepairStrategy: readRepairStrategy(),
    llmProviderResponseMaxBytes: readPositiveInt(
      "LLM_PROVIDER_RESPONSE_MAX_BYTES",
      DEFAULT_LLM_PROVIDER_RESPONSE_MAX_BYTES
    ),
    llmToolArgumentMaxBytes: readPositiveInt(
      "LLM_TOOL_ARGUMENT_MAX_BYTES",
      DEFAULT_LLM_TOOL_ARGUMENT_MAX_BYTES
    ),
    llmJsonMaxDepth: readPositiveInt(
      "LLM_JSON_MAX_DEPTH",
      DEFAULT_LLM_JSON_MAX_DEPTH
    ),
    otelEnabled: readBoolean("OTEL_ENABLED", false),
    otelServiceName:
      getEnv("OTEL_SERVICE_NAME").trim() || "chat-gun",
    otelExporterEndpoint: readOptionalUrl("OTEL_EXPORTER_OTLP_ENDPOINT"),
    otelExporterProtocol: readOtelProtocol(),
    otelSampleRate: readSampleRate(),
    opikEnabled: readBoolean("OPIK_ENABLED", false),
    opikApiKey: readOptionalString("OPIK_API_KEY"),
    opikWorkspace: readOptionalString("OPIK_WORKSPACE"),
    opikHost: readUrl("OPIK_HOST", DEFAULT_OPIK_HOST),
    opikProjectName:
      readOptionalString("OPIK_PROJECT_NAME") ?? DEFAULT_OPIK_PROJECT_NAME,
    opikRedactEnabled: readBoolean("OPIK_REDACT_ENABLED", true),
    opikEvalOutputDir:
      readOptionalString("OPIK_EVAL_OUTPUT_DIR") ?? "./eval-results",
  };
}

export function getContextPackLocale(): ImAgentContextPack["constraints"]["locale"] {
  return getAgentRuntimeConfig().locale;
}
