import { describe, expect, it } from "vitest";

import { parseRuntimeEventEnvelope } from "./event-envelope.js";
import { parseKey, serializeKey } from "./idempotency/idempotency-key.js";
import { parseDurableInterruptManifest } from "./recovery/interrupt-manifest.js";

const legacyEventEnvelope = {
  schemaVersion: "1.0.0",
  eventId: "event-legacy-1",
  sequence: 7,
  type: "task.completed",
  emittedAt: "2026-09-27T00:00:00.000Z",
  context: {
    requestId: "request-1",
    threadId: "thread-1",
    runId: "run-1",
    taskId: "task-1",
    attempt: 1,
    principalId: "principal-1",
    tenantId: "tenant-1",
    scopeId: "scope-1",
    scopeType: "tenant",
  },
  payload: { taskId: "task-1", status: "completed" },
} as const;

const legacyInterruptManifest = {
  interruptId: "interrupt-1",
  runId: "run-1",
  threadId: "thread-1",
  taskId: "task-1",
  scopeId: "scope-1",
  expectedResponseSchemaRef: "approval-v1",
  expiryAt: "2026-10-05T00:00:00.000Z",
  executionManifest: {
    manifestVersion: "1.0",
    graphId: "chatbot",
    graphConfigHash: "a".repeat(64),
    schemaVersions: {
      runtimeEventEnvelope: "1.0.0",
      toolDescriptor: "1.0",
      authorizationPolicy: "1.0",
      normalizedInput: "1.0",
    },
  },
  status: "waiting",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  kind: "clarification",
} as const;

describe("gun-harness extraction rollback compatibility", () => {
  it("reads the previous local event envelope without changing its serialized shape", () => {
    expect(parseRuntimeEventEnvelope(legacyEventEnvelope)).toEqual(legacyEventEnvelope);
  });

  it("reads the previous local checkpoint/resume manifest", () => {
    expect(parseDurableInterruptManifest(legacyInterruptManifest)).toEqual(legacyInterruptManifest);
  });

  it("round-trips the previous local idempotency serialization", () => {
    const serialized = "tool:tenant-1:task-1:v1";
    expect(serializeKey(parseKey(serialized))).toBe(serialized);
  });
});
