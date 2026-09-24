import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeJsonText } from "./json-decode.js";

const DEFAULT_OPTIONS = {
  maxBytes: 1_024,
  maxDepth: 16,
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("decodeJsonText", () => {
  it("returns a typed value for valid JSON", () => {
    expect(decodeJsonText<{ ok: boolean }>('{"ok":true}', DEFAULT_OPTIONS)).toEqual({
      status: "valid",
      value: { ok: true },
    });
  });

  it("returns aborted before inspecting the input", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      decodeJsonText('{"secret":"must-not-be-processed"}', {
        maxBytes: 1,
        maxDepth: 1,
        signal: controller.signal,
      })
    ).toEqual({ status: "aborted" });
  });

  it.each([
    '{"name":"truncated"',
    '[1,2',
    '{"name":"unterminated}',
    '{"name":"trailing\\',
  ])("classifies structurally truncated JSON as incomplete", (text) => {
    expect(decodeJsonText(text, DEFAULT_OPTIONS)).toEqual({
      status: "incomplete",
      errorCode: "JSON_DECODE_INCOMPLETE",
      byteLength: Buffer.byteLength(text, "utf8"),
      rawHash: sha256(text),
    });
  });

  it.each(["", "null trailing", '{"name":}', '{"name":true,}']) (
    "classifies non-truncation syntax failures as invalid",
    (text) => {
      expect(decodeJsonText(text, DEFAULT_OPTIONS)).toEqual({
        status: "invalid",
        errorCode: "JSON_DECODE_INVALID",
        byteLength: Buffer.byteLength(text, "utf8"),
        rawHash: sha256(text),
      });
    }
  );

  it("returns too_large without hashing when the byte limit is exceeded", () => {
    const text = JSON.stringify({ payload: "敏感資料".repeat(32) });
    const result = decodeJsonText(text, { maxBytes: 32, maxDepth: 16 });

    expect(result).toEqual({
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_BYTES",
      byteLength: Buffer.byteLength(text, "utf8"),
    });
    expect(result).not.toHaveProperty("rawHash");
  });

  it("uses an iterative bounded scan for deeply nested JSON", () => {
    const text = `${"[".repeat(2_000)}0${"]".repeat(2_000)}`;
    const result = decodeJsonText(text, { maxBytes: 10_000, maxDepth: 64 });

    expect(result).toEqual({
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_DEPTH",
      byteLength: Buffer.byteLength(text, "utf8"),
    });
  });

  it("ignores brackets inside strings when enforcing depth", () => {
    const text = JSON.stringify({ text: "[[[{{{🙂" });

    expect(decodeJsonText(text, { maxBytes: 1_024, maxDepth: 1 })).toEqual({
      status: "valid",
      value: { text: "[[[{{{🙂" },
    });
  });

  it("does not throw for deterministic truncation and Unicode fuzz cases", () => {
    const fixtures = [
      JSON.stringify({ text: "台灣🙂é", nested: [{ ok: true }] }),
      JSON.stringify(["\\", "\"", "多碼點🧪", { value: 42 }]),
    ];

    for (const fixture of fixtures) {
      for (let end = 0; end <= fixture.length; end += 1) {
        expect(() =>
          decodeJsonText(fixture.slice(0, end), DEFAULT_OPTIONS)
        ).not.toThrow();
      }
    }
  });
});
