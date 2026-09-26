import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { readNormalizedAgentInput } from "./read-normalized-agent-input.js";

describe("readNormalizedAgentInput", () => {
  it("adapts a legacy raw string to a prompt", () => {
    expect(readNormalizedAgentInput("  hello\u0000  ")).toMatchObject({
      status: "valid",
      input: { kind: "prompt", text: "hello", attachments: [] },
      rawInputRef: { algorithm: "sha256" },
    });
  });

  it("adapts LangChain messages using the latest human message", () => {
    expect(
      readNormalizedAgentInput({
        messages: [new HumanMessage("first"), new HumanMessage("latest")],
      }),
    ).toMatchObject({
      status: "valid",
      input: { kind: "prompt", text: "latest" },
    });
  });

  it("adapts legacy string messages using the latest value", () => {
    expect(readNormalizedAgentInput({ messages: ["first", "latest"] })).toMatchObject({
      status: "valid",
      input: { kind: "prompt", text: "latest" },
    });
  });

  it("adapts a LangGraph clarification resume command with interrupt identity", () => {
    const command = new Command({ resume: { answer: "Taipei" } });

    expect(
      readNormalizedAgentInput(command, {
        configurable: {
          clientInteractionMetadata: {
            inputKind: "clarification_resume",
            interruptId: "interrupt-1",
          },
        },
      }),
    ).toMatchObject({
      status: "valid",
      input: {
        kind: "clarification_resume",
        interruptId: "interrupt-1",
        value: { answer: "Taipei" },
      },
    });
  });

  it("reads interrupt identity from the canonical resume payload", () => {
    expect(
      readNormalizedAgentInput({
        command: { resume: { answer: "Taipei" } },
        interruptId: "interrupt-2",
      }, {
        configurable: {
          clientInteractionMetadata: {
            inputKind: "clarification_resume",
          },
        },
      }),
    ).toMatchObject({
      status: "valid",
      input: {
        kind: "clarification_resume",
        interruptId: "interrupt-2",
        value: { answer: "Taipei" },
      },
    });
  });

  it("accepts cancel without a target as a business no-op request", () => {
    expect(readNormalizedAgentInput({ kind: "cancel" })).toMatchObject({
      status: "valid",
      input: { kind: "cancel" },
    });
  });

  it("classifies command input as explicitly unsupported", () => {
    expect(
      readNormalizedAgentInput({ kind: "command", commandId: "refresh" }),
    ).toMatchObject({
      status: "unsupported",
      errorCode: "unsupported_command",
    });
  });

  it("rejects unknown kinds and empty prompts before orchestration", () => {
    expect(readNormalizedAgentInput({ kind: "other" })).toMatchObject({
      status: "invalid",
      errorCode: "unsupported_input_kind",
    });
    expect(readNormalizedAgentInput(" \u0000 ")).toMatchObject({
      status: "invalid",
      errorCode: "empty_input",
    });
  });
});
