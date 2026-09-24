import { describe, expect, it } from "vitest";

import {
  ProviderEnvelopeValidationError,
  validateProviderEnvelope,
} from "./provider-envelope.js";

describe("validateProviderEnvelope", () => {
  it("validates an OpenAI chat completion and preserves future fields", () => {
    const envelope = {
      id: "response-1",
      model: "future-model",
      future_root: { enabled: true },
      choices: [
        {
          finish_reason: "tool_calls",
          future_choice: 1,
          message: {
            content: null,
            future_message: "kept",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                future_call: true,
                function: {
                  name: "calculator",
                  arguments: '{"expression":"1+1"}',
                  future_function: "kept",
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        future_usage: 1,
      },
    };

    expect(validateProviderEnvelope(envelope, "openai-chat-completions")).toEqual(
      envelope
    );
  });

  it.each([
    [{}, "missing choices"],
    [{ choices: "not-an-array" }, "choices is not an array"],
    [{ choices: [{ message: "not-an-object" }] }, "message is malformed"],
    [
      { choices: [{ message: { content: null, tool_calls: "not-an-array" } }] },
      "tool_calls is malformed",
    ],
    [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: "calculator" } }],
            },
          },
        ],
      },
      "tool call arguments is missing",
    ],
    [{ choices: [{ message: { content: { raw: true } } }] }, "content is malformed"],
  ])("fails closed when OpenAI %s", (envelope, _caseName) => {
    expect(() =>
      validateProviderEnvelope(envelope, "openai-chat-completions")
    ).toThrowError(ProviderEnvelopeValidationError);

    try {
      validateProviderEnvelope(envelope, "openai-chat-completions");
    } catch (error) {
      expect(error).toMatchObject({
        name: "ProviderEnvelopeValidationError",
        code: "PROVIDER_ENVELOPE_INVALID",
        endpointKind: "openai-chat-completions",
      });
      expect(String(error)).not.toContain(JSON.stringify(envelope));
    }
  });

  it("validates Anthropic text blocks and preserves unknown block types", () => {
    const envelope = {
      id: "message-1",
      future_root: true,
      content: [
        { type: "text", text: "hello", citations: [] },
        { type: "future_block", payload: { enabled: true } },
      ],
    };

    expect(validateProviderEnvelope(envelope, "anthropic-messages")).toEqual(
      envelope
    );
  });

  it.each([
    {},
    { content: "not-an-array" },
    { content: [{ type: "text" }] },
    { content: [{ type: "text", text: 42 }] },
  ])("fails closed for a malformed Anthropic envelope", (envelope) => {
    expect(() =>
      validateProviderEnvelope(envelope, "anthropic-messages")
    ).toThrowError(ProviderEnvelopeValidationError);
  });
});
