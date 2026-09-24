import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentRuntimeConfig } from "./runtime-config.js";

describe("getAgentRuntimeConfig context budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults contextBudgetTotal to 128000", () => {
    vi.stubEnv("AGENT_CONTEXT_BUDGET_TOTAL", "");

    expect(getAgentRuntimeConfig().contextBudgetTotal).toBe(128_000);
  });

  it("reads a positive integer from AGENT_CONTEXT_BUDGET_TOTAL", () => {
    vi.stubEnv("AGENT_CONTEXT_BUDGET_TOTAL", "64000");

    expect(getAgentRuntimeConfig().contextBudgetTotal).toBe(64_000);
  });

  it("falls back for an invalid context budget", () => {
    vi.stubEnv("AGENT_CONTEXT_BUDGET_TOTAL", "not-a-number");

    expect(getAgentRuntimeConfig().contextBudgetTotal).toBe(128_000);
  });
});

describe("getAgentRuntimeConfig metrics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses safe metrics defaults", () => {
    vi.stubEnv("AGENT_METRICS_ENABLED", "");
    vi.stubEnv("AGENT_METRICS_BUFFER_SIZE", "");
    vi.stubEnv("AGENT_METRICS_BACKEND_URL", "");

    expect(getAgentRuntimeConfig()).toMatchObject({
      metricsEnabled: true,
      metricsBufferSize: 10_000,
      metricsBackendUrl: "http://localhost:2024/",
    });
  });

  it("reads valid metrics configuration", () => {
    vi.stubEnv("AGENT_METRICS_ENABLED", "false");
    vi.stubEnv("AGENT_METRICS_BUFFER_SIZE", "250");
    vi.stubEnv("AGENT_METRICS_BACKEND_URL", "http://backend.internal:2024");

    expect(getAgentRuntimeConfig()).toMatchObject({
      metricsEnabled: false,
      metricsBufferSize: 250,
      metricsBackendUrl: "http://backend.internal:2024/",
    });
  });

  it("falls back when metrics configuration is invalid", () => {
    vi.stubEnv("AGENT_METRICS_BUFFER_SIZE", "0");
    vi.stubEnv("AGENT_METRICS_BACKEND_URL", "not-a-url");

    expect(getAgentRuntimeConfig()).toMatchObject({
      metricsBufferSize: 10_000,
      metricsBackendUrl: "http://localhost:2024/",
    });
  });
});

describe("getAgentRuntimeConfig fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses safe fallback defaults", () => {
    vi.stubEnv("LLM_FALLBACK_ENABLED", "");
    vi.stubEnv("LLM_FALLBACK_PROVIDERS", "");
    vi.stubEnv("LLM_FALLBACK_MAX_ATTEMPTS", "");
    vi.stubEnv("LLM_FALLBACK_TIMEOUT_MS", "");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "");

    expect(getAgentRuntimeConfig()).toMatchObject({
      llmFallbackEnabled: false,
      llmFallbackProviders: [],
      llmFallbackMaxAttempts: 3,
      llmFallbackTimeoutMs: 30_000,
      llmRepairStrategy: "retry_once",
    });
  });

  it("reads and normalizes fallback configuration", () => {
    vi.stubEnv("LLM_FALLBACK_ENABLED", "true");
    vi.stubEnv("LLM_FALLBACK_PROVIDERS", " qwen, openai-compatible, qwen ");
    vi.stubEnv("LLM_FALLBACK_MAX_ATTEMPTS", "2");
    vi.stubEnv("LLM_FALLBACK_TIMEOUT_MS", "5000");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_with_hint");

    expect(getAgentRuntimeConfig()).toMatchObject({
      llmFallbackEnabled: true,
      llmFallbackProviders: ["qwen", "openai-compatible"],
      llmFallbackMaxAttempts: 2,
      llmFallbackTimeoutMs: 5_000,
      llmRepairStrategy: "retry_with_hint",
    });
  });

  it("falls back for invalid numeric and repair strategy values", () => {
    vi.stubEnv("LLM_FALLBACK_MAX_ATTEMPTS", "0");
    vi.stubEnv("LLM_FALLBACK_TIMEOUT_MS", "invalid");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "unbounded");

    expect(getAgentRuntimeConfig()).toMatchObject({
      llmFallbackMaxAttempts: 3,
      llmFallbackTimeoutMs: 30_000,
      llmRepairStrategy: "retry_once",
    });
  });
});

describe("getAgentRuntimeConfig JSON decode limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses separate bounded defaults for provider responses and tool arguments", () => {
    vi.stubEnv("LLM_PROVIDER_RESPONSE_MAX_BYTES", "");
    vi.stubEnv("LLM_TOOL_ARGUMENT_MAX_BYTES", "");
    vi.stubEnv("LLM_JSON_MAX_DEPTH", "");

    const config = getAgentRuntimeConfig();
    expect(config.llmProviderResponseMaxBytes).toBe(1_048_576);
    expect(config.llmToolArgumentMaxBytes).toBe(65_536);
    expect(config.llmJsonMaxDepth).toBe(64);
  });

  it("reads valid JSON decode limits", () => {
    vi.stubEnv("LLM_PROVIDER_RESPONSE_MAX_BYTES", "2048");
    vi.stubEnv("LLM_TOOL_ARGUMENT_MAX_BYTES", "1024");
    vi.stubEnv("LLM_JSON_MAX_DEPTH", "32");

    const config = getAgentRuntimeConfig();
    expect(config.llmProviderResponseMaxBytes).toBe(2_048);
    expect(config.llmToolArgumentMaxBytes).toBe(1_024);
    expect(config.llmJsonMaxDepth).toBe(32);
  });

  it("falls back when JSON decode limits are invalid", () => {
    vi.stubEnv("LLM_PROVIDER_RESPONSE_MAX_BYTES", "0");
    vi.stubEnv("LLM_TOOL_ARGUMENT_MAX_BYTES", "not-a-number");
    vi.stubEnv("LLM_JSON_MAX_DEPTH", "-1");

    const config = getAgentRuntimeConfig();
    expect(config.llmProviderResponseMaxBytes).toBe(1_048_576);
    expect(config.llmToolArgumentMaxBytes).toBe(65_536);
    expect(config.llmJsonMaxDepth).toBe(64);
  });
});

describe("getAgentRuntimeConfig tracing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses disabled tracing defaults", () => {
    vi.stubEnv("OTEL_ENABLED", "");
    vi.stubEnv("OTEL_SERVICE_NAME", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "");
    vi.stubEnv("OTEL_SAMPLE_RATE", "");

    expect(getAgentRuntimeConfig()).toMatchObject({
      otelEnabled: false,
      otelServiceName: "chat-gun",
      otelExporterEndpoint: undefined,
      otelExporterProtocol: "http",
      otelSampleRate: 1,
    });
  });

  it("reads valid tracing configuration", () => {
    vi.stubEnv("OTEL_ENABLED", "true");
    vi.stubEnv("OTEL_SERVICE_NAME", "backend");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4318/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http");
    vi.stubEnv("OTEL_SAMPLE_RATE", "0.25");

    expect(getAgentRuntimeConfig()).toMatchObject({
      otelEnabled: true,
      otelServiceName: "backend",
      otelExporterEndpoint: "http://jaeger:4318/v1/traces",
      otelExporterProtocol: "http",
      otelSampleRate: 0.25,
    });
  });

  it("falls back for invalid endpoints, protocols, and sample rates", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "not-a-url");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "udp");
    vi.stubEnv("OTEL_SAMPLE_RATE", "2");

    expect(getAgentRuntimeConfig()).toMatchObject({
      otelExporterEndpoint: undefined,
      otelExporterProtocol: "http",
      otelSampleRate: 1,
    });
  });
});

describe("getAgentRuntimeConfig Opik", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses disabled and redaction-safe Opik defaults", () => {
    vi.stubEnv("OPIK_ENABLED", "");
    vi.stubEnv("OPIK_API_KEY", "");
    vi.stubEnv("OPIK_WORKSPACE", "");
    vi.stubEnv("OPIK_HOST", "");
    vi.stubEnv("OPIK_PROJECT_NAME", "");
    vi.stubEnv("OPIK_REDACT_ENABLED", "");
    vi.stubEnv("OPIK_EVAL_OUTPUT_DIR", "");

    expect(getAgentRuntimeConfig()).toMatchObject({
      opikEnabled: false,
      opikApiKey: undefined,
      opikWorkspace: undefined,
      opikHost: "https://www.comet.com/opik/api",
      opikProjectName: "chat-gun",
      opikRedactEnabled: true,
      opikEvalOutputDir: "./eval-results",
    });
  });

  it("reads valid Opik configuration", () => {
    vi.stubEnv("OPIK_ENABLED", "true");
    vi.stubEnv("OPIK_API_KEY", "test-api-key");
    vi.stubEnv("OPIK_WORKSPACE", "test-workspace");
    vi.stubEnv("OPIK_HOST", "https://opik.internal/api");
    vi.stubEnv("OPIK_PROJECT_NAME", "backend-evaluation");
    vi.stubEnv("OPIK_REDACT_ENABLED", "false");
    vi.stubEnv("OPIK_EVAL_OUTPUT_DIR", "./custom-eval-results");

    expect(getAgentRuntimeConfig()).toMatchObject({
      opikEnabled: true,
      opikApiKey: "test-api-key",
      opikWorkspace: "test-workspace",
      opikHost: "https://opik.internal/api",
      opikProjectName: "backend-evaluation",
      opikRedactEnabled: false,
      opikEvalOutputDir: "./custom-eval-results",
    });
  });

  it("falls back to the hosted Opik endpoint for an invalid host", () => {
    vi.stubEnv("OPIK_HOST", "not-a-url");

    expect(getAgentRuntimeConfig().opikHost).toBe(
      "https://www.comet.com/opik/api"
    );
  });
});
