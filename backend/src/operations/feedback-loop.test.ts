import { describe, expect, it } from "vitest";

import {
  addBadTraceRegressionCase,
  compareVersionPinnedExperiments,
  createRedactedRegressionCase,
} from "./feedback-loop.js";

const BAD_TRACE = {
  schemaVersion: "bad-trace/v1",
  traceId: "trace-sensitive-1",
  failureType: "unsafe_tool_replay",
  input: {
    scenario: "resume after unknown effect",
    locale: "zh-TW",
    rawPrompt: "must not survive",
    credential: "secret-value",
  },
  expectedOutput: {
    status: "reconciliation_required",
    code: "EFFECT_UNKNOWN",
  },
  runtimeBuildId: "build-1",
};
const POLICY = {
  policyVersion: "redaction-v1",
  datasetName: "runtime-bad-trace-regression",
  datasetVersion: "v1.0.0",
  caseId: "unknown-effect-reconciliation",
  allowedInputFields: ["scenario", "locale"],
};

describe("trace feedback loop", () => {
  it("redacts and minimizes a bad trace into the X8.5A item format", () => {
    const regressionCase = createRedactedRegressionCase(
      BAD_TRACE,
      POLICY
    );
    const serialized = JSON.stringify(regressionCase);

    expect(regressionCase).toMatchObject({
      id: "unknown-effect-reconciliation",
      input: {
        scenario: "resume after unknown effect",
        locale: "zh-TW",
      },
      expectedOutput: {
        status: "reconciliation_required",
        code: "EFFECT_UNKNOWN",
      },
      metadata: {
        source: "redacted_bad_trace",
        failureType: "unsafe_tool_replay",
        datasetVersion: "v1.0.0",
        redactionPolicyVersion: "redaction-v1",
        sourceTraceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(serialized).not.toContain("trace-sensitive-1");
    expect(serialized).not.toContain("must not survive");
    expect(serialized).not.toContain("secret-value");
  });

  it("adds the regression case to a version-pinned X8.5A dataset", () => {
    const dataset = addBadTraceRegressionCase(
      {
        name: "runtime-bad-trace-regression",
        version: "v1.0.0",
        items: [],
      },
      BAD_TRACE,
      POLICY
    );

    expect(dataset).toMatchObject({
      name: "runtime-bad-trace-regression",
      version: "v1.0.0",
      items: [{ id: "unknown-effect-reconciliation" }],
    });
  });

  it("compares before and after only for the same pinned dataset version", () => {
    const comparison = compareVersionPinnedExperiments(
      {
        datasetName: "runtime-bad-trace-regression",
        datasetVersion: "v1.0.0",
        metrics: { deterministic_pass_rate: 0, duplicate_effect_rate: 1 },
      },
      {
        datasetName: "runtime-bad-trace-regression",
        datasetVersion: "v1.0.0",
        metrics: { deterministic_pass_rate: 1, duplicate_effect_rate: 0 },
      }
    );

    expect(comparison).toEqual({
      datasetName: "runtime-bad-trace-regression",
      datasetVersion: "v1.0.0",
      deltas: {
        deterministic_pass_rate: 1,
        duplicate_effect_rate: -1,
      },
    });
    expect(() =>
      compareVersionPinnedExperiments(
        {
          datasetName: "runtime-bad-trace-regression",
          datasetVersion: "v1.0.0",
          metrics: {},
        },
        {
          datasetName: "runtime-bad-trace-regression",
          datasetVersion: "v1.0.1",
          metrics: {},
        }
      )
    ).toThrow("FEEDBACK_DATASET_VERSION_MISMATCH");
  });
});
