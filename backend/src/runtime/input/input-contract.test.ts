import { describe, expect, it } from "vitest";

import inputFixture from "../../../../contracts/input-normalization.fixture.json" with { type: "json" };
import queryGuardFixture from "../../../../contracts/query-guard.fixture.json" with { type: "json" };
import { createInteractionTaskEvent } from "../interaction/events.js";
import {
  NORMALIZED_AGENT_INPUT_KINDS,
  parseNormalizedAgentInput,
} from "./normalized-agent-input.js";
import { readNormalizedAgentInput } from "./read-normalized-agent-input.js";

describe("normalized input cross-layer contract", () => {
  it("keeps known kinds and normalization aligned with the shared fixture", () => {
    expect(NORMALIZED_AGENT_INPUT_KINDS).toEqual(inputFixture.knownKinds);
    expect(parseNormalizedAgentInput(inputFixture.prompt.raw)).toEqual({
      ok: true,
      input: inputFixture.prompt.normalized,
    });
    expect(parseNormalizedAgentInput(inputFixture.unknown)).toMatchObject({
      ok: false,
      errorCode: inputFixture.unknown.errorCode,
    });
  });

  it("preserves one interrupt id from requested event through resume adapter", () => {
    const event = createInteractionTaskEvent({
      eventType: "clarification_requested",
      threadId: "thread-1",
      priorTaskId: "task-1",
      priorRunId: "run-1",
      replacementTaskId: null,
      replacementRunId: null,
      generation: 1,
      interruptId: inputFixture.clarification.interruptId,
      input: { digest: "a".repeat(64), byteLength: 1 },
      sideEffectState: "read_only",
      compensationResult: null,
      reconciliationResult: null,
    });
    const resume = readNormalizedAgentInput(
      {
        command: inputFixture.clarification.resumeTransport.command,
        interruptId: inputFixture.clarification.interruptId,
      },
      inputFixture.clarification.resumeTransport.config,
    );

    expect(event.payload.interruptId).toBe(
      inputFixture.clarification.requestedEvent.interruptId,
    );
    expect(resume).toMatchObject({
      status: "valid",
      input: inputFixture.clarification.normalized,
    });
  });

  it("documents generation-aware cleanup invariants", () => {
    expect(queryGuardFixture.transitions).toEqual([
      "idle",
      "dispatching",
      "running",
    ]);
    expect(queryGuardFixture.staleGeneration).toBeLessThan(
      queryGuardFixture.currentGeneration,
    );
    expect(queryGuardFixture.rejectCleanupOrder).toEqual([
      "markTerminal",
      "terminalEvent",
    ]);
    expect(queryGuardFixture.staleReleaseOutcome).toBe("no_op");
  });
});
