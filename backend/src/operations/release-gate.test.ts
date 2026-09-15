import { describe, expect, it } from "vitest";

import {
  evaluateReleaseGate,
  type ReleaseGateReport,
} from "./release-gate.js";

function createPassingReport(): ReleaseGateReport {
  return {
    schemaVersion: "release-gate-report/v1",
    reportVersion: "2026-09-14.1",
    policyRef: {
      policyId: "runtime-release",
      version: "1",
      digest: "sha256:policy",
    },
    dataset: { name: "runtime-regression", version: "v1.0.0" },
    checks: {
      deterministicRegression: { passed: true },
      businessConstraint: { regressionCount: 0 },
      duplicateSideEffect: { regressionCount: 0 },
      recovery: { withinBounds: true },
      costLatency: { withinTolerance: true },
      manifest: { compatibility: "compatible" },
    },
    hardNegativeCases: [
      { caseId: "unsafe-replay-after-unknown-effect", passed: true },
    ],
  };
}

describe("evaluation release gate", () => {
  it("passes only when every version-pinned gate condition passes", () => {
    expect(evaluateReleaseGate(createPassingReport())).toEqual({
      status: "passed",
      reportVersion: "2026-09-14.1",
      datasetVersion: "v1.0.0",
      failureReasonCodes: [],
    });
  });

  it("fails for deliberate Hard Negative and duplicate side-effect regressions", () => {
    const report = createPassingReport();
    report.checks.duplicateSideEffect.regressionCount = 1;
    report.hardNegativeCases[0] = {
      caseId: "unsafe-replay-after-unknown-effect",
      passed: false,
    };

    expect(evaluateReleaseGate(report)).toEqual({
      status: "failed",
      reportVersion: "2026-09-14.1",
      datasetVersion: "v1.0.0",
      failureReasonCodes: [
        "DUPLICATE_SIDE_EFFECT_REGRESSION",
        "HARD_NEGATIVE_REGRESSION",
      ],
    });
  });

  it("fails closed for an unversioned or malformed report", () => {
    expect(
      evaluateReleaseGate({
        ...createPassingReport(),
        dataset: { name: "runtime-regression", version: "" },
      })
    ).toMatchObject({
      status: "invalid_report",
      failureReasonCodes: ["RELEASE_GATE_REPORT_INVALID"],
    });
  });
});
