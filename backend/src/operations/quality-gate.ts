import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { TASK_GOAL_STATUSES } from "./types.js";

const CHECK_KINDS = [
  "schema_conformance",
  "expected_value",
  "required_evidence",
  "state_invariant",
  "side_effect_invariant",
  "recovery_bound",
] as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const referenceSchema = z
  .object({
    version: nonEmptyStringSchema,
    digest: nonEmptyStringSchema,
  })
  .strict();
const policyReferenceSchema = referenceSchema
  .extend({ policyId: nonEmptyStringSchema })
  .strict();
const evaluationSchema = z
  .object({
    datasetId: nonEmptyStringSchema,
    datasetVersion: nonEmptyStringSchema,
    evaluatorId: nonEmptyStringSchema,
    evaluatorVersion: nonEmptyStringSchema,
    normalizedScore: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0).max(1),
    maxJudgeCalls: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
const evaluationPolicySchema = evaluationSchema.omit({
  normalizedScore: true,
});

const deterministicCheckSchema = z
  .object({
    checkId: nonEmptyStringSchema,
    kind: z.enum(CHECK_KINDS),
    required: z.literal(true),
    configRef: referenceSchema,
  })
  .strict();

const checkConfigurationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("schema_conformance"),
      configRef: referenceSchema,
      factKey: nonEmptyStringSchema,
      expectedSchemaVersion: nonEmptyStringSchema,
      expectedSchemaDigest: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("expected_value"),
      configRef: referenceSchema,
      source: z.enum(["candidate", "facts"]),
      pointer: z.string(),
      operator: z.enum(["equals", "member_of", "numeric_range"]),
      expectedValue: z.unknown().optional(),
      allowedValues: z.array(z.unknown()).optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("required_evidence"),
      configRef: referenceSchema,
      evidenceKey: nonEmptyStringSchema,
      expectedVersion: nonEmptyStringSchema,
      expectedDigest: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("state_invariant"),
      configRef: referenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("side_effect_invariant"),
      configRef: referenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery_bound"),
      configRef: referenceSchema,
      maxResumeCount: z.number().int().nonnegative(),
      maxRetryCount: z.number().int().nonnegative(),
      maxDrainElapsedMs: z.number().finite().nonnegative(),
    })
    .strict(),
]);

const completionGateInputSchema = z
  .object({
    policyRef: policyReferenceSchema,
    goal: z
      .object({
        goalId: nonEmptyStringSchema,
        status: z.enum(TASK_GOAL_STATUSES),
      })
      .strict(),
    candidate: z.unknown(),
    facts: z.record(z.unknown()),
    deterministicChecks: z.array(deterministicCheckSchema),
    evaluation: evaluationSchema.optional(),
  })
  .strict();

const policyBundleSchema = z
  .object({
    policyRef: policyReferenceSchema,
    checks: z.record(checkConfigurationSchema),
    requiresEvaluation: z.boolean(),
    evaluation: evaluationPolicySchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.requiresEvaluation && !policy.evaluation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluation"],
        message: "required evaluation policy is missing",
      });
    }
  });

const evaluatedAtSchema = z.string().datetime({ offset: true });
const schemaFactSchema = z
  .object({
    passed: z.boolean(),
    schemaVersion: nonEmptyStringSchema,
    schemaDigest: nonEmptyStringSchema,
  })
  .strict();
const evidenceFactSchema = z
  .object({
    exists: z.boolean(),
    parseable: z.boolean(),
    version: nonEmptyStringSchema,
    digest: nonEmptyStringSchema,
  })
  .strict();
const sideEffectFactSchema = z
  .object({
    duplicateEffectCount: z.number().int().nonnegative(),
    unknownEffectCount: z.number().int().nonnegative(),
    reconciledUnknownEffectCount: z.number().int().nonnegative(),
  })
  .strict();
const recoveryFactSchema = z
  .object({
    resumeCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    drainElapsedMs: z.number().finite().nonnegative(),
  })
  .strict();

export type CompletionGateInput = z.infer<typeof completionGateInputSchema>;
export type CompletionGatePolicyBundle = z.infer<typeof policyBundleSchema>;
type CheckConfiguration = z.infer<typeof checkConfigurationSchema>;

export type CompletionGateResult =
  | {
      status: "passed" | "failed";
      policyRef: CompletionGateInput["policyRef"];
      checks: Array<{
        checkId: string;
        passed: boolean;
        reasonCode: string;
      }>;
      evaluation?: {
        passed: boolean;
        normalizedScore: number;
        threshold: number;
      };
      evaluatedAt: string;
    }
  | {
      status: "invalid_policy";
      policyRef: CompletionGateInput["policyRef"];
      reasonCode: string;
      evaluatedAt: string;
    };

function referencesMatch(
  left: { version: string; digest: string },
  right: { version: string; digest: string }
): boolean {
  return left.version === right.version && left.digest === right.digest;
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, segment) => {
      if (
        current === null ||
        typeof current !== "object" ||
        !(segment in current)
      ) {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);
}

function evaluateExpectedValue(
  configuration: Extract<CheckConfiguration, { kind: "expected_value" }>,
  input: CompletionGateInput
): boolean {
  const source =
    configuration.source === "candidate" ? input.candidate : input.facts;
  const actual = readJsonPointer(source, configuration.pointer);
  if (configuration.operator === "equals") {
    return isDeepStrictEqual(actual, configuration.expectedValue);
  }
  if (configuration.operator === "member_of") {
    return (
      configuration.allowedValues?.some((allowed) =>
        isDeepStrictEqual(actual, allowed)
      ) ?? false
    );
  }
  return (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    configuration.minimum !== undefined &&
    configuration.maximum !== undefined &&
    actual >= configuration.minimum &&
    actual <= configuration.maximum
  );
}

function evaluateCheck(
  configuration: CheckConfiguration,
  input: CompletionGateInput
): { passed: boolean; reasonCode: string } {
  if (configuration.kind === "state_invariant") {
    const passed = !["budget_exhausted", "failed", "cancelled"].includes(
      input.goal.status
    );
    return {
      passed,
      reasonCode: passed
        ? "STATE_INVARIANT_SATISFIED"
        : "STATE_INVARIANT_VIOLATED",
    };
  }
  if (configuration.kind === "schema_conformance") {
    const fact = schemaFactSchema.safeParse(
      input.facts[configuration.factKey]
    );
    const passed =
      fact.success &&
      fact.data.passed &&
      fact.data.schemaVersion === configuration.expectedSchemaVersion &&
      fact.data.schemaDigest === configuration.expectedSchemaDigest;
    return {
      passed,
      reasonCode: passed
        ? "SCHEMA_CONFORMANCE_SATISFIED"
        : "SCHEMA_CONFORMANCE_FAILED",
    };
  }
  if (configuration.kind === "expected_value") {
    const passed = evaluateExpectedValue(configuration, input);
    return {
      passed,
      reasonCode: passed
        ? "EXPECTED_VALUE_SATISFIED"
        : "EXPECTED_VALUE_FAILED",
    };
  }
  if (configuration.kind === "required_evidence") {
    const evidenceRoot = input.facts.evidence;
    const evidence =
      evidenceRoot &&
      typeof evidenceRoot === "object" &&
      !Array.isArray(evidenceRoot)
        ? (evidenceRoot as Record<string, unknown>)[configuration.evidenceKey]
        : undefined;
    const fact = evidenceFactSchema.safeParse(evidence);
    const passed =
      fact.success &&
      fact.data.exists &&
      fact.data.parseable &&
      fact.data.version === configuration.expectedVersion &&
      fact.data.digest === configuration.expectedDigest;
    return {
      passed,
      reasonCode: passed
        ? "REQUIRED_EVIDENCE_SATISFIED"
        : "REQUIRED_EVIDENCE_MISSING",
    };
  }
  if (configuration.kind === "side_effect_invariant") {
    const fact = sideEffectFactSchema.safeParse(
      input.facts.sideEffectLedger
    );
    const passed =
      fact.success &&
      fact.data.duplicateEffectCount === 0 &&
      fact.data.unknownEffectCount === fact.data.reconciledUnknownEffectCount;
    return {
      passed,
      reasonCode: passed
        ? "SIDE_EFFECT_INVARIANT_SATISFIED"
        : "SIDE_EFFECT_INVARIANT_VIOLATED",
    };
  }
  const fact = recoveryFactSchema.safeParse(input.facts.recovery);
  const passed =
    fact.success &&
    fact.data.resumeCount <= configuration.maxResumeCount &&
    fact.data.retryCount <= configuration.maxRetryCount &&
    fact.data.drainElapsedMs <= configuration.maxDrainElapsedMs;
  return {
    passed,
    reasonCode: passed ? "RECOVERY_BOUND_SATISFIED" : "RECOVERY_BOUND_EXCEEDED",
  };
}

function invalidPolicyResult(
  policyRef: CompletionGateInput["policyRef"],
  reasonCode: string,
  evaluatedAt: string
): CompletionGateResult {
  return { status: "invalid_policy", policyRef, reasonCode, evaluatedAt };
}

export function evaluateCompletionGate(
  inputValue: unknown,
  policyValue: unknown,
  evaluatedAtValue: string
): CompletionGateResult {
  const evaluatedAt = evaluatedAtSchema.parse(evaluatedAtValue);
  const inputResult = completionGateInputSchema.safeParse(inputValue);
  const policyResult = policyBundleSchema.safeParse(policyValue);
  const fallbackPolicyRef = {
    policyId: "invalid",
    version: "invalid",
    digest: "invalid",
  };
  if (!inputResult.success || !policyResult.success) {
    return invalidPolicyResult(
      inputResult.success ? inputResult.data.policyRef : fallbackPolicyRef,
      "POLICY_SCHEMA_INVALID",
      evaluatedAt
    );
  }
  const input = inputResult.data;
  const policy = policyResult.data;
  if (!isDeepStrictEqual(input.policyRef, policy.policyRef)) {
    return invalidPolicyResult(input.policyRef, "POLICY_REFERENCE_MISMATCH", evaluatedAt);
  }
  if (input.deterministicChecks.length === 0) {
    return invalidPolicyResult(input.policyRef, "DETERMINISTIC_CHECK_REQUIRED", evaluatedAt);
  }
  const inputCheckIds = input.deterministicChecks.map(
    (check) => check.checkId
  );
  const uniqueInputCheckIds = new Set(inputCheckIds);
  const policyCheckIds = Object.keys(policy.checks);
  if (
    uniqueInputCheckIds.size !== inputCheckIds.length ||
    uniqueInputCheckIds.size !== policyCheckIds.length ||
    policyCheckIds.some((checkId) => !uniqueInputCheckIds.has(checkId))
  ) {
    return invalidPolicyResult(
      input.policyRef,
      "POLICY_CHECK_SET_MISMATCH",
      evaluatedAt
    );
  }

  const checks: Array<{
    checkId: string;
    passed: boolean;
    reasonCode: string;
  }> = [];
  for (const check of input.deterministicChecks) {
    const configuration = policy.checks[check.checkId];
    if (
      !configuration ||
      configuration.kind !== check.kind ||
      !referencesMatch(configuration.configRef, check.configRef)
    ) {
      return invalidPolicyResult(input.policyRef, "CHECK_CONFIGURATION_MISMATCH", evaluatedAt);
    }
    checks.push({ checkId: check.checkId, ...evaluateCheck(configuration, input) });
  }

  if (checks.some((check) => !check.passed)) {
    return { status: "failed", policyRef: input.policyRef, checks, evaluatedAt };
  }
  if (policy.requiresEvaluation) {
    if (!input.evaluation) {
      return { status: "failed", policyRef: input.policyRef, checks, evaluatedAt };
    }
    const inputEvaluationPolicy = {
      datasetId: input.evaluation.datasetId,
      datasetVersion: input.evaluation.datasetVersion,
      evaluatorId: input.evaluation.evaluatorId,
      evaluatorVersion: input.evaluation.evaluatorVersion,
      threshold: input.evaluation.threshold,
      maxJudgeCalls: input.evaluation.maxJudgeCalls,
      timeoutMs: input.evaluation.timeoutMs,
    };
    if (!isDeepStrictEqual(inputEvaluationPolicy, policy.evaluation)) {
      return invalidPolicyResult(
        input.policyRef,
        "EVALUATION_CONFIGURATION_MISMATCH",
        evaluatedAt
      );
    }
    const evaluation = {
      passed: input.evaluation.normalizedScore >= input.evaluation.threshold,
      normalizedScore: input.evaluation.normalizedScore,
      threshold: input.evaluation.threshold,
    };
    return {
      status: evaluation.passed ? "passed" : "failed",
      policyRef: input.policyRef,
      checks,
      evaluation,
      evaluatedAt,
    };
  }
  return { status: "passed", policyRef: input.policyRef, checks, evaluatedAt };
}

export function decideGoalProgress(
  gateResult: CompletionGateResult,
  isBudgetExhausted: boolean
): "complete" | "continue" | "budget_exhausted" {
  if (isBudgetExhausted) return "budget_exhausted";
  return gateResult.status === "passed" ? "complete" : "continue";
}
