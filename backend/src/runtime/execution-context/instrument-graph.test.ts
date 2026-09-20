import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { applyInteractionGovernance } from "../../platform/interaction-runtime.js";
import { instrumentGraphWithOpik } from "../../platform/tracing/opik/opik-graph.js";
import { createNoopOpikTracer } from "../../platform/tracing/opik/opik-tracer.js";

import { instrumentGraphWithExecutionContext } from "./instrument-graph.js";
import { readDevelopmentExecutionContext, readExecutionContext } from "./read-execution-context.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as {
  legacyConfig: { runId: string; configurable: Record<string, unknown> };
  concurrentRunIds: string[];
};

const graph = {
  async invoke(_input: unknown, config: unknown) { return config; },
  async *stream(_input: unknown, config: unknown) { yield config; },
};

describe("execution context graph entry", () => {
  it("injects a validated, serializable context into invoke and stream configs", async () => {
    const wrapped = instrumentGraphWithExecutionContext(graph,
      (input, config) => readExecutionContext(input, config, "development")
    );
    const invoked = await wrapped.invoke({}, fixture.legacyConfig);
    expect(invoked).toMatchObject({
      configurable: { execution_context: {
        requestId: "request-1",
        threadId: "thread-1",
        runId: "run-1",
        taskId: "task-1",
        principal: { authSource: "development" },
      } },
    });
    const chunks = [];
    for await (const chunk of wrapped.stream({}, fixture.legacyConfig)) chunks.push(chunk);
    expect(chunks[0]).toMatchObject({
      configurable: { execution_context: { runId: "run-1" } },
    });
    expect(JSON.stringify(invoked)).not.toContain("AbortSignal");
  });

  it("keeps concurrent run configs isolated", async () => {
    const wrapped = instrumentGraphWithExecutionContext(graph,
      (input, config) => readExecutionContext(input, config, "development")
    );
    const outputs = await Promise.all(fixture.concurrentRunIds.map((runId) =>
      wrapped.invoke({}, { ...fixture.legacyConfig, runId, configurable: {
        ...fixture.legacyConfig.configurable,
        run_id: runId,
      } })
    ));
    expect(outputs.map((output) => readExecutionContext(null, output).runId))
      .toEqual(fixture.concurrentRunIds);
    expect(outputs[0]).not.toBe(outputs[1]);
  });

  it("leaves the legacy path unchanged when the resolver is disabled", async () => {
    const wrapped = instrumentGraphWithExecutionContext(graph, () => undefined);
    const output = await wrapped.invoke({}, fixture.legacyConfig);
    expect(output).toBe(fixture.legacyConfig);
  });

  it("discards forged identity and canonical context at the development entry", async () => {
    const wrapped = instrumentGraphWithExecutionContext(graph, readDevelopmentExecutionContext);
    const output = await wrapped.invoke({}, {
      ...fixture.legacyConfig,
      configurable: {
        ...fixture.legacyConfig.configurable,
        execution_context: {
          principal: { principalId: "forged-admin" },
        },
        "x-bff-principal-id": "forged-admin",
      },
    });
    const context = readExecutionContext(null, output);
    expect(context.principal).toMatchObject({
      principalId: "anonymous",
      authSource: "development",
    });
    expect(output).toMatchObject({ configurable: {
      execution_context: expect.anything(),
    } });
    expect(JSON.stringify(output)).not.toContain("forged-admin");
  });

  it("passes canonical config to both governance and tracing wrappers", async () => {
    const beforeRun = vi.fn(async () => ({ configured: true, events: [] }));
    const tracer = createNoopOpikTracer();
    const tracedMetadata = vi.fn();
    tracer.traceAgentRun = async (_name, metadata, execute) => {
      tracedMetadata(metadata);
      return execute();
    };
    const wrapped = instrumentGraphWithExecutionContext(
      applyInteractionGovernance(
        instrumentGraphWithOpik(graph, "test", tracer),
        { isConfigured: true, beforeRun, afterRun: async () => undefined }
      ),
      readDevelopmentExecutionContext
    );

    await wrapped.invoke({}, fixture.legacyConfig);
    expect(beforeRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      configurable: expect.objectContaining({ execution_context: expect.anything() }),
    }));
    expect(tracedMetadata).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1",
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
    }));
  });
});
