import { describe, expect, it } from "vitest";

import { createIncidentProjectionIndex } from "./incident-query.js";

const PROJECTION = {
  schemaVersion: "1.0" as const,
  runId: "run-1",
  events: [
    {
      eventId: "event-1",
      sequence: 1,
      type: "run.execution",
      emittedAt: "2026-09-28T12:00:00.000Z",
      taskId: "task-1",
      stepId: "step-1",
      toolCallId: "tool-call-1",
    },
  ],
  audit: [{ reference: "audit:run-1" }],
  traces: [{ reference: "trace:run-1" }],
  toolExecutions: [{ toolName: "safe_tool", outcome: "succeeded" }],
  terminalResult: { status: "completed" },
};

describe("incident projection index", () => {
  it("queries the redacted execution chain by canonical runId", () => {
    const index = createIncidentProjectionIndex();
    index.record(PROJECTION);
    expect(index.query("run-1")).toEqual(PROJECTION);
  });

  it("rejects unbounded or sensitive fields", () => {
    const index = createIncidentProjectionIndex();
    expect(() =>
      index.record({ ...PROJECTION, credential: "must-not-store" })
    ).toThrow();
  });

  it("rejects non-canonical run identifiers", () => {
    const index = createIncidentProjectionIndex();
    expect(() => index.query("run id with spaces")).toThrow();
  });
});
