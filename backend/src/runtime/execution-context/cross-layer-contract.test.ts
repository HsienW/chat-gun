import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { executionContextSchema } from "./execution-context.js";
import { readExecutionCorrelation, readExecutionContext } from "./read-execution-context.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as {
  validContext: Record<string, unknown>;
  legacyConfig: Record<string, unknown>;
  malformedRequestId: string;
  oversizedIdLength: number;
  unknownField: string;
  concurrentRunIds: string[];
};

describe("shared execution context contract", () => {
  it("maps legacy header and config aliases from the shared fixture", () => {
    expect(readExecutionCorrelation(fixture.legacyConfig)).toMatchObject({
      requestId: fixture.validContext.requestId,
      threadId: fixture.validContext.threadId,
      runId: fixture.validContext.runId,
      taskId: fixture.validContext.taskId,
      stepId: fixture.validContext.stepId,
    });
  });

  it("rejects shared malformed, oversized, and unknown fields", () => {
    expect(() => readExecutionCorrelation({
      configurable: { "x-request-id": fixture.malformedRequestId },
    })).toThrow();
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      requestId: fixture.malformedRequestId,
    }).success).toBe(false);
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      requestId: "x".repeat(fixture.oversizedIdLength),
    }).success).toBe(false);
    expect(executionContextSchema.safeParse({
      ...fixture.validContext,
      [fixture.unknownField]: "typo",
    }).success).toBe(false);
  });

  it("isolates concurrent runs with no shared mutable correlation", async () => {
    const contexts = await Promise.all(fixture.concurrentRunIds.map(async (runId) =>
      readExecutionContext(null, {
        configurable: {
          execution_context: { ...fixture.validContext, runId },
        },
      })
    ));
    expect(contexts.map((context) => context.runId)).toEqual(fixture.concurrentRunIds);
    expect(contexts[0]).not.toBe(contexts[1]);
  });
});
