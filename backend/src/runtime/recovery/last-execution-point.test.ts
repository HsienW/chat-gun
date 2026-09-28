import { describe, expect, it, vi } from "vitest";

import { hashBusinessEffectKey } from "../side-effect/identity.js";
import type { SideEffectReconciler } from "../side-effect/side-effect-descriptor.js";
import {
  classifyLastExecutionPoint,
  routeRecoveryContinuation,
} from "./last-execution-point.js";

const baseEvidence = {
  taskStatus: "running" as const,
  stepStatus: "running" as const,
  ledgerStatus: "executing" as const,
  checkpoint: { exists: true, hasPendingNodes: true, isTerminal: false },
};

describe("LastExecutionPointClassifier", () => {
  it.each([
    [
      "not_started",
      {
        taskStatus: "created",
        stepStatus: "pending",
        ledgerStatus: "none",
        checkpoint: { exists: false, hasPendingNodes: false, isTerminal: false },
      },
    ],
    ["executing", baseEvidence],
    ["committed", { ...baseEvidence, ledgerStatus: "committed" }],
    ["unknown", { ...baseEvidence, ledgerStatus: "unknown" }],
    [
      "terminal",
      {
        ...baseEvidence,
        taskStatus: "completed",
        checkpoint: { exists: true, hasPendingNodes: false, isTerminal: true },
      },
    ],
    [
      "waiting_user",
      { ...baseEvidence, manifestStatus: "waiting" },
    ],
  ] as const)("classifies %s from durable evidence", (expected, evidence) => {
    expect(classifyLastExecutionPoint(evidence)).toBe(expected);
  });

  it("does not use sanitizer diagnostics as committed/unknown evidence", () => {
    expect(
      classifyLastExecutionPoint({
        ...baseEvidence,
        ledgerStatus: "committed",
        sanitizeDiagnostic: {
          status: "sanitized",
          reasonCodes: ["PARTIAL_ASSISTANT_MESSAGE"],
        },
      })
    ).toBe("committed");
  });

  it("keeps committed mutation evidence authoritative over a waiting manifest", () => {
    expect(
      classifyLastExecutionPoint({
        ...baseEvidence,
        ledgerStatus: "committed",
        manifestStatus: "waiting",
      })
    ).toBe("committed");
  });
});

describe("recovery continuation routing", () => {
  const reconciliationInput = {
    toolExecutionId: "execution-1",
    businessEffectKey: hashBusinessEffectKey("tenant:write:1"),
  };

  it.each([
    ["committed", "committed", "commit"],
    ["unknown", "not_committed", "retry"],
    ["unknown", "unknown", "defer"],
  ] as const)(
    "routes %s mutation through reconciler result %s",
    async (classification, reconcilerState, expectedAction) => {
      const reconcile = vi.fn<SideEffectReconciler["reconcile"]>(async () => ({
        state: reconcilerState,
      }));

      await expect(
        routeRecoveryContinuation({
          classification,
          isMutation: true,
          reconciler: { reconcile },
          reconciliationInput,
          canRetry: true,
        })
      ).resolves.toMatchObject({ action: expectedAction });
      expect(reconcile).toHaveBeenCalledOnce();
    }
  );

  it("parks unknown mutation without a reconciler", async () => {
    await expect(
      routeRecoveryContinuation({
        classification: "unknown",
        isMutation: true,
        reconciliationInput,
        canRetry: true,
      })
    ).resolves.toEqual({
      action: "park",
      reasonCode: "RECONCILER_REQUIRED",
    });
  });

  it("keeps terminal state stopped and never calls reconciler", async () => {
    const reconcile = vi.fn<SideEffectReconciler["reconcile"]>();

    await expect(
      routeRecoveryContinuation({
        classification: "terminal",
        isMutation: true,
        reconciler: { reconcile },
        reconciliationInput,
        canRetry: true,
      })
    ).resolves.toEqual({ action: "stop", reasonCode: "TERMINAL_STATE" });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
