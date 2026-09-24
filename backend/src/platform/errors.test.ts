import { describe, expect, it } from "vitest";

import { createErrorEnvelope, inferErrorCode } from "./errors.js";

describe("inferErrorCode", () => {
  it("does not use network-like message text as the public error code", () => {
    const inferred = inferErrorCode(new Error("fetch failed: network timeout connect"));

    expect(inferred.code).toBe("unknown_error");
  });

  it("maps AbortError from structured error name to timeout", () => {
    const error = new Error("operation aborted");
    error.name = "AbortError";

    expect(inferErrorCode(error).code).toBe("timeout");
  });

  it("maps structured HTTP statusCode without relying on message text", () => {
    const error = Object.assign(new Error("provider rejected request"), {
      statusCode: 429,
    });

    expect(inferErrorCode(error)).toMatchObject({
      code: "quota_or_rate_limit_exceeded",
      details: { statusCode: 429 },
    });
  });

  it("maps Tool argument decode failures from their structured code", () => {
    const error = Object.assign(new Error("safe failure"), {
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "incomplete",
    });

    expect(inferErrorCode(error).code).toBe("provider_decode_failure");
  });

  it("maps provider envelope validation from its structured code", () => {
    const error = Object.assign(new Error("safe envelope failure"), {
      name: "ProviderEnvelopeValidationError",
      code: "PROVIDER_ENVELOPE_INVALID",
    });

    expect(inferErrorCode(error).code).toBe("provider_envelope_invalid");
  });

  it("keeps regex-like message text only as telemetry details", () => {
    const envelope = createErrorEnvelope(new Error("fetch failed timeout"), {
      source: "backend",
      stage: "llm_request",
      provider: "qwen",
    });

    expect(envelope.error.code).toBe("unknown_error");
    expect(envelope.error.details).toEqual({
      telemetryHint: "message_matched_network_or_timeout_pattern",
    });
  });

  it("allows stable public cause codes to become the public error code", () => {
    const error = new Error("provider wrapper failed", {
      cause: { code: "provider_unavailable" },
    });

    expect(inferErrorCode(error)).toEqual({
      code: "provider_unavailable",
    });
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"])(
    "keeps unmanaged cause code %s as telemetry only",
    (causeCode) => {
      const error = new Error("provider transport failed", {
        cause: { code: causeCode },
      });

      expect(inferErrorCode(error)).toEqual({
        code: "unknown_error",
        details: { causeCode },
      });
    }
  );
});
