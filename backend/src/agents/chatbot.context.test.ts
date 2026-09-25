import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatbotGraph } from "./chatbot.js";
import { llmGateway } from "../platform/llm-gateway.js";

describe("chatbot shared context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends multi-turn input through the priority-based shared boundary", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage("ok"));
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    await chatbotGraph.invoke({
      messages: [
        new HumanMessage("old question"),
        new AIMessage("old answer"),
        new HumanMessage("current question"),
      ],
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining("## System policy")
    );
    expect(String(invoke.mock.calls[0]?.[0])).toContain("## Current task");
    expect(String(invoke.mock.calls[0]?.[0])).toContain("## Recent user message");
  });

  it("does not call the model when P0 cannot fit", async () => {
    vi.stubEnv("AGENT_CONTEXT_BUDGET_TOTAL", "1");
    const invoke = vi.fn();
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    const result = await chatbotGraph.invoke({
      messages: [new HumanMessage("current question")],
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(String(result.messages.at(-1)?.content)).toContain("context_p0_overflow");
  });
});
