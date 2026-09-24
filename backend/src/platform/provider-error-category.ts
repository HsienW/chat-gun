import { ZodError } from "zod";

export type ProviderErrorCategory =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_response_invalid"
  | "provider_decode_failure"
  | "structured_output_invalid"
  | "content_filter_refusal"
  | "unknown_error";

const REFUSAL_CODES = new Set([
  "content_filter",
  "content_filter_refusal",
  "refusal",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readStatusCode(record: Record<string, unknown> | undefined): number | undefined {
  const value = record?.statusCode ?? record?.status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function classifyProviderError(error: unknown): ProviderErrorCategory {
  const record = asRecord(error);
  const code = readString(record, "code").toLowerCase();
  const name = readString(record, "name");
  const statusCode = readStatusCode(record);

  if (REFUSAL_CODES.has(code) || name === "StructuredOutputRefusalError") {
    return "content_filter_refusal";
  }
  if (code === "provider_decode_failure" || name === "ToolArgumentDecodeError") {
    return "provider_decode_failure";
  }
  if (error instanceof ZodError || name === "ZodError") {
    return "structured_output_invalid";
  }
  if (
    name === "ProviderResponseParseError"
    || name === "ProviderEnvelopeValidationError"
    || code === "llm_response_json_parse_failed"
    || code === "provider_envelope_invalid"
    || error instanceof SyntaxError
  ) {
    return "provider_response_invalid";
  }
  if (
    name === "AbortError" ||
    code === "etimedout" ||
    code === "provider_timeout" ||
    statusCode === 408
  ) {
    return "provider_timeout";
  }
  if (statusCode === 429) {
    return "provider_rate_limited";
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return "provider_unavailable";
  }
  return "unknown_error";
}

export function isFallbackEligibleCategory(category: ProviderErrorCategory): boolean {
  return (
    category === "provider_unavailable" ||
    category === "provider_timeout" ||
    category === "provider_response_invalid"
  );
}
