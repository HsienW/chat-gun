import { describe, expect, it } from "vitest";

import { ContextPriority } from "./context-budget.js";
import {
  priorityForSource,
  toContextItem,
} from "./context-source.js";

describe("context source contract", () => {
  it.each([
    ["system_policy", ContextPriority.P0],
    ["current_task", ContextPriority.P1],
    ["active_state", ContextPriority.P2],
    ["memory", ContextPriority.P3],
    ["recent_messages", ContextPriority.P4],
    ["tool_output", ContextPriority.P5],
  ] as const)("maps %s to its stable priority", (source, priority) => {
    expect(priorityForSource(source)).toBe(priority);
  });

  it("rejects an unknown source at runtime", () => {
    expect(() => priorityForSource("unknown" as never)).toThrowError(
      /unknown context source/i
    );
  });

  it("validates external sections without any type assertions", () => {
    expect(
      toContextItem({
        source: "current_task",
        content: "current request",
        referenceId: "turn-7",
      })
    ).toEqual({
      priority: ContextPriority.P1,
      label: "current_task",
      content: "current request",
      referenceId: "turn-7",
      source: "current_task",
    });
    expect(() => toContextItem({ source: "current_task", content: 7 })).toThrow();
  });
});
