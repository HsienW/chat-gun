import { describe, expect, it } from "vitest";

import { decodeJsonText, type JsonDecodeOptions } from "./json-decode.js";
import { parseOpenAiToolCalls } from "./llm-gateway.js";
import { classifyProviderError } from "./provider-error-category.js";
import { PROVIDER_TOOL_CALL_DECODING_FIXTURES } from "./provider-tool-call-decoding.fixtures.js";
import { StructuredOutputRefusalError } from "./structured-output-repair.js";

function optionsFor(fixture: {
  maxBytes: number;
  maxDepth: number;
  abortBeforeDecode?: boolean;
}): JsonDecodeOptions {
  if (!fixture.abortBeforeDecode) {
    return { maxBytes: fixture.maxBytes, maxDepth: fixture.maxDepth };
  }

  const controller = new AbortController();
  controller.abort();
  return {
    maxBytes: fixture.maxBytes,
    maxDepth: fixture.maxDepth,
    signal: controller.signal,
  };
}

describe("provider and Tool-call decoding cross-layer contract", () => {
  it.each(PROVIDER_TOOL_CALL_DECODING_FIXTURES)(
    "keeps $expected stable for $name",
    (fixture) => {
      if (fixture.expected === "refusal") {
        expect(classifyProviderError(new StructuredOutputRefusalError())).toBe(
          "content_filter_refusal"
        );
        return;
      }

      const result = decodeJsonText(fixture.raw ?? "", optionsFor(fixture));
      expect(result.status).toBe(fixture.expected);

      const toolResult = parseOpenAiToolCalls(
        [{
          id: `call-${fixture.expected}`,
          type: "function",
          function: {
            name: "contract_tool",
            arguments: fixture.raw,
          },
        }],
        optionsFor(fixture)
      );

      if (fixture.expected === "valid") {
        expect(toolResult).toMatchObject({
          toolCalls: [{ args: { value: "台灣🙂" } }],
          diagnostics: [],
        });
      } else {
        expect(toolResult.toolCalls).toEqual([]);
        expect(toolResult.diagnostics[0]?.decodeKind).toBe(fixture.expected);
      }
    }
  );

  it("preserves decode safety properties across every prefix of the shared valid fixture", () => {
    const validFixture = PROVIDER_TOOL_CALL_DECODING_FIXTURES.find(
      (fixture) => fixture.expected === "valid"
    );
    expect(validFixture?.raw).toBeDefined();
    if (!validFixture?.raw) return;

    for (let end = 0; end <= validFixture.raw.length; end += 1) {
      const prefix = validFixture.raw.slice(0, end);
      const result = decodeJsonText(prefix, optionsFor(validFixture));

      expect(() => JSON.stringify(result)).not.toThrow();
      if (end < validFixture.raw.length) {
        expect(result.status).not.toBe("valid");
      } else {
        expect(result.status).toBe("valid");
      }
      if (result.status === "too_large") {
        expect(result).not.toHaveProperty("rawHash");
      }
    }
  });
});
