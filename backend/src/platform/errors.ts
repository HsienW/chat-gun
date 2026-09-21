import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { executionCorrelation } from "../runtime/execution-context/read-execution-context.js";

export type ErrorSource = "backend" | "bff" | "frontend" | "external";

export type ErrorEnvelope = {
  correlation?: ReturnType<typeof executionCorrelation>;
  error: {
    source: ErrorSource;
    stage: string;
    provider?: string;
    code: string;
    message: string;
    rawMessage?: string;
    details?: Record<string, unknown>;
    cause?: {
      name?: string;
      code?: string;
      message?: string;
    };
  };
};

export type ErrorEnvelopeInput = {
  executionContext?: ExecutionContext;
  source: ErrorSource;
  stage: string;
  provider?: string;
  code?: string;
  message?: string;
  rawMessage?: string;
  details?: Record<string, unknown>;
};

function getCause(error: Error): ErrorEnvelope["error"]["cause"] | undefined {
  const cause = error.cause as
    | { name?: string; code?: string; message?: string }
    | undefined;

  if (!cause) {
    return undefined;
  }

  return {
    name: cause.name,
    code: cause.code,
    message: cause.message,
  };
}

const MESSAGE_TELEMETRY_PATTERN = /fetch failed|network|connect|timeout|aborted/i;
const PUBLIC_CAUSE_ERROR_CODES = new Set([
  "provider_auth_error",
  "quota_or_rate_limit_exceeded",
  "provider_unavailable",
  "provider_http_error",
  "provider_request_validation_error",
  "llm_response_json_parse_failed",
  "timeout",
  "unknown_error",
]);

function getStructuredStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && Number.isInteger(statusCode)
    ? statusCode
    : undefined;
}

function getMessageTelemetryHint(message: string): Record<string, unknown> | undefined {
  return MESSAGE_TELEMETRY_PATTERN.test(message)
    ? { telemetryHint: "message_matched_network_or_timeout_pattern" }
    : undefined;
}

function inferCauseCode(causeCode: string): { code: string; details?: Record<string, unknown> } {
  const normalizedCauseCode = causeCode.toLowerCase();

  return PUBLIC_CAUSE_ERROR_CODES.has(normalizedCauseCode)
    ? { code: normalizedCauseCode }
    : { code: "unknown_error", details: { causeCode } };
}

function parseQuotaDetails(message: string): Record<string, unknown> {
  return {
    model: message.match(/model:\s*([^,\n]+)/i)?.[1],
    limit: message.match(/limit:\s*([^,\n]+)/i)?.[1],
    retryDelay: message.match(/retryDelay":"([^"]+)"/)?.[1],
    quotaMetric: message.match(/Quota exceeded for metric:\s*([^,\n]+)/i)?.[1],
  };
}

export function inferErrorCode(
  error: unknown,
  provider?: string
): { code: string; details?: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = getStructuredStatusCode(error);

  if (error instanceof Error && error.name === "ProviderResponseParseError") {
    return { code: "llm_response_json_parse_failed" };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return { code: "timeout" };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { code: "provider_auth_error", details: { statusCode } };
  }

  if (statusCode === 429) {
    return {
      code: "quota_or_rate_limit_exceeded",
      details: {
        statusCode,
        ...parseQuotaDetails(message),
      },
    };
  }

  if (statusCode === 400) {
    return { code: "provider_request_validation_error", details: { statusCode } };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return { code: "provider_unavailable", details: { statusCode } };
  }

  if (statusCode !== undefined && statusCode >= 400) {
    return { code: "provider_http_error", details: { statusCode } };
  }

  if (error instanceof Error) {
    const cause = getCause(error);
    if (cause?.code) {
      return inferCauseCode(String(cause.code));
    }
  }

  const telemetryDetails = getMessageTelemetryHint(message);

  return telemetryDetails
    ? { code: "unknown_error", details: telemetryDetails }
    : { code: "unknown_error" };
}

export function createErrorEnvelope(
  error: unknown,
  input: ErrorEnvelopeInput
): ErrorEnvelope {
  const rawMessage = input.rawMessage ?? (error instanceof Error ? error.message : String(error));
  const inferred = inferErrorCode(error, input.provider);
  const details = {
    ...inferred.details,
    ...input.details,
  };

  return {
    ...(input.executionContext
      ? { correlation: executionCorrelation(input.executionContext) }
      : {}),
    error: {
      source: input.source,
      stage: input.stage,
      provider: input.provider,
      code: input.code ?? inferred.code,
      message: input.message ?? rawMessage,
      rawMessage,
      details: Object.keys(details).length > 0 ? details : undefined,
      cause: error instanceof Error ? getCause(error) : undefined,
    },
  };
}

export function serializeErrorEnvelope(envelope: ErrorEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope | undefined {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;

  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) {
    return undefined;
  }

  const envelope = parsed as Partial<ErrorEnvelope>;
  if (
    envelope.error &&
    typeof envelope.error === "object" &&
    typeof envelope.error.source === "string" &&
    typeof envelope.error.stage === "string" &&
    typeof envelope.error.code === "string" &&
    typeof envelope.error.message === "string"
  ) {
    return envelope as ErrorEnvelope;
  }

  return undefined;
}

export function formatErrorEnvelope(envelope: ErrorEnvelope): string {
  const { error } = envelope;
  const details = error.details
    ? `\nDetails: ${JSON.stringify(error.details, null, 2)}`
    : "";
  const cause = error.cause ? `\nCause: ${JSON.stringify(error.cause, null, 2)}` : "";
  const raw = error.rawMessage ? `\nRaw: ${error.rawMessage}` : "";

  return [
    `Source: ${error.source}`,
    `Stage: ${error.stage}`,
    error.provider ? `Provider: ${error.provider}` : undefined,
    `Code: ${error.code}`,
    `Message: ${error.message}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .concat(details, cause, raw);
}
