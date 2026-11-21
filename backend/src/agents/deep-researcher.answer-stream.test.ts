import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerStreamInterruptedError, AnswerStreamRefusedError } from "../platform/answer-text-sink.js";
import { createErrorEnvelope, serializeErrorEnvelope } from "../platform/errors.js";
import { llmGateway, type ChatModelInvokeOptions } from "../platform/llm-gateway.js";
import { createAnswerStreamWiring } from "../runtime/answer-stream/answer-stream-wiring.js";
import { RunSequenceAllocator } from "../runtime/event-sequence.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { PgGraphTaskAdmission } from "../runtime/execution-context/graph-task-admission.js";
import { deepResearcherGraph, deepResearcherWeatherTestInternals as internals } from "./deep-researcher.js";

vi.mock("../runtime/recovery/clarification-manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/recovery/clarification-manifest.js")>()),
  persistClarificationInterruptManifest: vi.fn(async () => undefined),
}));

type ResearchState = Parameters<typeof internals.synthesizeAnswer>[0];
const rawAnswer = "One [1]. Two [2].";
const cleanAnswer = "One [1]. Two.";
const authenticatedAt = "2026-11-19T00:00:00.000Z";
const context: ExecutionContext = {
  requestId: "request-1", threadId: "thread-1", runId: "run-1", taskId: "task-1", attempt: 1,
  principal: { principalId: "user-1", tenantId: "tenant-1", principalType: "user", authSource: "trusted_gateway", authenticatedAt, roles: [], scopes: [] },
  scope: { scopeId: "tenant-1", scopeType: "tenant", tenantId: "tenant-1" },
};

function researchState(): ResearchState {
  return {
    executionTaskId: undefined, messages: [new HumanMessage("Research question")],
    plan: { question: "Research question", answerMode: "research", rationale: "fixture", queries: [], urls: [], requiredSourceCount: 1 },
    initial_search_query_count: 1, max_research_loops: 1, reasoning_model: "", contextPack: undefined,
    searchResults: [], rankedSources: [], fetchedSources: [],
    extractedSources: [{ index: 1, title: "Fixture", url: "https://example.com/source", summary: "Known fact", keyClaims: [], usable: true }],
    verification: undefined, uploadError: undefined, imageRecognition: undefined, imageObservations: [], weatherExecution: undefined, clarification: undefined,
  };
}

function fixture(enabled = true) {
  const writer = vi.fn();
  const cfg: LangGraphRunnableConfig = { writer, configurable: { execution_context: context } };
  const wiring = createAnswerStreamWiring({ sequenceAllocator: new RunSequenceAllocator(),
    createMessageId: () => "draft-1", readSettings: () => ({ enabled, envelopeEnabled: true }), observer: { recordMetric: vi.fn() } });
  const prepare = vi.spyOn(wiring, "prepare");
  return { cfg, writer, wiring, prepare };
}

async function publish(options: ChatModelInvokeOptions | undefined, text: string) {
  const attempt = options?.answerTextSink?.beginAttempt({ provider: "qwen", attemptIndex: 0 });
  await attempt?.append(text);
  attempt?.seal("completed");
}

beforeEach(() => {
  vi.stubEnv("DEEP_RESEARCH_CITATION_GUARD", "true");
  vi.stubEnv("CONTEXT_ASSEMBLY_ENABLED_DEEP_RESEARCHER", "false");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("deep researcher answer stream", () => {
  it.each([false, true])("publishes the draft and serializes the guarded final content (array content: %s)", async (useBlocks) => {
    const { cfg, writer, wiring, prepare } = fixture();
    const invoke = vi.fn(async (_prompt: unknown, options?: ChatModelInvokeOptions) => {
      await publish(options, rawAnswer);
      return new AIMessage({ content: useBlocks ? [{ type: "text", text: rawAnswer }] : rawAnswer, response_metadata: { provider: "fixture" } });
    });
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });
    const result = await internals.synthesizeAnswer(researchState(), cfg, wiring);
    expect(prepare).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ type: "model.stream", payload: {
      delta: rawAnswer, messageId: "draft-1", outputKind: "answer_text", textOffset: 0,
    } }));
    expect(result.messages?.[0]?.toJSON()).toMatchObject({ kwargs: { id: "draft-1", content: cleanAnswer, response_metadata: { provider: "fixture" } } });
    expect(result.verification?.citationGuard).toMatchObject({ modified: true, removedMarkers: [2] });
  });

  it.each([
    [new AnswerStreamInterruptedError(new Error("reader failed"), "provider_retry"), "answer_stream_interrupted"],
    [new AnswerStreamRefusedError(), "answer_stream_refused"],
  ])("throws the run error instead of returning a fallback (%s)", async (failure, code) => {
    const { cfg, writer, wiring } = fixture();
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ async invoke(_prompt, options) {
      await publish(options, "partial");
      throw failure;
    } });
    await expect(internals.synthesizeAnswer(researchState(), cfg, wiring)).rejects.toMatchObject({ name: "AnswerStreamRunError", code });
    expect(writer).toHaveBeenCalledOnce();
  });

  it.each(["upload", "clarify", "weather", "targeted-tool-error"] as const)("never prepares a sink for %s", async (branch) => {
    const { cfg, wiring, writer, prepare } = fixture();
    const model = vi.spyOn(llmGateway, "createChatModel");
    const state = researchState();
    const plan = state.plan!;
    if (branch === "upload") state.uploadError = "upload invalid";
    if (branch === "clarify" || branch === "weather") plan.answerMode = branch;
    if (branch === "targeted-tool-error") {
      plan.answerMode = "calculation";
      const error = createErrorEnvelope(new Error("calculation failed"), { source: "backend", stage: "tool" });
      state.messages.push(new ToolMessage({ name: "calculator_tool", tool_call_id: "fixture-error", content: serializeErrorEnvelope(error) }));
    }
    expect((await internals.synthesizeAnswer(state, cfg, wiring)).messages).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("keeps the ordinary guarded reply with the feature disabled", async () => {
    const { cfg, writer, wiring } = fixture(false);
    const invoke = vi.fn(async () => new AIMessage({ id: "provider-id", content: rawAnswer }));
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });
    const update = await internals.synthesizeAnswer(researchState(), cfg, wiring);
    expect(invoke).toHaveBeenCalledWith(expect.any(String), expect.not.objectContaining({ answerTextSink: expect.anything() }));
    expect(update.messages?.[0]?.toJSON()).toMatchObject({ kwargs: { id: "provider-id", content: cleanAnswer } });
    expect(writer).not.toHaveBeenCalled();
  });

  it("allocates the answer on native clarification resume without checkpointing the draft", async () => {
    vi.stubEnv("ANSWER_TEXT_STREAMING_ENABLED", "true");
    vi.stubEnv("RUNTIME_EVENT_ENVELOPE_ENABLED", "true");
    vi.spyOn(PgGraphTaskAdmission.prototype, "admit").mockImplementation(async (candidate, resumedTaskId) => resumedTaskId ?? candidate.taskId);
    const invoke = vi.fn(async (_prompt: unknown, options?: ChatModelInvokeOptions) => {
      expect(options?.answerTextSink).toBeDefined();
      await publish(options, rawAnswer);
      return new AIMessage(rawAnswer);
    });
    vi.spyOn(llmGateway, "createChatModel").mockReturnValue({ invoke });
    const thread_id = crypto.randomUUID();
    const config = {
      thread_id, run_id: crypto.randomUUID(), "x-request-id": "request-clarify",
      "x-bff-principal-id": "user-1", "x-bff-principal-type": "user", "x-bff-tenant-id": "tenant-1",
      "x-bff-roles": "member", "x-bff-scopes": "chat:write", "x-bff-auth-source": "trusted_gateway",
      "x-bff-authenticated-at": authenticatedAt, "x-bff-scope-id": "tenant-1", "x-bff-scope-type": "tenant",
    };
    const state = researchState();
    state.executionTaskId = context.taskId;
    // Seed a research plan at the clarification boundary to cover the conditional research resume path.
    state.weatherExecution = { status: "needs_clarification", result: {
      status: "needs_clarification", schemaVersion: "1.0", tool: "current_weather",
      requestedLocation: { raw: "Springfield", location: "Springfield" }, message: "Ambiguous city", summary: "Choose one",
      candidates: [
        { name: "Springfield", displayName: "Springfield, A", latitude: 1, longitude: 2, timezone: "UTC" },
        { name: "Springfield", displayName: "Springfield, B", latitude: 4, longitude: 5, timezone: "UTC" },
      ],
    } };
    state.clarification = internals.buildClarificationState(state, { configurable: { execution_context: { ...context, threadId: thread_id, runId: config.run_id } } });
    expect(state.clarification).toBeDefined();
    await deepResearcherGraph.updateState({ configurable: config }, state, "targeted_tools");
    const start = await deepResearcherGraph.invoke(null, { configurable: config });
    expect(start).toHaveProperty("__interrupt__");
    expect(invoke).not.toHaveBeenCalled();
    const paused = await deepResearcherGraph.getState({ configurable: config });
    expect(paused.next).toEqual(["clarify_interrupt"]);
    expect(paused.values).not.toHaveProperty("answerTextSink");
    expect(paused.values).not.toHaveProperty("messageId");
    const resumedRunId = crypto.randomUUID();
    const stream = await deepResearcherGraph.stream(new Command({ resume: {} }), { configurable: { ...config, run_id: resumedRunId }, streamMode: ["custom", "updates"] });
    const frames: unknown[] = [];
    for await (const frame of stream) frames.push(frame);
    expect(invoke).toHaveBeenCalledOnce();
    const final = (await deepResearcherGraph.getState({ configurable: config })).values.messages.at(-1);
    expect(final?.content).toBe(cleanAnswer);
    expect(final?.id).toBeDefined();
    expect(frames).toContainEqual(["custom", expect.objectContaining({ type: "model.stream", context: expect.objectContaining({ runId: resumedRunId }), payload: expect.objectContaining({ messageId: final?.id, delta: rawAnswer }) })]);
  });
});
