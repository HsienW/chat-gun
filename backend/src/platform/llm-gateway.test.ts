import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("llm-gateway provider selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to Qwen provider when no provider is configured", async () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("CCR_BASE_URL", "");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("QWEN_API_KEY", "");
    vi.resetModules();

    const gatewayModule = await import("./llm-gateway.js");

    expect(gatewayModule.getConfiguredLlmProvider()).toBe("qwen");
    expect(gatewayModule.describeLlmGatewayConfig()).toMatchObject({
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      baseUrlConfigured: true,
      apiKeyConfigured: false,
    });
  });

  it("rejects removed provider configuration", async () => {
    const removedProvider = ["ge", "mini"].join("");
    vi.stubEnv("LLM_PROVIDER", removedProvider);
    vi.stubEnv("CCR_BASE_URL", "http://127.0.0.1:3456/v1");
    vi.resetModules();

    await expect(import("./llm-gateway.js")).rejects.toThrow(
      `Unsupported LLM_PROVIDER "${removedProvider}"`
    );
  });

  it("routes CCR provider through CCR Anthropic messages endpoint", async () => {
    vi.stubEnv("LLM_PROVIDER", "ccr");
    vi.stubEnv("CCR_BASE_URL", "http://127.0.0.1:3456/v1");
    vi.stubEnv("CCR_PROVIDER", "deepseek");
    vi.stubEnv("CCR_MODEL", "ccr-test-model");
    vi.resetModules();

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      };

      expect(body.model).toBe("deepseek,ccr-test-model");
      expect(body.messages?.[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "ping" }],
      });

      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "pong" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel().invoke("ping");

    expect(String(response.content)).toBe("pong");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:3456/v1/messages?beta=true"
    );
    const gatewayModule = await import("./llm-gateway.js");
    expect(gatewayModule.describeLlmGatewayConfig()).toMatchObject({
      provider: "ccr",
      endpointKind: "anthropic-messages",
    });
  });

  it("fails fast when CCR provider is requested with structured output", async () => {
    vi.stubEnv("LLM_PROVIDER", "ccr");
    vi.stubEnv("CCR_BASE_URL", "http://127.0.0.1:3456/v1");
    vi.stubEnv("CCR_MODEL", "ccr-test-model");
    vi.resetModules();

    const { llmGateway } = await import("./llm-gateway.js");

    expect(() =>
      llmGateway.createChatModel({
        purpose: "research",
        responseFormat: { type: "json_object" },
      })
    ).toThrow(/ccr.*supportsStructuredOutput/i);
  });

  it("reports native structured-output capability by configured provider", async () => {
    vi.stubEnv("LLM_PROVIDER", "ccr");
    vi.stubEnv("CCR_BASE_URL", "http://127.0.0.1:3456/v1");
    vi.resetModules();

    let gatewayModule = await import("./llm-gateway.js");
    expect(
      gatewayModule.getConfiguredLlmCapabilities("research").supportsStructuredOutput
    ).toBe(false);

    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.resetModules();

    gatewayModule = await import("./llm-gateway.js");
    expect(
      gatewayModule.getConfiguredLlmCapabilities("research").supportsStructuredOutput
    ).toBe(true);
    expect(gatewayModule.getConfiguredLlmCapabilities("research")).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
    });
  });

  it("routes OpenAI-compatible provider through chat completions endpoint", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "openai-compatible-test-model");
    vi.resetModules();

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
      };

      expect(body.model).toBe("openai-compatible-test-model");
      expect(body.messages?.[0]).toEqual({
        role: "user",
        content: "ping",
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel().invoke("ping");

    expect(String(response.content)).toBe("pong");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:9999/v1/chat/completions"
    );
  });

  it("routes Qwen provider through Bailian-compatible chat completions with bearer auth and JSON mode", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_CHAT_MODEL", "qwen-plus-test");
    vi.resetModules();

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        response_format?: { type?: string };
        messages?: Array<{ role: string; content: unknown }>;
      };
      const headers = init?.headers as Record<string, string>;

      expect(body.model).toBe("qwen-plus-test");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages?.[0]).toEqual({ role: "user", content: "ping" });
      expect(headers.authorization).toBe("Bearer qwen-test-key");

      return new Response(
        JSON.stringify({
          id: "chatcmpl-qwen-test",
          model: "qwen-plus-test",
          choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway, describeLlmGatewayConfig } = await import("./llm-gateway.js");
    const response = await llmGateway
      .createChatModel({ purpose: "chat", responseFormat: { type: "json_object" } })
      .invoke("ping");

    expect(String(response.content)).toBe("{\"ok\":true}");
    expect((response as AIMessage).usage_metadata).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 7,
    });
    expect(response.response_metadata).toMatchObject({
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      model: "qwen-plus-test",
      finish_reason: "stop",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
    expect(describeLlmGatewayConfig()).toMatchObject({
      provider: "qwen",
      endpointKind: "openai-chat-completions",
      baseUrlConfigured: true,
      apiKeyConfigured: true,
    });
  });

  it("routes Qwen vision purpose with image_url content parts unchanged", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_VISION_MODEL", "qwen-vl-plus-test");
    vi.resetModules();

    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
      };

      expect(body.model).toBe("qwen-vl-plus-test");
      expect(body.messages?.[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "image observation" } }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel({ purpose: "vision" }).invoke([
      new HumanMessage({
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }),
    ]);

    expect(String(response.content)).toBe("image observation");
  });

  it("serializes bound tools and parses OpenAI-compatible tool calls", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_TOOL_MODEL", "qwen-plus-tool-test");
    vi.resetModules();

    const calculator = tool(async () => "4", {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({
        expression: z.string().describe("Expression to evaluate"),
      }),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        tools?: Array<{
          type?: string;
          function?: { name?: string; parameters?: { type?: string; properties?: unknown } };
        }>;
        tool_choice?: string;
      };

      expect(body.model).toBe("qwen-plus-tool-test");
      expect(body.tool_choice).toBe("auto");
      expect(body.tools?.[0]?.function?.name).toBe("calculator_tool");
      expect(body.tools?.[0]?.function?.parameters?.type).toBe("object");

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "calculator_tool",
                      arguments: "{\"expression\":\"2+2\"}",
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const model = llmGateway.createChatModel({ purpose: "tool" });
    const response = await model.bindTools?.([calculator]).invoke("2+2");

    expect(response?.content).toBe("");
    expect((response as AIMessage).tool_calls).toEqual([
      {
        id: "call-1",
        name: "calculator_tool",
        args: { expression: "2+2" },
        type: "tool_call",
      },
    ]);
  });

  it("distinguishes valid empty Tool arguments from malformed arguments", async () => {
    vi.resetModules();
    const { parseOpenAiToolCalls } = await import("./llm-gateway.js");
    const options = { maxBytes: 1_024, maxDepth: 16 };

    const validEmpty = parseOpenAiToolCalls([
      {
        id: "call-empty",
        type: "function",
        function: { name: "empty_tool", arguments: "{}" },
      },
    ], options);
    expect(validEmpty).toEqual({
      toolCalls: [{
        id: "call-empty",
        name: "empty_tool",
        args: {},
        type: "tool_call",
      }],
      diagnostics: [],
    });

    for (const argumentsText of [
      "",
      '{"value":"truncated"',
      "null",
      "[]",
      "42",
      "true",
    ]) {
      const decoded = parseOpenAiToolCalls([
        {
          id: "call-malformed",
          type: "function",
          function: { name: "unsafe_tool", arguments: argumentsText },
        },
      ], options);

      expect(decoded.toolCalls).toEqual([]);
      expect(decoded.diagnostics).toHaveLength(1);
      expect(decoded.diagnostics[0]).toMatchObject({
        index: 0,
        reason: "arguments_decode_failed",
      });
      if (argumentsText) {
        expect(JSON.stringify(decoded.diagnostics)).not.toContain(argumentsText);
      }
    }
  });

  it("returns bounded redacted diagnostics for malformed Tool calls", async () => {
    vi.resetModules();
    const { parseOpenAiToolCalls } = await import("./llm-gateway.js");

    const decoded = parseOpenAiToolCalls([
      { id: "missing-name", type: "function", function: { arguments: "{}" } },
      {
        id: "too-large",
        type: "function",
        function: { name: "large_tool", arguments: '{"secret":"sensitive"}' },
      },
    ], { maxBytes: 8, maxDepth: 16 });

    expect(decoded.toolCalls).toEqual([]);
    expect(decoded.diagnostics).toEqual([
      { index: 0, reason: "missing_name" },
      {
        index: 1,
        reason: "arguments_decode_failed",
        decodeKind: "too_large",
        errorCode: "JSON_DECODE_MAX_BYTES",
        byteLength: 22,
      },
    ]);
    expect(JSON.stringify(decoded.diagnostics)).not.toContain("sensitive");
  });

  it("fails closed when the provider envelope is missing required choices", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ model: "qwen-test" }), {
        status: 200,
      }))
    );

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway.createChatModel({ maxRetries: 0 }).invoke("ping")
    ).rejects.toMatchObject({
      name: "ProviderEnvelopeValidationError",
      code: "PROVIDER_ENVELOPE_INVALID",
      endpointKind: "openai-chat-completions",
    });
  });

  it("repairs incomplete Tool arguments at most once and validates the Tool schema", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_with_hint");
    vi.resetModules();

    const calculator = tool(async () => "4", {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({ expression: z.string() }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: "calculator_tool",
                arguments: '{"expression":"2+',
              },
            }],
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: "calculator_tool",
                arguments: '{"expression":"2+2"}',
              },
            }],
          },
        }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway
      .createChatModel({ purpose: "tool", maxRetries: 0 })
      .bindTools?.([calculator])
      .invoke("2+2");

    expect((response as AIMessage).tool_calls).toEqual([{
      id: "call-1",
      name: "calculator_tool",
      args: { expression: "2+2" },
      type: "tool_call",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body)
    ) as { messages?: Array<{ content?: unknown }> };
    expect(repairBody.messages?.at(-1)?.content).toContain(
      "The previous Tool call arguments were incomplete"
    );
  });

  it("exhausts after one repair candidate fails the Tool schema", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_once");
    vi.resetModules();

    const calculator = tool(async () => "4", {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({ expression: z.string() }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: {
            content: null,
            tool_calls: [{
              type: "function",
              function: { name: "calculator_tool", arguments: '{"expression":' },
            }],
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              type: "function",
              function: { name: "calculator_tool", arguments: '{"expression":42}' },
            }],
          },
        }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway
        .createChatModel({ purpose: "tool", maxRetries: 0 })
        .bindTools?.([calculator])
        .invoke("2+2")
    ).rejects.toMatchObject({
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "schema_invalid",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body)
    ) as { messages?: Array<{ role?: string; content?: unknown }> };
    expect(retryBody.messages).toEqual([{ role: "user", content: "2+2" }]);
  });

  it("does not repair a content-filter refusal", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_once");
    vi.resetModules();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "content_filter",
        message: { content: null },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway.createChatModel({ purpose: "tool", maxRetries: 0 }).invoke("unsafe")
    ).rejects.toMatchObject({
      name: "StructuredOutputRefusalError",
      code: "content_filter_refusal",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not repair after cancellation", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_once");
    vi.resetModules();

    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({
        choices: [{ message: { content: null } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway.createChatModel({ purpose: "tool" }).invoke("cancel", {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      name: "ProviderResponseParseError",
      decodeKind: "aborted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not repair Tool arguments that exceed the byte limit", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "retry_once");
    vi.stubEnv("LLM_TOOL_ARGUMENT_MAX_BYTES", "8");
    vi.resetModules();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: {
          content: null,
          tool_calls: [{
            type: "function",
            function: { name: "large_tool", arguments: '{"payload":"too large"}' },
          }],
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway.createChatModel({ purpose: "tool", maxRetries: 0 }).invoke("large")
    ).rejects.toMatchObject({
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "too_large",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not consume provider retries for a Tool argument decode failure", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "none");
    vi.resetModules();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            type: "function",
            function: { name: "broken_tool", arguments: '{"value":' },
          }],
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");

    await expect(
      llmGateway.createChatModel({ purpose: "tool", maxRetries: 2 }).invoke("decode", {
        runId: "run-decode",
        taskId: "task-decode",
        stepId: "step-decode",
        toolCallId: "call-decode",
      })
    ).rejects.toMatchObject({
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "incomplete",
      runId: "run-decode",
      taskId: "task-decode",
      stepId: "step-decode",
      toolCallId: "call-decode",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit OpenAI-compatible tool_choice override", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_TOOL_MODEL", "qwen-plus-tool-test");
    vi.resetModules();

    const calculator = tool(async () => "4", {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({
        expression: z.string(),
      }),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tool_choice?: unknown;
      };

      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "calculator_tool" },
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const model = llmGateway.createChatModel({ purpose: "tool" });
    await model.bindTools?.([calculator], {
      toolChoice: { type: "function", function: { name: "calculator_tool" } },
    }).invoke("2+2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes assistant tool calls and ToolMessage results into the next request", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_TOOL_MODEL", "qwen-plus-tool-test");
    vi.resetModules();

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown; content: unknown }>;
      };

      expect(body.messages?.[1]).toMatchObject({
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "calculator_tool",
              arguments: "{\"expression\":\"2+2\"}",
            },
          },
        ],
      });
      expect(body.messages?.[2]).toEqual({
        role: "tool",
        content: "4",
        tool_call_id: "call-1",
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "The answer is 4." } }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel({ purpose: "tool" }).invoke([
      new HumanMessage("2+2"),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "calculator_tool",
            args: { expression: "2+2" },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({ content: "4", tool_call_id: "call-1" }),
    ]);

    expect(String(response.content)).toBe("The answer is 4.");
  });

  it("allows OpenAI-compatible provider to reuse local CCR env aliases", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("CCR_BASE_URL", "http://127.0.0.1:3456/v1");
    vi.stubEnv("CCR_API_KEY", "ccr-test-key");
    vi.stubEnv("CCR_MODEL", "ccr-openai-compatible-model");
    vi.resetModules();

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
      };
      const headers = init?.headers as Record<string, string>;

      expect(body.model).toBe("ccr-openai-compatible-model");
      expect(headers.authorization).toBe("Bearer ccr-test-key");

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway, describeLlmGatewayConfig } = await import("./llm-gateway.js");
    const response = await llmGateway.createChatModel().invoke("ping");

    expect(String(response.content)).toBe("pong");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:3456/v1/chat/completions"
    );
    expect(describeLlmGatewayConfig()).toMatchObject({
      provider: "openai-compatible",
      endpointKind: "openai-chat-completions",
      baseUrlConfigured: true,
      apiKeyConfigured: true,
    });
  });

  it("reports sanitized JSON parse diagnostics without response body contents", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "openai-compatible-test-model");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('{"apiKey":"sk-secret-value"', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const { llmGateway } = await import("./llm-gateway.js");

    let error: unknown;
    try {
      await llmGateway.createChatModel().invoke("ping");
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("llm_response_json_parse_failed");
    expect(message).toContain('"provider":"openai-compatible"');
    expect(message).toContain('"endpointKind":"openai-chat-completions"');
    expect(message).toContain('"responseContentLength":');
    expect(message).not.toContain("sk-secret-value");
    expect(error).toMatchObject({
      name: "ProviderResponseParseError",
      decodeKind: "incomplete",
      errorCode: "JSON_DECODE_INCOMPLETE",
      byteLength: 27,
    });
    expect(error).toHaveProperty("rawHash");
  });

  it.each([
    [401, "Unauthorized", "provider_auth_error"],
    [403, "Forbidden", "provider_auth_error"],
    [429, "Too Many Requests", "quota_or_rate_limit_exceeded"],
    [400, "Bad Request", "provider_request_validation_error"],
    [500, "Internal Server Error", "provider_unavailable"],
  ])("maps Qwen HTTP %s errors without leaking API key", async (status, statusText, code) => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-secret-test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("{\"error\":\"qwen-secret-test-key\"}", {
          status,
          statusText,
        })
      )
    );

    const { llmGateway, formatLlmError } = await import("./llm-gateway.js");
    let error: unknown;
    try {
      await llmGateway.createChatModel({ maxRetries: 0 }).invoke("ping");
    } catch (caught) {
      error = caught;
    }

    const formatted = formatLlmError(error);
    expect(formatted).toContain(`Code: ${code}`);
    expect(formatted).toContain("Provider: qwen");
    expect(formatted).not.toContain("qwen-secret-test-key");
  });

  it("maps invalid Qwen JSON response without leaking response body contents", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-secret-test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('{"token":"qwen-secret-test-key"', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const { llmGateway, formatLlmError } = await import("./llm-gateway.js");
    let error: unknown;
    try {
      await llmGateway.createChatModel({ maxRetries: 0 }).invoke("ping");
    } catch (caught) {
      error = caught;
    }

    const formatted = formatLlmError(error);
    expect(formatted).toContain("Code: llm_response_json_parse_failed");
    expect(formatted).toContain("Provider: qwen");
    expect(formatted).not.toContain("qwen-secret-test-key");
  });

  it("maps Qwen network-like message failures to unknown_error without leaking API key", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-secret-test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );

    const { llmGateway, formatLlmError } = await import("./llm-gateway.js");
    let error: unknown;
    try {
      await llmGateway.createChatModel({ maxRetries: 0 }).invoke("ping");
    } catch (caught) {
      error = caught;
    }

    const formatted = formatLlmError(error);
    expect(formatted).toContain("Code: unknown_error");
    expect(formatted).toContain("message_matched_network_or_timeout_pattern");
    expect(formatted).toContain("Provider: qwen");
    expect(formatted).not.toContain("qwen-secret-test-key");
  });

  it("maps Qwen abort failures as timeout without leaking API key", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-secret-test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      })
    );

    const { llmGateway, formatLlmError } = await import("./llm-gateway.js");
    let error: unknown;
    try {
      await llmGateway.createChatModel({ maxRetries: 0 }).invoke("ping");
    } catch (caught) {
      error = caught;
    }

    const formatted = formatLlmError(error);
    expect(formatted).toContain("Code: timeout");
    expect(formatted).toContain("Provider: qwen");
    expect(formatted).not.toContain("qwen-secret-test-key");
  });
});
