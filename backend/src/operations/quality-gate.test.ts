import { describe, expect, it } from "vitest";

import {
  decideGoalProgress,
  evaluateCompletionGate,
  type CompletionGateInput,
  type CompletionGatePolicyBundle,
} from "./quality-gate.js";

const POLICY_REF = {
  policyId: "completion-policy",
  version: "1",
  digest: "sha256:policy",
};
const CONFIG_REF = { version: "1", digest: "sha256:state-check" };
const EVALUATED_AT = "2026-09-14T00:00:00.000Z";
const EVALUATION_POLICY = {
  datasetId: "dataset-1",
  datasetVersion: "1",
  evaluatorId: "evaluator-1",
  evaluatorVersion: "1",
  threshold: 0.8,
  maxJudgeCalls: 1,
  timeoutMs: 1_000,
};

function createInput(
  overrides: Partial<CompletionGateInput> = {}
): CompletionGateInput {
  return {
    policyRef: POLICY_REF,
    goal: { goalId: "goal-1", status: "active" },
    candidate: { answer: 42 },
    facts: {},
    deterministicChecks: [
      {
        checkId: "terminal-state",
        kind: "state_invariant",
        required: true,
        configRef: CONFIG_REF,
      },
    ],
    ...overrides,
  };
}

function createPolicy(
  overrides: Partial<CompletionGatePolicyBundle> = {}
): CompletionGatePolicyBundle {
  return {
    policyRef: POLICY_REF,
    checks: {
      "terminal-state": {
        kind: "state_invariant",
        configRef: CONFIG_REF,
      },
    },
    requiresEvaluation: false,
    evaluation: EVALUATION_POLICY,
    ...overrides,
  };
}

describe("completion quality gate", () => {
  it("passes a required deterministic state invariant and completes the goal", () => {
    const result = evaluateCompletionGate(
      createInput(),
      createPolicy(),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "passed",
      checks: [
        {
          checkId: "terminal-state",
          passed: true,
          reasonCode: "STATE_INVARIANT_SATISFIED",
        },
      ],
    });
    expect(decideGoalProgress(result, false)).toBe("complete");
  });

  it("does not let evaluation override a deterministic failure", () => {
    const result = evaluateCompletionGate(
      createInput({
        goal: { goalId: "goal-1", status: "budget_exhausted" },
        evaluation: {
          datasetId: "dataset-1",
          datasetVersion: "1",
          evaluatorId: "evaluator-1",
          evaluatorVersion: "1",
          normalizedScore: 1,
          threshold: 0.8,
          maxJudgeCalls: 1,
          timeoutMs: 1_000,
        },
      }),
      createPolicy({ requiresEvaluation: true }),
      EVALUATED_AT
    );

    expect(result.status).toBe("failed");
    expect("evaluation" in result).toBe(false);
    expect(decideGoalProgress(result, false)).toBe("continue");
  });

  it("fails closed when bounded evaluation is below its threshold", () => {
    const result = evaluateCompletionGate(
      createInput({
        evaluation: {
          datasetId: "dataset-1",
          datasetVersion: "1",
          evaluatorId: "evaluator-1",
          evaluatorVersion: "1",
          normalizedScore: 0.6,
          threshold: 0.8,
          maxJudgeCalls: 1,
          timeoutMs: 1_000,
        },
      }),
      createPolicy({ requiresEvaluation: true }),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "failed",
      evaluation: {
        passed: false,
        normalizedScore: 0.6,
        threshold: 0.8,
      },
    });
  });

  it("returns invalid_policy when no deterministic check is configured", () => {
    const result = evaluateCompletionGate(
      createInput({ deterministicChecks: [] }),
      createPolicy({ checks: {} }),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "invalid_policy",
      reasonCode: "DETERMINISTIC_CHECK_REQUIRED",
    });
    expect(decideGoalProgress(result, true)).toBe("budget_exhausted");
  });

  it("fails closed when input omits a check required by the policy", () => {
    const result = evaluateCompletionGate(
      createInput(),
      createPolicy({
        checks: {
          "terminal-state": {
            kind: "state_invariant",
            configRef: CONFIG_REF,
          },
          "required-effects": {
            kind: "side_effect_invariant",
            configRef: { version: "1", digest: "sha256:effects" },
          },
        },
      }),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "invalid_policy",
      reasonCode: "POLICY_CHECK_SET_MISMATCH",
    });
  });

  it("fails closed when required evaluation bounds are absent from policy", () => {
    const result = evaluateCompletionGate(
      createInput({
        evaluation: {
          datasetId: "dataset-1",
          datasetVersion: "1",
          evaluatorId: "evaluator-1",
          evaluatorVersion: "1",
          normalizedScore: 1,
          threshold: 0,
          maxJudgeCalls: 1,
          timeoutMs: 1_000,
        },
      }),
      createPolicy({
        requiresEvaluation: true,
        evaluation: undefined,
      }),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "invalid_policy",
      reasonCode: "POLICY_SCHEMA_INVALID",
    });
  });

  it("rejects evaluation bounds that differ from the versioned policy", () => {
    const result = evaluateCompletionGate(
      createInput({
        evaluation: {
          ...EVALUATION_POLICY,
          normalizedScore: 1,
          threshold: 0,
        },
      }),
      createPolicy({ requiresEvaluation: true }),
      EVALUATED_AT
    );

    expect(result).toMatchObject({
      status: "invalid_policy",
      reasonCode: "EVALUATION_CONFIGURATION_MISMATCH",
    });
  });

  it("evaluates every supported deterministic check kind from versioned data", () => {
    const checkDefinitions = [
      { checkId: "schema", kind: "schema_conformance" as const },
      { checkId: "value", kind: "expected_value" as const },
      { checkId: "evidence", kind: "required_evidence" as const },
      { checkId: "state", kind: "state_invariant" as const },
      { checkId: "effects", kind: "side_effect_invariant" as const },
      { checkId: "recovery", kind: "recovery_bound" as const },
    ].map((check) => ({
      ...check,
      required: true as const,
      configRef: { version: "1", digest: `sha256:${check.checkId}` },
    }));
    const input = createInput({
      deterministicChecks: checkDefinitions,
      facts: {
        candidateSchema: {
          passed: true,
          schemaVersion: "candidate/v1",
          schemaDigest: "sha256:candidate-schema",
        },
        evidence: {
          audit: {
            exists: true,
            parseable: true,
            version: "1",
            digest: "sha256:audit",
          },
        },
        sideEffectLedger: {
          duplicateEffectCount: 0,
          unknownEffectCount: 1,
          reconciledUnknownEffectCount: 1,
        },
        recovery: {
          resumeCount: 1,
          retryCount: 1,
          drainElapsedMs: 100,
        },
      },
    });
    const policy = createPolicy({
      checks: {
        schema: {
          kind: "schema_conformance",
          configRef: { version: "1", digest: "sha256:schema" },
          factKey: "candidateSchema",
          expectedSchemaVersion: "candidate/v1",
          expectedSchemaDigest: "sha256:candidate-schema",
        },
        value: {
          kind: "expected_value",
          configRef: { version: "1", digest: "sha256:value" },
          source: "candidate",
          pointer: "/answer",
          operator: "equals",
          expectedValue: 42,
        },
        evidence: {
          kind: "required_evidence",
          configRef: { version: "1", digest: "sha256:evidence" },
          evidenceKey: "audit",
          expectedVersion: "1",
          expectedDigest: "sha256:audit",
        },
        state: {
          kind: "state_invariant",
          configRef: { version: "1", digest: "sha256:state" },
        },
        effects: {
          kind: "side_effect_invariant",
          configRef: { version: "1", digest: "sha256:effects" },
        },
        recovery: {
          kind: "recovery_bound",
          configRef: { version: "1", digest: "sha256:recovery" },
          maxResumeCount: 1,
          maxRetryCount: 1,
          maxDrainElapsedMs: 100,
        },
      },
    });

    const result = evaluateCompletionGate(input, policy, EVALUATED_AT);

    expect(result.status).toBe("passed");
    expect("checks" in result && result.checks).toHaveLength(6);
  });
});
