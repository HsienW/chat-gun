import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  EvaluationDataset,
  EvaluationItem,
} from "../evaluation/opik/types.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const datasetVersionSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const expectedToolCallSchema = z
  .object({
    name: nonEmptyStringSchema,
    arguments: z.record(z.unknown()),
  })
  .strict();
const expectedOutputSchema = z
  .object({
    toolCalls: z.array(expectedToolCallSchema).optional(),
    summary: z.string().max(2_000).optional(),
    status: nonEmptyStringSchema.optional(),
    code: nonEmptyStringSchema.optional(),
  })
  .strict();
const badTraceSchema = z
  .object({
    schemaVersion: z.literal("bad-trace/v1"),
    traceId: nonEmptyStringSchema.max(256),
    failureType: nonEmptyStringSchema.max(128),
    input: z.record(z.unknown()),
    expectedOutput: expectedOutputSchema,
    runtimeBuildId: nonEmptyStringSchema.max(128),
  })
  .strict();
const redactionPolicySchema = z
  .object({
    policyVersion: nonEmptyStringSchema,
    datasetName: nonEmptyStringSchema,
    datasetVersion: datasetVersionSchema,
    caseId: nonEmptyStringSchema,
    allowedInputFields: z
      .array(nonEmptyStringSchema)
      .max(32)
      .refine(
        (fields) => new Set(fields).size === fields.length,
        "allowedInputFields must not contain duplicates"
      )
      .refine(
        (fields) =>
          fields.every(
            (field) =>
              !/(?:token|secret|credential|password|authorization|cookie|prompt|tool.?output)/i.test(
                field
              )
          ),
        "allowedInputFields contains a sensitive field"
      ),
  })
  .strict();
const redactedScalarSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const redactedValueSchema = z.union([
  redactedScalarSchema,
  z.array(redactedScalarSchema).max(50),
]);
const evaluationItemSchema = z
  .object({
    id: nonEmptyStringSchema,
    input: z.record(redactedValueSchema),
    expectedOutput: expectedOutputSchema.optional(),
    goldenTrace: z.string().max(4_000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
const evaluationDatasetSchema = z
  .object({
    name: nonEmptyStringSchema,
    version: datasetVersionSchema,
    items: z.array(evaluationItemSchema),
  })
  .strict();
const experimentSnapshotSchema = z
  .object({
    datasetName: nonEmptyStringSchema,
    datasetVersion: datasetVersionSchema,
    metrics: z.record(z.number().finite()),
  })
  .strict();

export interface VersionPinnedExperimentComparison {
  datasetName: string;
  datasetVersion: string;
  deltas: Record<string, number>;
}

function selectRedactedInput(
  input: Record<string, unknown>,
  allowedInputFields: string[]
): Record<string, z.infer<typeof redactedValueSchema>> {
  const selected: Record<string, z.infer<typeof redactedValueSchema>> = {};
  for (const field of allowedInputFields) {
    if (!(field in input)) continue;
    selected[field] = redactedValueSchema.parse(input[field]);
  }
  return selected;
}

export function createRedactedRegressionCase(
  badTraceValue: unknown,
  policyValue: unknown
): EvaluationItem {
  const badTrace = badTraceSchema.parse(badTraceValue);
  const policy = redactionPolicySchema.parse(policyValue);
  const sourceTraceDigest = createHash("sha256")
    .update(badTrace.traceId, "utf8")
    .digest("hex");
  return evaluationItemSchema.parse({
    id: policy.caseId,
    input: selectRedactedInput(
      badTrace.input,
      policy.allowedInputFields
    ),
    expectedOutput: badTrace.expectedOutput,
    metadata: {
      source: "redacted_bad_trace",
      failureType: badTrace.failureType,
      datasetVersion: policy.datasetVersion,
      redactionPolicyVersion: policy.policyVersion,
      sourceTraceDigest,
      runtimeBuildId: badTrace.runtimeBuildId,
    },
  });
}

export function addBadTraceRegressionCase(
  datasetValue: unknown,
  badTraceValue: unknown,
  policyValue: unknown
): EvaluationDataset {
  const dataset = evaluationDatasetSchema.parse(datasetValue);
  const policy = redactionPolicySchema.parse(policyValue);
  if (
    dataset.name !== policy.datasetName ||
    dataset.version !== policy.datasetVersion
  ) {
    throw new Error("FEEDBACK_DATASET_VERSION_MISMATCH");
  }
  const regressionCase = createRedactedRegressionCase(
    badTraceValue,
    policy
  );
  if (dataset.items.some((item) => item.id === regressionCase.id)) {
    throw new Error("FEEDBACK_CASE_ALREADY_EXISTS");
  }
  return {
    name: dataset.name,
    version: dataset.version,
    items: [...dataset.items, regressionCase],
  };
}

export function compareVersionPinnedExperiments(
  beforeValue: unknown,
  afterValue: unknown
): VersionPinnedExperimentComparison {
  const before = experimentSnapshotSchema.parse(beforeValue);
  const after = experimentSnapshotSchema.parse(afterValue);
  if (
    before.datasetName !== after.datasetName ||
    before.datasetVersion !== after.datasetVersion
  ) {
    throw new Error("FEEDBACK_DATASET_VERSION_MISMATCH");
  }
  const metricNames = [
    ...new Set([
      ...Object.keys(before.metrics),
      ...Object.keys(after.metrics),
    ]),
  ].sort();
  const deltas = Object.fromEntries(
    metricNames.map((metricName) => [
      metricName,
      (after.metrics[metricName] ?? 0) -
        (before.metrics[metricName] ?? 0),
    ])
  );
  return {
    datasetName: before.datasetName,
    datasetVersion: before.datasetVersion,
    deltas,
  };
}
