import { describe, expect, it } from "vitest";

import { BoundedJsonStreamAssembler } from "./stream-assembler.js";

function options(overrides: Partial<ConstructorParameters<typeof BoundedJsonStreamAssembler>[0]> = {}) {
  return {
    maxBytes: 1_024,
    maxDepth: 16,
    deadlineMs: Date.now() + 10_000,
    ...overrides,
  };
}

describe("BoundedJsonStreamAssembler", () => {
  it("assembles JSON split between string chunks", () => {
    const assembler = new BoundedJsonStreamAssembler(options());

    expect(assembler.push('{"ok":')).toMatchObject({ status: "incomplete" });
    expect(assembler.push("true}")).toEqual({
      status: "valid",
      value: { ok: true },
    });
    expect(assembler.end()).toEqual({
      status: "valid",
      value: { ok: true },
    });
  });

  it("preserves a Unicode code point split between UTF-8 chunks", () => {
    const bytes = new TextEncoder().encode('{"text":"台灣🙂"}');
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
    const assembler = new BoundedJsonStreamAssembler(options());

    assembler.push(bytes.slice(0, emojiStart + 2));
    assembler.push(bytes.slice(emojiStart + 2));

    expect(assembler.end()).toEqual({
      status: "valid",
      value: { text: "台灣🙂" },
    });
  });

  it.each([
    '{"text":"unterminated',
    '{"text":"trailing\\',
    '{"nested":[1,2',
  ])("returns incomplete at end-of-stream for %s", (text) => {
    const assembler = new BoundedJsonStreamAssembler(options());
    assembler.push(text);

    expect(assembler.end()).toMatchObject({
      status: "incomplete",
      errorCode: "JSON_DECODE_INCOMPLETE",
    });
  });

  it("stops accumulating after the byte limit is exceeded", () => {
    const assembler = new BoundedJsonStreamAssembler(options({ maxBytes: 8 }));

    const exceeded = assembler.push('{"value":1}');
    expect(exceeded).toEqual({
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_BYTES",
      byteLength: 11,
    });
    expect(assembler.push("ignored-sensitive-tail")).toEqual(exceeded);
    expect(assembler.end()).toEqual(exceeded);
  });

  it("stops accumulating after the depth limit is exceeded", () => {
    const assembler = new BoundedJsonStreamAssembler(options({ maxDepth: 2 }));

    const exceeded = assembler.push('[[["secret"]]]');
    expect(exceeded).toEqual({
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_DEPTH",
      byteLength: 14,
    });
    expect(exceeded).not.toHaveProperty("rawHash");
  });

  it("returns aborted when the deadline has elapsed", () => {
    const assembler = new BoundedJsonStreamAssembler(
      options({ deadlineMs: Date.now() - 1 })
    );

    expect(assembler.push('{"ignored":true}')).toEqual({ status: "aborted" });
    expect(assembler.end()).toEqual({ status: "aborted" });
  });

  it("stops after AbortSignal cancellation", () => {
    const controller = new AbortController();
    const assembler = new BoundedJsonStreamAssembler(
      options({ signal: controller.signal })
    );
    assembler.push('{"partial":');

    controller.abort();

    expect(assembler.push("true}")).toEqual({ status: "aborted" });
    expect(assembler.end()).toEqual({ status: "aborted" });
  });

  it("supports explicit abort and keeps the terminal result", () => {
    const assembler = new BoundedJsonStreamAssembler(options());
    assembler.push('{"partial":');

    assembler.abort("caller stopped consuming");

    expect(assembler.push("true}")).toEqual({ status: "aborted" });
    expect(assembler.end()).toEqual({ status: "aborted" });
  });
});
