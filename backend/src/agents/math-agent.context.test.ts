import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mathAgentGraph } from "./math-agent.js";
import { llmGateway } from "../platform/llm-gateway.js";

describe("math agent shared context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves multiple turns in bounded context when calculator dispatch is not selected", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage("ok"));
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });

    await mathAgentGraph.invoke({
      messages: [
        new HumanMessage("先說明方法"),
        new AIMessage("先整理定義"),
        new HumanMessage("請繼續推理"),
      ],
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining("## System policy")
    );
    expect(String(invoke.mock.calls[0]?.[0])).toContain("請繼續推理");
    expect(String(invoke.mock.calls[0]?.[0])).toContain("先說明方法");
  });
});
