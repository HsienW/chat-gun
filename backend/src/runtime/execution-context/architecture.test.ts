import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const correlationKey = "(?:requestId|request_id|threadId|thread_id|runId|run_id|taskId|task_id|stepId|step_id|toolCallId|tool_call_id)";
const directConfigRead = new RegExp(
  `\\b(?:config|configurable|runnableConfig)\\s*(?:\\.\\s*|\\[\\s*[\"'])(?:${correlationKey})\\b`
);
const legacyArrayRead = new RegExp(
  `\\breadString\\s*\\(\\s*records\\s*,\\s*\\[\\s*[\"'](?:${correlationKey})\\b`
);

const consumers = [
  "../../platform/interaction-runtime.ts",
  "../../platform/tool-governance.ts",
  "../../platform/tracing/opik/opik-graph.ts",
  "../../agents/deep-researcher.ts",
  "../../platform/metrics/instrumentation.ts",
  "../../platform/errors.ts",
  "../side-effect/tool-execution-runner.ts",
  "../interaction/events.ts",
];

describe("execution context architecture", () => {
  it("detects a direct raw config correlation read", () => {
    expect(directConfigRead.test("config.configurable.run_id")).toBe(true);
    expect(legacyArrayRead.test('readString(records, ["run_id"])')).toBe(true);
  });

  it.each(consumers)("keeps correlation mapping inside the adapter: %s", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).not.toMatch(directConfigRead);
    expect(source).not.toMatch(legacyArrayRead);
  });
});
