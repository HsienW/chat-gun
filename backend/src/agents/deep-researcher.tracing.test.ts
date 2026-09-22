import { ToolMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNoopSpanManager,
  setSpanManagerForTests,
  type SpanOptions,
  type SpanManager,
} from "../platform/tracing/span-manager.js";
import {
  createNoopOpikTracer,
  setOpikTracerForTests,
  type NodeSpanMetadata,
  type ToolSpanMetadata,
} from "../platform/tracing/opik/opik-tracer.js";
import {
  deepResearcherTracingTestInternals,
  deepResearcherWeatherTestInternals,
} from "./deep-researcher.js";

vi.mock("../tools/authorization/tool-authorization.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../tools/authorization/tool-authorization.js")
  >();
  const db = {
    async query<TResult extends Record<string, unknown>>() {
      return { rows: [] as TResult[], rowCount: 0 };
    },
  };

  return {
    ...actual,
    createRuntimeToolAuthorizationComposition: () => {
      const composition = actual.createRuntimeToolAuthorizationComposition({
        profile: "development",
        db,
      });
      const resolveExecutionContext =
        composition.authorization.resolveExecutionContext;
      return {
        ...composition,
        authorization: {
          ...composition.authorization,
          resolveExecutionContext: (config: unknown) => {
            const runnableConfig =
              config && typeof config === "object" && !Array.isArray(config)
                ? (config as Record<string, unknown>)
                : {};
            const configurable =
              runnableConfig.configurable &&
              typeof runnableConfig.configurable === "object" &&
              !Array.isArray(runnableConfig.configurable)
                ? (runnableConfig.configurable as Record<string, unknown>)
                : {};
            return resolveExecutionContext?.({
              ...runnableConfig,
              configurable: {
                request_id: "test-request",
                thread_id: "test-thread",
                run_id: "test-run",
                task_id: "test-task",
                ...configurable,
              },
            });
          },
        },
      };
    },
  };
});

describe("deep researcher tracing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setSpanManagerForTests(undefined);
    setOpikTracerForTests(undefined);
  });

  it("wraps a graph node with node, task, and step attributes", async () => {
    const withSpan = vi.fn();
    const noopManager = createNoopSpanManager();
    const manager: SpanManager = {
      startSpan: (name, options) => noopManager.startSpan(name, options),
      endSpan: (span) => noopManager.endSpan(span),
      recordException: (span, error) => noopManager.recordException(span, error),
      setAttributes: (span, attributes) => noopManager.setAttributes(span, attributes),
      getActiveSpan: () => noopManager.getActiveSpan(),
      async withSpan<T>(
        name: string,
        options: SpanOptions,
        operation: () => Promise<T> | T
      ): Promise<T> {
        withSpan(name, options, operation);
        return operation();
      },
    };
    const node = vi.fn(async (_state: unknown, _config: unknown) => ({ completed: true }));
    const withNodeSpan = vi.fn();
    const opikTracer = createNoopOpikTracer();
    opikTracer.withNodeSpan = async function withNodeSpanForTest<T>(
      name: string,
      metadata: NodeSpanMetadata,
      operation: () => Promise<T>,
      input?: unknown
    ): Promise<T> {
      withNodeSpan(name, metadata, operation, input);
      return operation();
    };
    const traced = deepResearcherTracingTestInternals.traceNode(
      "plan_research",
      node,
      manager,
      opikTracer
    );

    await expect(
      traced(
        {},
        { configurable: { task_id: "task-1", step_id: "step-existing" } }
      )
    ).resolves.toEqual({ completed: true });
    expect(withSpan).toHaveBeenCalledWith(
      "langgraph.node.plan_research",
      {
        attributes: {
          "node.name": "plan_research",
          "step.id": "plan_research",
          "task.id": "task-1",
        },
      },
      expect.any(Function)
    );
    expect(withNodeSpan).toHaveBeenCalledWith(
      "plan_research",
      { stepId: "step-existing" },
      expect.any(Function),
      {}
    );
  });

  it("uses one tool call ID across OTel, Opik, governance, and ToolMessage", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const otelToolSpans: SpanOptions[] = [];
    const noopManager = createNoopSpanManager();
    const manager: SpanManager = {
      startSpan: (name, options) => noopManager.startSpan(name, options),
      endSpan: (span) => noopManager.endSpan(span),
      recordException: (span, error) => noopManager.recordException(span, error),
      setAttributes: (span, attributes) => noopManager.setAttributes(span, attributes),
      getActiveSpan: () => noopManager.getActiveSpan(),
      async withSpan<T>(
        name: string,
        options: SpanOptions,
        operation: () => Promise<T> | T
      ): Promise<T> {
        if (name === "tool.execute") otelToolSpans.push(options);
        return operation();
      },
    };
    const opikToolSpans: ToolSpanMetadata[] = [];
    const opikTracer = createNoopOpikTracer();
    opikTracer.withToolSpan = async function withToolSpanForTest<T>(
      metadata: ToolSpanMetadata,
      operation: () => Promise<T>
    ): Promise<T> {
      opikToolSpans.push(metadata);
      return operation();
    };
    setSpanManagerForTests(manager);
    setOpikTracerForTests(opikTracer);

    const toolResult = await deepResearcherWeatherTestInternals.targetedTools(
      ({
        plan: {
          question: "What is 123 * 456?",
          answerMode: "calculation",
          rationale: "Calculation requires the calculator tool.",
          queries: [],
          urls: [],
          calculation: { expression: "123 * 456" },
          requiredSourceCount: 1,
        },
      } as unknown) as Parameters<
        typeof deepResearcherWeatherTestInternals.targetedTools
      >[0],
      { configurable: { thread_id: "thread-1", existing: "preserved" } }
    );

    const toolMessage = toolResult.messages?.[0] as ToolMessage | undefined;
    const toolCallId = toolMessage?.tool_call_id;
    expect(toolCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(otelToolSpans).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.call.id": toolCallId,
          "tool.name": "calculator_tool",
        }),
      }),
    ]);
    expect(opikToolSpans).toEqual([
      {
        toolName: "calculator_tool",
        stepId: "targeted_tools",
        toolCallId,
      },
    ]);
  });
});
