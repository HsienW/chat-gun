import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  classifyProviderError,
  isFallbackEligibleCategory,
} from "./provider-error-category.js";

describe("classifyProviderError", () => {
  it.each([
    [{ statusCode: 502 }, "provider_unavailable"],
    [{ statusCode: 429 }, "provider_rate_limited"],
    [{ name: "AbortError" }, "provider_timeout"],
    [{ name: "ProviderResponseParseError" }, "provider_response_invalid"],
    [{ name: "ProviderEnvelopeValidationError" }, "provider_response_invalid"],
    [{ code: "PROVIDER_ENVELOPE_INVALID" }, "provider_response_invalid"],
    [{ code: "provider_decode_failure", decodeKind: "incomplete" }, "provider_decode_failure"],
    [{ name: "ToolArgumentDecodeError", decodeKind: "schema_invalid" }, "provider_decode_failure"],
    [{ code: "content_filter_refusal" }, "content_filter_refusal"],
  ] as const)("classifies structured provider errors", (error, category) => {
    expect(classifyProviderError(error)).toBe(category);
  });

  it("classifies Zod validation errors", () => {
    const result = z.object({ answer: z.string() }).safeParse({ answer: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(classifyProviderError(result.error)).toBe(
        "structured_output_invalid"
      );
    }
  });

  it("uses unknown_error for unstructured failures", () => {
    expect(classifyProviderError(new Error("opaque failure"))).toBe(
      "unknown_error"
    );
  });

  it("excludes Tool argument decode failures from fallback eligibility", () => {
    expect(isFallbackEligibleCategory("provider_decode_failure")).toBe(false);
    expect(isFallbackEligibleCategory("provider_response_invalid")).toBe(true);
  });
});
