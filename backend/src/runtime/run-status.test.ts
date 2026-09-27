import { describe, expect, it } from "vitest";

import {
  RUN_TERMINAL_STATUSES,
  isRunTerminalStatus,
  runStatusOf,
  runStatusReasonOf,
  transitionRunStatus,
} from "./run-status.js";
import { TASK_STATUSES, type TaskStatus } from "./types.js";

const expectedStatuses: Record<TaskStatus, string> = {
  created: "running",
  running: "running",
  waiting_confirmation: "needs_user",
  completed: "completed",
  partially_failed: "running",
  compensating: "running",
  failed: "failed",
  cancelled: "cancelled",
  cancelling: "running",
  superseded: "superseded",
  rollback_requested: "running",
  cancelled_after_commit: "cancelled",
  manual_intervention_required: "manual_intervention_required",
};

describe("runStatusOf", () => {
  it("maps every declared TaskStatus to an explicit RunStatus", () => {
    expect(TASK_STATUSES).toHaveLength(13);
    expect(Object.fromEntries(TASK_STATUSES.map((status) => [status, runStatusOf(status)])))
      .toEqual(expectedStatuses);
  });

  it("preserves cancelled_after_commit as a stable reason code", () => {
    expect(runStatusOf("cancelled_after_commit")).toBe("cancelled");
    expect(runStatusReasonOf("cancelled_after_commit")).toBe(
      "cancelled_after_commit"
    );
  });

  it("defines all seven hard terminal statuses including direct run failures", () => {
    expect(RUN_TERMINAL_STATUSES).toEqual([
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "crashed",
      "budget_exhausted",
      "superseded",
    ]);
    expect(RUN_TERMINAL_STATUSES.every(isRunTerminalStatus)).toBe(true);
  });
});

describe("transitionRunStatus", () => {
  it.each(["needs_user", "manual_intervention_required"] as const)(
    "allows %s to resume running",
    (status) => {
      expect(transitionRunStatus(status, "running")).toEqual({
        accepted: true,
        status: "running",
      });
    }
  );

  it.each(RUN_TERMINAL_STATUSES)(
    "rejects late progress after hard terminal %s with an observable reason",
    (status) => {
      expect(transitionRunStatus(status, "running")).toEqual({
        accepted: false,
        status,
        reasonCode: "RUN_TERMINAL_MONOTONICITY",
      });
    }
  );
});
