import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepResearcherGraph, deepResearcherWeatherTestInternals } from "./deep-researcher.js";
import { llmGateway } from "../platform/llm-gateway.js";
import { PgGraphTaskAdmission } from "../runtime/execution-context/graph-task-admission.js";

type ResearchState = Parameters<typeof deepResearcherWeatherTestInternals.synthesizeAnswer>[0];

function state(): ResearchState {
  return {
    executionTaskId: undefined,
    messages: [
      new HumanMessage("Earlier weather request"),
      new ToolMessage({ content: "OLD_WEATHER_EVIDENCE", name: "current_weather", tool_call_id: "old" }),
      new AIMessage("Earlier answer"),
      new HumanMessage("Current news request"),
      new ToolMessage({ content: "CURRENT_SEARCH_FAILURE", name: "web_search", tool_call_id: "new" }),
    ],
    plan: { question: "Current news request", answerMode: "research", rationale: "news", queries: [], urls: [], requiredSourceCount: 1 },
    contextPack: undefined, initial_search_query_count: 1, max_research_loops: 1,
    reasoning_model: "", searchResults: [], rankedSources: [], fetchedSources: [], extractedSources: [],
    verification: undefined, uploadError: undefined, imageObservations: [], weatherExecution: undefined,
    clarification: undefined,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("deep researcher current-turn evidence", () => {
  it.each([
    ["role message", { role: "human", content: "Current news request" }],
    ["serialized message", new HumanMessage("Current news request").toJSON()],
  ])("normalizes a %s before upload validation", async (_format, wireMessage) => {
    vi.spyOn(PgGraphTaskAdmission.prototype, "admit")
      .mockImplementation(async (context) => context.taskId);
    const configurable = {
      thread_id: crypto.randomUUID(), run_id: crypto.randomUUID(), "x-request-id": crypto.randomUUID(),
      "x-bff-principal-id": "principal-1", "x-bff-principal-type": "service",
      "x-bff-tenant-id": "tenant-1", "x-bff-roles": "member", "x-bff-scopes": "search:read",
      "x-bff-auth-source": "trusted_gateway", "x-bff-authenticated-at": "2026-10-11T00:00:00.000Z",
      "x-bff-scope-id": "scope-1", "x-bff-scope-type": "tenant",
    };

    const requestPayload = JSON.parse(JSON.stringify({ messages: [wireMessage] }));
    await deepResearcherGraph.invoke(requestPayload, {
      configurable, interruptBefore: ["build_context_pack"],
    });
    const paused = await deepResearcherGraph.getState({ configurable });
    expect(paused.values.messages.at(-1)).toBeInstanceOf(HumanMessage);
    expect(paused.values.uploadError).toBeUndefined();
    expect(paused.next).toEqual(["build_context_pack"]);
  });

  it("resets persisted state on a new prompt and retains its Task across native resume", async () => {
    const admit = vi.spyOn(PgGraphTaskAdmission.prototype, "admit")
      .mockImplementation(async (context, resumedTaskId) => resumedTaskId ?? context.taskId);
    const prompts: string[] = [];
    const model = llmGateway.createChatModel({ purpose: "research" });
    vi.spyOn(model, "invoke").mockImplementation(async (prompt) => {
      prompts.push(String(prompt));
      return new AIMessage(prompts.length === 1 ? JSON.stringify({
        question: "Current news request", answerMode: "direct", rationale: "fixture",
        queries: [], urls: [], requiredSourceCount: 1,
      }) : "New answer");
    });
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue(model);
    const configurable = {
      thread_id: crypto.randomUUID(), run_id: crypto.randomUUID(), "x-request-id": crypto.randomUUID(),
      "x-bff-principal-id": "principal-1", "x-bff-principal-type": "service",
      "x-bff-tenant-id": "tenant-1", "x-bff-roles": "member", "x-bff-scopes": "search:read",
      "x-bff-auth-source": "trusted_gateway", "x-bff-authenticated-at": "2026-10-11T00:00:00.000Z",
      "x-bff-scope-id": "scope-1", "x-bff-scope-type": "tenant",
    };
    const previous = state();
    previous.messages = previous.messages.slice(0, 3);
    previous.uploadError = "old upload failure";
    previous.imageObservations = ["old image"];
    previous.executionTaskId = "old-task";
    await deepResearcherGraph.updateState({ configurable }, previous);
    await deepResearcherGraph.invoke({ messages: [new HumanMessage("Current news request")] }, {
      configurable, interruptBefore: ["synthesize_answer"],
    });
    const paused = await deepResearcherGraph.getState({ configurable });
    expect(paused.next).toEqual(["synthesize_answer"]);
    expect(paused.values.uploadError).toBeUndefined();
    expect(paused.values).toMatchObject({ imageObservations: [], extractedSources: [] });
    expect(paused.values.executionTaskId).not.toBe("old-task");
    const resumed = await deepResearcherGraph.invoke(null, { configurable: { ...configurable, run_id: crypto.randomUUID() } });
    expect(resumed.executionTaskId).toBe(paused.values.executionTaskId);
    expect(admit.mock.calls[1]?.[1]).toBe(paused.values.executionTaskId);
    expect(prompts).toHaveLength(2);
    expect(prompts.join("\n")).not.toContain("OLD_WEATHER_EVIDENCE");
    expect(resumed.messages.length).toBeGreaterThan(previous.messages.length);
  });

  it("clears stale per-turn state and validates only the new input", async () => {
    const previous = state();
    previous.uploadError = "old upload failure";
    previous.imageObservations = ["old image"];
    previous.verification = { usableSourceCount: 9, rejectedSourceCount: 0, warnings: [] };
    previous.messages.unshift(new HumanMessage({ content: [{ type: "image_url", image_url: { url: "invalid-old-image" } }] }));
    const update = await deepResearcherWeatherTestInternals.validateUploads(previous, {});
    expect(update).toMatchObject({
      plan: undefined, searchResults: [], rankedSources: [], fetchedSources: [], extractedSources: [],
      imageObservations: [], uploadError: undefined, verification: undefined, clarification: undefined,
    });
    expect(previous.uploadError).toBe("old upload failure");
  });
  it.each(["true", "false"])("does not reinject old tools or duplicate current evidence (assembly %s)", async (enabled) => {
    vi.stubEnv("CONTEXT_ASSEMBLY_ENABLED_DEEP_RESEARCHER", enabled);
    const prompts: string[] = [];
    const model = llmGateway.createChatModel({ purpose: "research" });
    vi.spyOn(model, "invoke").mockImplementation(async (prompt) => {
      prompts.push(String(prompt));
      return new AIMessage("No current sources available.");
    });
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue(model);
    await deepResearcherWeatherTestInternals.synthesizeAnswer(state(), {});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("OLD_WEATHER_EVIDENCE");
    expect(prompts[0]?.match(/CURRENT_SEARCH_FAILURE/g)).toHaveLength(1);
  });
});
