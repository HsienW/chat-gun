import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { ContextPriority } from "../context/context-budget.js";
import {
  assembleAgentContext,
  assembleMcpMessageContext,
  contextHardLimitErrorMessage,
} from "./context-integration.js";
import { ContextHardLimitError } from "../context/context-errors.js";

const limits = {
  contextBudgetTotal: 1_000,
  contextOutputReserveTokens: 10,
  capabilities: { contextWindowTokens: 2_000, maxOutputTokens: 20 },
};

describe("agent context integration", () => {
  it("classifies current, recent, active-state, and tool sources", async () => {
    const assembled = await assembleAgentContext({
      systemPolicy: "system",
      messages: [new HumanMessage("old"), new AIMessage("reply"), new HumanMessage("now")],
      activeState: [{ content: "plan", referenceId: "plan-1" }],
      toolOutputs: [{ content: "tool", referenceId: "tool-1" }],
      limits,
    });

    expect(assembled.blocks.map(({ priority }) => priority)).toEqual([
      ContextPriority.P0,
      ContextPriority.P1,
      ContextPriority.P2,
      ContextPriority.P4,
      ContextPriority.P4,
      ContextPriority.P5,
    ]);
  });

  it("keeps or drops assistant tool-call and tool-result messages as one unit", async () => {
    const toolCall = new AIMessage({
      content: "",
      tool_calls: [{ id: "call-1", name: "calculator", args: { expression: "2+2" } }],
    });
    const toolResult = new ToolMessage({ content: "4", tool_call_id: "call-1" });
    const roomy = await assembleMcpMessageContext({
      systemPolicy: "system",
      messages: [new HumanMessage("old"), toolCall, toolResult, new HumanMessage("now")],
      limits,
    });
    expect(roomy.messages.indexOf(toolResult)).toBe(roomy.messages.indexOf(toolCall) + 1);

    const secondTurn = await assembleMcpMessageContext({
      systemPolicy: "system",
      messages: [new HumanMessage("now"), toolCall, toolResult],
      limits,
    });
    expect(secondTurn.messages).toEqual([
      { role: "system", content: "system" },
      expect.any(HumanMessage),
      toolCall,
      toolResult,
    ]);

    const constrained = await assembleMcpMessageContext({
      systemPolicy: "s",
      messages: [toolCall, toolResult, new HumanMessage("q")],
      limits: {
        contextBudgetTotal: 11,
        contextOutputReserveTokens: 1,
        capabilities: { contextWindowTokens: 100, maxOutputTokens: 1 },
      },
    });
    expect(constrained.messages).not.toContain(toolCall);
    expect(constrained.messages).not.toContain(toolResult);
  });

  it("emits exactly one system policy when state already contains a system message", async () => {
    const assembled = await assembleMcpMessageContext({
      systemPolicy: "system",
      messages: [new SystemMessage("system"), new HumanMessage("now")],
      limits,
    });

    expect(
      assembled.messages.filter(
        (message) =>
          message instanceof SystemMessage ||
          (!(message instanceof AIMessage) &&
            "role" in message &&
            message.role === "system")
      )
    ).toHaveLength(1);
  });

  it("drops a compressed tool pair instead of leaking the original oversized output", async () => {
    const toolCall = new AIMessage({
      content: "",
      tool_calls: [{
        id: "call-large",
        name: "fetch",
        args: { url: "https://example.test" },
      }],
    });
    const toolResult = new ToolMessage({
      content: "x".repeat(3_000),
      tool_call_id: "call-large",
    });
    const assembled = await assembleMcpMessageContext({
      systemPolicy: "s",
      messages: [new HumanMessage("q"), toolCall, toolResult],
      limits: {
        contextBudgetTotal: 700,
        contextOutputReserveTokens: 1,
        capabilities: { contextWindowTokens: 2_000, maxOutputTokens: 1 },
      },
    });

    const retainedToolBlock = assembled.assembled.blocks.find(
      ({ referenceId }) => referenceId === "tool-pair-1"
    );
    expect(retainedToolBlock).toBeDefined();
    expect(retainedToolBlock?.content).not.toBe(`\n${"x".repeat(3_000)}`);
    expect(assembled.messages).not.toContain(toolCall);
    expect(assembled.messages).not.toContain(toolResult);
  });

  it("serializes context terminal errors through the existing envelope", () => {
    const message = contextHardLimitErrorMessage(
      new ContextHardLimitError("context_p0_overflow", "too large")
    );
    expect(JSON.parse(String(message.content))).toMatchObject({
      error: {
        source: "backend",
        stage: "context_assembly",
        code: "context_p0_overflow",
      },
    });
  });
});
