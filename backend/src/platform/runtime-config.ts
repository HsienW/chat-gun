import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../context/context-budget.js";
import { getEnv } from "./env.js";
import type { ImAgentContextPack } from "./im-context-pack.js";

const SUPPORTED_LOCALES = ["zh-TW", "zh-CN", "en"] as const;

export type AgentLocale = (typeof SUPPORTED_LOCALES)[number];
export type LlmRepairStrategy = "none" | "retry_once" | "retry_with_hint";
export type OtelExporterProtocol = "grpc" | "http";

export const RUNTIME_BOUNDARY_IDS = [
  "x12.context",
  "x13.authorization",
  "x14.dispatch",
  "x15.decode",
  "x16.scheduling",
  "x17.input",
  "x18.context",
  "x19.events",
  "x20.recovery",
] as const;

export type RuntimeBoundaryId = (typeof RUNTIME_BOUNDARY_IDS)[number];
export type RuntimeBoundaryFlags = Record<RuntimeBoundaryId, boolean>;

export interface RuntimeBoundaryContract {
  boundary: RuntimeBoundaryId;
  configKey: `${RuntimeBoundaryId}.enabled`;
  environmentVariable: string;
  defaultEnabled: true;
  disabledMode:
    | "legacy_context_adapter_fail_closed"
    | "default_deny"
    | "readonly_agent_dispatch_mutation_governed"
    | "strict_json_parse_typed_invalid"
    | "serial_execution"
    | "validated_raw_input"
    | "bounded_agent_context"
    | "legacy_event_adapter_terminal_monotonic"
    | "park_manual_intervention";
  authorization: "unchanged" | "default_deny";
  mutationSafety: "unchanged" | "ledger_and_reconciliation";
  terminalMonotonicity: "enforced";
  persistenceHistory: "preserved";
}

export const RUNTIME_BOUNDARY_CONTRACTS: Readonly<
  Record<RuntimeBoundaryId, RuntimeBoundaryContract>
> = {
  "x12.context": {
    boundary: "x12.context",
    configKey: "x12.context.enabled",
    environmentVariable: "RUNTIME_X12_CONTEXT_ENABLED",
    defaultEnabled: true,
    disabledMode: "legacy_context_adapter_fail_closed",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x13.authorization": {
    boundary: "x13.authorization",
    configKey: "x13.authorization.enabled",
    environmentVariable: "RUNTIME_X13_AUTHORIZATION_ENABLED",
    defaultEnabled: true,
    disabledMode: "default_deny",
    authorization: "default_deny",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x14.dispatch": {
    boundary: "x14.dispatch",
    configKey: "x14.dispatch.enabled",
    environmentVariable: "RUNTIME_X14_DISPATCH_ENABLED",
    defaultEnabled: true,
    disabledMode: "readonly_agent_dispatch_mutation_governed",
    authorization: "unchanged",
    mutationSafety: "ledger_and_reconciliation",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x15.decode": {
    boundary: "x15.decode",
    configKey: "x15.decode.enabled",
    environmentVariable: "RUNTIME_X15_DECODE_ENABLED",
    defaultEnabled: true,
    disabledMode: "strict_json_parse_typed_invalid",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x16.scheduling": {
    boundary: "x16.scheduling",
    configKey: "x16.scheduling.enabled",
    environmentVariable: "RUNTIME_X16_SCHEDULING_ENABLED",
    defaultEnabled: true,
    disabledMode: "serial_execution",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x17.input": {
    boundary: "x17.input",
    configKey: "x17.input.enabled",
    environmentVariable: "RUNTIME_X17_INPUT_ENABLED",
    defaultEnabled: true,
    disabledMode: "validated_raw_input",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x18.context": {
    boundary: "x18.context",
    configKey: "x18.context.enabled",
    environmentVariable: "RUNTIME_X18_CONTEXT_ENABLED",
    defaultEnabled: true,
    disabledMode: "bounded_agent_context",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x19.events": {
    boundary: "x19.events",
    configKey: "x19.events.enabled",
    environmentVariable: "RUNTIME_X19_EVENTS_ENABLED",
    defaultEnabled: true,
    disabledMode: "legacy_event_adapter_terminal_monotonic",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
  "x20.recovery": {
    boundary: "x20.recovery",
    configKey: "x20.recovery.enabled",
    environmentVariable: "RUNTIME_X20_RECOVERY_ENABLED",
    defaultEnabled: true,
    disabledMode: "park_manual_intervention",
    authorization: "unchanged",
    mutationSafety: "unchanged",
    terminalMonotonicity: "enforced",
    persistenceHistory: "preserved",
  },
};

export interface RuntimeBoundaryPolicy extends RuntimeBoundaryContract {
  enabled: boolean;
}

export type AgentRuntimeConfig = {
  locale: AgentLocale;
  timeZone: string;
  runtimeEventEnvelopeEnabled: boolean;
  runtimeBoundaryFlags: RuntimeBoundaryFlags;
  contextBudgetTotal: number;
  contextOutputReserveTokens: number;
  contextTokensPerSource: number;
  fallbackRequiredSourceCount: number;
  metricsEnabled: boolean;
  metricsBufferSize: number;
  metricsBackendUrl: string;
  toolDispatchMaxConcurrentReads: number;
  toolDispatchMaxConcurrentReadsPerRun: number;
  toolDispatchRateLimitMaxRequestsPerWindow: number;
  toolDispatchRateLimitWindowMs: number;
  toolDispatchCircuitResetTimeoutMs: number;
  toolRetryAfterMaxMs: number;
  toolDispatchStepLockTtlMs: number;
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
const DEFAULT_TOOL_DISPATCH_MAX_CONCURRENT_READS = 4;
const DEFAULT_TOOL_DISPATCH_MAX_CONCURRENT_READS_PER_RUN = 2;
const DEFAULT_TOOL_DISPATCH_RATE_LIMIT_MAX_REQUESTS_PER_WINDOW = 100;
const DEFAULT_TOOL_DISPATCH_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_TOOL_DISPATCH_CIRCUIT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_RETRY_AFTER_MAX_MS = 30_000;
const DEFAULT_TOOL_DISPATCH_STEP_LOCK_TTL_MS = 30_000;

function readPositiveInt(name: string, fallback: number): number {
  const rawValue = getEnv(name);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readStrictPositiveInt(name: string, fallback: number): number {
  const rawValue = getEnv(name);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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

function readStrictBoolean(name: string, fallback: boolean): boolean {
  const rawValue = getEnv(name).trim().toLowerCase();
  if (!rawValue) return fallback;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readRuntimeBoundaryFlags(): RuntimeBoundaryFlags {
  const enabled = (boundary: RuntimeBoundaryId) => {
    const contract = RUNTIME_BOUNDARY_CONTRACTS[boundary];
    return readStrictBoolean(
      contract.environmentVariable,
      contract.defaultEnabled
    );
  };
  return {
    "x12.context": enabled("x12.context"),
    "x13.authorization": enabled("x13.authorization"),
    "x14.dispatch": enabled("x14.dispatch"),
    "x15.decode": enabled("x15.decode"),
    "x16.scheduling": enabled("x16.scheduling"),
    "x17.input": enabled("x17.input"),
    "x18.context": enabled("x18.context"),
    "x19.events": enabled("x19.events"),
    "x20.recovery": enabled("x20.recovery"),
  };
}

export function resolveRuntimeBoundaryPolicy(
  flags: RuntimeBoundaryFlags,
  boundary: RuntimeBoundaryId
): RuntimeBoundaryPolicy {
  return {
    ...RUNTIME_BOUNDARY_CONTRACTS[boundary],
    enabled: flags[boundary],
  };
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
    runtimeEventEnvelopeEnabled: readStrictBoolean(
      "RUNTIME_EVENT_ENVELOPE_ENABLED",
      true
    ),
    runtimeBoundaryFlags: readRuntimeBoundaryFlags(),
    contextBudgetTotal: readPositiveInt(
      "AGENT_CONTEXT_BUDGET_TOTAL",
      DEFAULT_CONTEXT_TOKEN_BUDGET
    ),
    contextOutputReserveTokens: readPositiveInt(
      "AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS",
      4_096
    ),
    contextTokensPerSource: readPositiveInt("AGENT_CONTEXT_TOKENS_PER_SOURCE", 2_000),
    fallbackRequiredSourceCount: readPositiveInt("AGENT_FALLBACK_REQUIRED_SOURCE_COUNT", 3),
    metricsEnabled: readBoolean("AGENT_METRICS_ENABLED", true),
    metricsBufferSize: readPositiveInt("AGENT_METRICS_BUFFER_SIZE", 10_000),
    metricsBackendUrl: readUrl("AGENT_METRICS_BACKEND_URL", "http://localhost:2024"),
    toolDispatchMaxConcurrentReads: readStrictPositiveInt(
      "TOOL_DISPATCH_MAX_CONCURRENT_READS",
      DEFAULT_TOOL_DISPATCH_MAX_CONCURRENT_READS
    ),
    toolDispatchMaxConcurrentReadsPerRun: readStrictPositiveInt(
      "TOOL_DISPATCH_MAX_CONCURRENT_READS_PER_RUN",
      DEFAULT_TOOL_DISPATCH_MAX_CONCURRENT_READS_PER_RUN
    ),
    toolDispatchRateLimitMaxRequestsPerWindow: readStrictPositiveInt(
      "TOOL_DISPATCH_RATE_LIMIT_MAX_REQUESTS_PER_WINDOW",
      DEFAULT_TOOL_DISPATCH_RATE_LIMIT_MAX_REQUESTS_PER_WINDOW
    ),
    toolDispatchRateLimitWindowMs: readStrictPositiveInt(
      "TOOL_DISPATCH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_TOOL_DISPATCH_RATE_LIMIT_WINDOW_MS
    ),
    toolDispatchCircuitResetTimeoutMs: readStrictPositiveInt(
      "TOOL_DISPATCH_CIRCUIT_RESET_TIMEOUT_MS",
      DEFAULT_TOOL_DISPATCH_CIRCUIT_RESET_TIMEOUT_MS
    ),
    toolRetryAfterMaxMs: readStrictPositiveInt(
      "TOOL_RETRY_AFTER_MAX_MS",
      DEFAULT_TOOL_RETRY_AFTER_MAX_MS
    ),
    toolDispatchStepLockTtlMs: readStrictPositiveInt(
      "TOOL_DISPATCH_STEP_LOCK_TTL_MS",
      DEFAULT_TOOL_DISPATCH_STEP_LOCK_TTL_MS
    ),
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
