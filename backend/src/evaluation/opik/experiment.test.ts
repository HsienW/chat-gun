import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRUSTED_PRINCIPAL_HEADERS } from "../../runtime/authorization/principal.js";
import { executionContextSchema } from "../../runtime/execution-context/execution-context.js";
import { createGraphEntryContextResolver } from "../../runtime/execution-context/graph-entry.js";
import { instrumentGraphWithExecutionContext } from "../../runtime/execution-context/instrument-graph.js";
import { TRUSTED_SCOPE_FIELDS } from "../../runtime/execution-context/read-execution-context.js";
import { createNoopOpikTracer } from "../../platform/tracing/opik/opik-tracer.js";
import type {
  AgentRunMetadata,
} from "../../platform/tracing/opik/opik-tracer.js";
import { ToolCallCorrectnessMetric } from "./metrics/tool-call-correctness.js";
import { ResponseQualityMetric } from "./metrics/response-quality.js";
import {
  createPinnedDatasetLoader,
  experimentTestInternals,
  runExperiment,
  type ExperimentDependencies,
  type ExperimentConfig,
} from "./experiment.js";
import type { EvaluationDataset } from "./types.js";

const tempDirectories: string[] = [];

const dataset: EvaluationDataset = {
  name: "weather-golden",
  version: "v1.0.0",
  items: [
    {
      id: "tokyo",
      input: { intent: "weather", parameters: { location: "Tokyo" } },
      expectedOutput: {
        toolCalls: [{ name: "current_weather", arguments: { location: "Tokyo" } }],
        summary: "Current Tokyo weather",
      },
    },
    {
      id: "taipei",
      input: { intent: "weather", parameters: { location: "Taipei" } },
      expectedOutput: {
        toolCalls: [{ name: "current_weather", arguments: { location: "Taipei" } }],
        summary: "Current Taipei weather",
      },
    },
  ],
};

function baseConfig(outputDir: string, model = "agent-a"): ExperimentConfig {
  return {
    datasetVersion: "v1.0.0",
    agentConfig: { model, provider: "qwen", promptVersion: "weather-v1" },
    judgeConfig: {
      model: "judge-a",
      provider: "qwen",
      temperature: 0,
      promptVersion: "judge-v1",
      promptTemplateHash: "a".repeat(64),
    },
    metrics: [new ToolCallCorrectnessMetric()],
    outputDir,
    perItemTimeoutMs: 1_000,
  };
}

function dependencies(
  overrides: Partial<ExperimentDependencies> = {}
): ExperimentDependencies {
  return {
    loadDataset: async () => dataset,
    runAgent: async (item) => ({
      response: `Weather response for ${item.id}`,
      toolCalls: [
        {
          name: "current_weather",
          arguments: {
            location: item.id === "tokyo" ? "Tokyo" : "Taipei",
          },
        },
      ],
      tokenCostUsd: 0.01,
    }),
    tracer: createNoopOpikTracer(),
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    localExperimentId: () => "experiment-test",
    publishHostedExperiment: async () => ({
      hostedStatus: "SKIPPED",
      hostedSkipReason: "disabled",
    }),
    ...overrides,
  };
}

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("readToolCalls", () => {
  const readToolCalls = experimentTestInternals.readToolCalls;

  function executedToolMessage(
    name: string,
    arguments_: Record<string, unknown>,
    toolCallId: string
  ): ToolMessage {
    return new ToolMessage({
      content: JSON.stringify({ status: "success" }),
      name,
      tool_call_id: toolCallId,
      artifact: {
        schemaVersion: "1.0",
        type: "executed_tool_call",
        name,
        arguments: arguments_,
      },
    });
  }

  it("extracts current_weather from ToolMessage execution evidence", () => {
    const calls = readToolCalls([
      executedToolMessage(
        "current_weather",
        { raw: "台北", location: "台北", queryName: "Taipei" },
        "weather-1"
      ),
    ]);

    expect(calls).toEqual([
      {
        name: "current_weather",
        arguments: { raw: "台北", location: "台北", queryName: "Taipei" },
      },
    ]);
  });

  it("preserves every execution when a weather request is retried", () => {
    const calls = readToolCalls([
      executedToolMessage(
        "current_weather",
        { raw: "北京市", location: "北京市" },
        "weather-1"
      ),
      executedToolMessage(
        "current_weather",
        {
          raw: "北京市",
          location: "Beijing",
          country: "China",
          resolutionStrategy: "llm_repair",
        },
        "weather-2"
      ),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.arguments).toMatchObject({
      raw: "北京市",
      location: "Beijing",
      country: "China",
      resolutionStrategy: "llm_repair",
    });
  });

  it("does not infer tool calls from natural-language responses", () => {
    expect(
      readToolCalls([
        new AIMessage("I called current_weather for Taipei and it is sunny."),
      ])
    ).toEqual([]);
  });

  it("gives the Taipei live-case tool evidence a non-zero correctness score", () => {
    const item = dataset.items.find((candidate) => candidate.id === "taipei");
    if (!item) throw new Error("Taipei fixture is required");
    const toolCalls = readToolCalls([
      executedToolMessage(
        "current_weather",
        { raw: "台北", location: "Taipei", queryName: "Taipei" },
        "weather-1"
      ),
    ]);

    const score = new ToolCallCorrectnessMetric().evaluate(item, {
      response: "Taipei weather",
      toolCalls,
    });

    expect(score.value).toBeGreaterThan(0);
    expect(score.reason).not.toBe("No tool calls executed");
  });
});

describe("runExperiment", () => {
  it.each([
    ["maxItems", Number.NaN],
    ["maxItems", 1.5],
    ["perItemTimeoutMs", Number.POSITIVE_INFINITY],
    ["maxTotalCostUsd", -0.01],
  ] as const)("rejects invalid bounded-run config %s=%s", async (key, value) => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);

    await expect(
      runExperiment(
        { ...baseConfig(outputDir), [key]: value },
        dependencies()
      )
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects a default-runner provider label that differs from the gateway", () => {
    expect(() =>
      experimentTestInternals.validateDefaultProvider("openai", "qwen")
    ).toThrow(/does not match configured provider/);
  });

  it("rejects judge evidence that differs from the executing metric", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const responseMetric = new ResponseQualityMetric(
      {
        model: "judge-real",
        provider: "qwen",
        promptTemplate: "Return score and reasoning.",
        promptVersion: "judge-v1",
      },
      { invoke: async () => ({ score: 1, reasoning: "ok" }) }
    );

    await expect(
      runExperiment(
        {
          ...baseConfig(outputDir),
          metrics: [responseMetric],
          judgeConfig: {
            model: "judge-recorded-wrongly",
            provider: "qwen",
            temperature: 0,
            promptVersion: "judge-v1",
            promptTemplateHash: responseMetric.judgeConfig.promptTemplateHash,
          },
        },
        dependencies()
      )
    ).rejects.toThrow(/judgeConfig does not match/);
  });

  it("flushes trace feedback and keeps offline results when flush fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tracer = createNoopOpikTracer();
    tracer.flush = vi.fn(async () => {
      throw new Error("hosted unavailable");
    });

    const result = await runExperiment(
      baseConfig(outputDir),
      dependencies({ tracer })
    );

    expect(result.items.every((item) => item.status === "COMPLETED")).toBe(true);
    expect(tracer.flush).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"opik_experiment_flush_failed"')
    );
  });

  it("produces comparable deterministic scores for the same config", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const config = baseConfig(outputDir);

    const first = await runExperiment(config, dependencies());
    const second = await runExperiment(config, dependencies());

    expect(first.comparisonKey).toBe(second.comparisonKey);
    expect(first.items.map((item) => item.metrics)).toEqual(
      second.items.map((item) => item.metrics)
    );
  });

  it("records different agent models for side-by-side comparison", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);

    const first = await runExperiment(baseConfig(outputDir, "agent-a"), dependencies());
    const second = await runExperiment(baseConfig(outputDir, "agent-b"), dependencies());

    expect(first.agentConfig.model).toBe("agent-a");
    expect(second.agentConfig.model).toBe("agent-b");
    expect(first.comparisonKey).not.toBe(second.comparisonKey);
    expect(first).toMatchObject({
      datasetName: "weather-golden",
      datasetVersion: "v1.0.0",
      judgeConfig: { temperature: 0, promptVersion: "judge-v1" },
      timestamp: "2026-08-11T00:00:00.000Z",
    });
  });

  it("reuses one pinned dataset for experiments with different models", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const loadDataset = createPinnedDatasetLoader(dataset);

    const first = await runExperiment(
      baseConfig(outputDir, "agent-a"),
      dependencies({ loadDataset })
    );
    const second = await runExperiment(
      baseConfig(outputDir, "agent-b"),
      dependencies({ loadDataset })
    );

    expect(first.datasetVersion).toBe("v1.0.0");
    expect(second.datasetVersion).toBe("v1.0.0");
    expect(first.agentConfig.model).not.toBe(second.agentConfig.model);
  });

  it("rejects a requested version that differs from the pinned dataset", async () => {
    const loadDataset = createPinnedDatasetLoader(dataset);

    await expect(loadDataset("v1.0.1")).rejects.toThrow(
      /Pinned dataset version v1\.0\.0 does not match v1\.0\.1/
    );
  });

  it("records FAILED, TIMEOUT, and max-item SKIPPED statuses without stopping", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const failingDataset: EvaluationDataset = {
      ...dataset,
      items: [
        ...dataset.items,
        { id: "third", input: { intent: "weather" } },
      ],
    };
    let call = 0;
    const result = await runExperiment(
      { ...baseConfig(outputDir), maxItems: 2, perItemTimeoutMs: 10 },
      dependencies({
        loadDataset: async () => failingDataset,
        runAgent: async () => {
          call += 1;
          if (call === 1) throw new Error("agent failed");
          return new Promise(() => undefined);
        },
      })
    );

    expect(result.items.map((item) => item.status)).toEqual([
      "FAILED",
      "TIMEOUT",
      "SKIPPED",
    ]);
    expect(result.items[0].metrics[0].value).toBe(0);
    expect(result.items[1].metrics[0].value).toBe(0);
  });

  it("writes structured offline JSON with experiment and metric evidence", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);

    const result = await runExperiment(baseConfig(outputDir), dependencies());
    const persisted = JSON.parse(await readFile(result.outputPath, "utf8"));

    expect(persisted).toMatchObject({
      localExperimentId: "experiment-test",
      experimentId: null,
      hostedStatus: "SKIPPED",
      hostedSkipReason: "disabled",
      datasetVersion: "v1.0.0",
      agentConfig: { model: "agent-a", provider: "qwen" },
      timestamp: "2026-08-11T00:00:00.000Z",
    });
    expect(persisted.items[0].metrics[0]).toMatchObject({
      name: "tool_call_correctness",
      value: 1,
      reason: "Tool call matches expected",
    });
  });

  it("persists the real hosted experiment identity returned by the publisher", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const publishHostedExperiment = vi.fn(async () => ({
      hostedStatus: "SUCCEEDED" as const,
      hostedExperimentId: "hosted-experiment-1",
      hostedExperimentUrl: "https://www.comet.com/opik/experiments/1",
      hostedDatasetId: "hosted-dataset-1",
      hostedDatasetVersionId: "hosted-version-1",
    }));

    const result = await runExperiment(
      baseConfig(outputDir),
      dependencies({ publishHostedExperiment })
    );
    const persisted = JSON.parse(await readFile(result.outputPath, "utf8"));

    expect(publishHostedExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        localExperimentId: "experiment-test",
        dataset,
        traceReferences: [],
      })
    );
    expect(result).toMatchObject({
      localExperimentId: "experiment-test",
      experimentId: "hosted-experiment-1",
      hostedStatus: "SUCCEEDED",
      hostedExperimentId: "hosted-experiment-1",
      hostedExperimentUrl: "https://www.comet.com/opik/experiments/1",
    });
    expect(persisted).toMatchObject({
      localExperimentId: "experiment-test",
      experimentId: "hosted-experiment-1",
      hostedStatus: "SUCCEEDED",
      hostedExperimentId: "hosted-experiment-1",
      hostedExperimentUrl: "https://www.comet.com/opik/experiments/1",
    });
  });

  it("writes local JSON with FAILED status when hosted publication throws", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runExperiment(
      baseConfig(outputDir),
      dependencies({
        publishHostedExperiment: async () => {
          throw new Error("hosted unavailable token=secret-value");
        },
      })
    );
    const persisted = JSON.parse(await readFile(result.outputPath, "utf8"));

    expect(result).toMatchObject({
      experimentId: null,
      hostedStatus: "FAILED",
      hostedError: {
        type: "Error",
        message: "hosted unavailable token=[redacted]",
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("secret-value");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"opik_hosted_experiment_failed"')
    );
  });

  it("links metric feedback and trace IDs to each successful item", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);
    const tracer = createNoopOpikTracer();
    const feedback: Array<{ traceId: string; name: string; value: number }> = [];
    let activeTraceId: string | undefined;
    tracer.traceAgentRun = async function traceAgentRunForTest<T>(
      _agentName: string,
      metadata: AgentRunMetadata,
      execution: () => Promise<T>
    ): Promise<T> {
      activeTraceId = `trace-${metadata.taskId}`;
      try {
        return await execution();
      } finally {
        activeTraceId = undefined;
      }
    };
    tracer.getActiveTraceId = () => activeTraceId;
    tracer.logFeedback = (name, value) => {
      if (activeTraceId) feedback.push({ traceId: activeTraceId, name, value });
    };
    const publishHostedExperiment = vi.fn(async () => ({
      hostedStatus: "SUCCEEDED" as const,
      hostedExperimentId: "hosted-experiment-1",
      hostedExperimentUrl: "https://www.comet.com/opik/experiments/1",
      hostedDatasetId: "hosted-dataset-1",
      hostedDatasetVersionId: "hosted-version-1",
    }));

    const result = await runExperiment(
      baseConfig(outputDir),
      dependencies({ tracer, publishHostedExperiment })
    );

    expect(result.traceIds).toEqual(["trace-tokyo", "trace-taipei"]);
    expect(publishHostedExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        traceReferences: [
          { caseId: "tokyo", traceId: "trace-tokyo" },
          { caseId: "taipei", traceId: "trace-taipei" },
        ],
      })
    );
    expect(feedback).toEqual([
      { traceId: "trace-tokyo", name: "tool_call_correctness", value: 1 },
      { traceId: "trace-taipei", name: "tool_call_correctness", value: 1 },
    ]);
  });

  it("marks remaining items SKIPPED after the cost cap is reached", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opik-eval-"));
    tempDirectories.push(outputDir);

    const result = await runExperiment(
      { ...baseConfig(outputDir), maxTotalCostUsd: 0.005 },
      dependencies()
    );

    expect(result.items.map((item) => item.status)).toEqual([
      "COMPLETED",
      "SKIPPED",
    ]);
  });
});

describe("default agent runner trusted identity", () => {
  const authenticatedAt = new Date("2026-11-09T00:00:00.000Z");
  const admittedTaskId = "admitted-task-1";

  function agentContext(threadId: string, itemId: string) {
    return {
      signal: new AbortController().signal,
      agentConfig: { model: "agent-a", provider: "qwen", promptVersion: "weather-v1" },
      threadId,
      runId: `${threadId}:${itemId}`,
      taskId: itemId,
    };
  }

  // The real graph entry and instrumentation around a stub graph, so the test exercises the same
  // identity resolution the deep-researcher graph uses without a database or model.
  function entryWrappedStubGraph() {
    const received: Array<{ configurable: Record<string, unknown> }> = [];
    const stub = {
      invoke: vi.fn(async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
        received.push(config);
        return { messages: [new AIMessage("Sunny in Tokyo")] };
      }),
      getState: vi.fn(async () => ({ values: {} })),
    };
    const admission = { admit: vi.fn(async () => admittedTaskId) };
    const graph = instrumentGraphWithExecutionContext(
      stub,
      createGraphEntryContextResolver(stub, admission),
    );
    return { graph, received, admission };
  }

  it("builds the trusted gateway fields the graph entry accepts for each item", () => {
    const build = experimentTestInternals.createEvaluationGraphConfigurable;
    const tokyo = build(agentContext("experiment-1", "tokyo"), authenticatedAt);
    const taipei = build(agentContext("experiment-1", "taipei"), authenticatedAt);

    expect(Object.keys(tokyo).sort()).toEqual([
      "thread_id",
      "run_id",
      "request_id",
      TRUSTED_PRINCIPAL_HEADERS.principalId,
      TRUSTED_PRINCIPAL_HEADERS.principalType,
      TRUSTED_PRINCIPAL_HEADERS.tenantId,
      TRUSTED_PRINCIPAL_HEADERS.roles,
      TRUSTED_PRINCIPAL_HEADERS.scopes,
      TRUSTED_PRINCIPAL_HEADERS.authSource,
      TRUSTED_PRINCIPAL_HEADERS.authenticatedAt,
      TRUSTED_SCOPE_FIELDS.scopeId,
      TRUSTED_SCOPE_FIELDS.scopeType,
    ].sort());
    expect(tokyo).toMatchObject({
      thread_id: "experiment-1",
      run_id: "experiment-1:tokyo",
      [TRUSTED_PRINCIPAL_HEADERS.principalType]: "user",
      [TRUSTED_PRINCIPAL_HEADERS.roles]: "",
      [TRUSTED_PRINCIPAL_HEADERS.scopes]: "",
      [TRUSTED_PRINCIPAL_HEADERS.authSource]: "trusted_gateway",
      [TRUSTED_PRINCIPAL_HEADERS.authenticatedAt]: authenticatedAt.toISOString(),
      [TRUSTED_SCOPE_FIELDS.scopeType]: "tenant",
    });
    expect(tokyo[TRUSTED_SCOPE_FIELDS.scopeId]).toBe(tokyo[TRUSTED_PRINCIPAL_HEADERS.tenantId]);
    expect(tokyo.request_id).not.toBe(taipei.request_id);
    expect(tokyo.run_id).not.toBe(taipei.run_id);
  });

  it("isolates the evaluation identity of different experiments", () => {
    const build = experimentTestInternals.createEvaluationGraphConfigurable;
    const first = build(agentContext("experiment-1", "tokyo"), authenticatedAt);
    const second = build(agentContext("experiment-2", "tokyo"), authenticatedAt);

    expect(first[TRUSTED_PRINCIPAL_HEADERS.principalId]).not.toBe(second[TRUSTED_PRINCIPAL_HEADERS.principalId]);
    expect(first[TRUSTED_PRINCIPAL_HEADERS.tenantId]).not.toBe(second[TRUSTED_PRINCIPAL_HEADERS.tenantId]);
    expect(first[TRUSTED_SCOPE_FIELDS.scopeId]).not.toBe(second[TRUSTED_SCOPE_FIELDS.scopeId]);
  });

  it("reaches the graph through the real entry with a canonical execution context", async () => {
    const { graph, received, admission } = entryWrappedStubGraph();
    const context = agentContext("experiment-1", "tokyo");
    const expected = experimentTestInternals.createEvaluationGraphConfigurable(context, authenticatedAt);

    const result = await experimentTestInternals.runDefaultAgent(dataset.items[0], context, graph);

    expect(result.response).toBe("Sunny in Tokyo");
    expect(admission.admit).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    const executionContext = executionContextSchema.parse(received[0].configurable.execution_context);
    expect(executionContext).toMatchObject({
      requestId: expected.request_id,
      threadId: "experiment-1",
      runId: "experiment-1:tokyo",
      taskId: admittedTaskId,
      principal: {
        principalId: expected[TRUSTED_PRINCIPAL_HEADERS.principalId],
        principalType: "user",
        tenantId: expected[TRUSTED_PRINCIPAL_HEADERS.tenantId],
        roles: [],
        scopes: [],
        authSource: "trusted_gateway",
      },
      scope: {
        scopeId: expected[TRUSTED_SCOPE_FIELDS.scopeId],
        scopeType: "tenant",
        tenantId: expected[TRUSTED_PRINCIPAL_HEADERS.tenantId],
      },
    });
  });

  it("keeps rejecting entry calls without trusted identity and ignores caller-supplied context", async () => {
    const { graph, received } = entryWrappedStubGraph();
    const callerContext = {
      requestId: "caller-request",
      threadId: "experiment-1",
      runId: "experiment-1:tokyo",
      taskId: "caller-task",
      attempt: 1,
      principal: {
        principalId: "caller-principal",
        principalType: "user",
        tenantId: "caller-tenant",
        roles: [],
        scopes: [],
        authSource: "trusted_gateway",
        authenticatedAt: authenticatedAt.toISOString(),
      },
      scope: { scopeId: "caller-tenant", scopeType: "tenant", tenantId: "caller-tenant" },
    };

    await expect(
      graph.invoke(
        { messages: [] },
        {
          configurable: {
            thread_id: "experiment-1",
            run_id: "experiment-1:tokyo",
            request_id: "request-1",
            execution_context: callerContext,
          },
        },
      ),
    ).rejects.toThrow();
    expect(received).toHaveLength(0);
  });
});
