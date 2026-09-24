import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Qwen tool-calling round trip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("executes a model tool call through ToolNode and sends ToolMessage into the final model turn", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("QWEN_TOOL_MODEL", "qwen-plus-tool-test");
    vi.resetModules();

    const calculator = tool(async ({ expression }: { expression: string }) => {
      return expression === "2+2" ? "4" : "unsupported";
    }, {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({
        expression: z.string(),
      }),
    });
    const toolNode = new ToolNode([calculator]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
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
        )
      )
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role: string; tool_call_id?: string; content: unknown }>;
        };
        const toolMessage = body.messages?.find((message) => message.role === "tool");

        expect(toolMessage).toEqual({
          role: "tool",
          content: "4",
          tool_call_id: "call-1",
        });

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Final answer: 4" } }],
          }),
          { status: 200 }
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("../platform/llm-gateway.js");
    const model = llmGateway.createChatModel({ purpose: "tool", temperature: 0 });
    const first = await model.bindTools?.([calculator]).invoke([new HumanMessage("2+2")]);

    expect((first as AIMessage).tool_calls?.[0]).toMatchObject({
      id: "call-1",
      name: "calculator_tool",
      args: { expression: "2+2" },
      type: "tool_call",
    });

    const toolResult = await toolNode.invoke({
      messages: [new HumanMessage("2+2"), first],
    });
    const second = await model.invoke([
      new HumanMessage("2+2"),
      first,
      ...toolResult.messages,
    ]);

    expect(String(second.content)).toBe("Final answer: 4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops malformed Tool arguments before ToolNode or physical dispatch", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_KEY", "qwen-test-key");
    vi.stubEnv("LLM_REPAIR_STRATEGY", "none");
    vi.resetModules();

    const physicalDispatch = vi.fn(async () => "must not run");
    const calculator = tool(physicalDispatch, {
      name: "calculator_tool",
      description: "Evaluate a deterministic expression.",
      schema: z.object({ expression: z.string() }),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: {
          content: null,
          tool_calls: [{
            id: "call-malformed",
            type: "function",
            function: {
              name: "calculator_tool",
              arguments: '{"expression":"2+',
            },
          }],
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { llmGateway } = await import("../platform/llm-gateway.js");
    const model = llmGateway
      .createChatModel({ purpose: "tool", temperature: 0, maxRetries: 2 })
      .bindTools?.([calculator]);

    await expect(model?.invoke([new HumanMessage("2+2")])).rejects.toMatchObject({
      name: "ToolArgumentDecodeError",
      code: "provider_decode_failure",
      decodeKind: "incomplete",
    });
    expect(physicalDispatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
