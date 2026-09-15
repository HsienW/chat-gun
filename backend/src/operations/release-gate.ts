import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const releaseGateReportSchema = z
  .object({
    schemaVersion: z.literal("release-gate-report/v1"),
    reportVersion: nonEmptyStringSchema,
    policyRef: z
      .object({
        policyId: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        digest: nonEmptyStringSchema,
      })
      .strict(),
    dataset: z
      .object({
        name: nonEmptyStringSchema,
        version: z.string().regex(/^v\d+\.\d+\.\d+$/),
      })
      .strict(),
    checks: z
      .object({
        deterministicRegression: z
          .object({ passed: z.boolean() })
          .strict(),
        businessConstraint: z
          .object({ regressionCount: z.number().int().nonnegative() })
          .strict(),
        duplicateSideEffect: z
          .object({ regressionCount: z.number().int().nonnegative() })
          .strict(),
        recovery: z.object({ withinBounds: z.boolean() }).strict(),
        costLatency: z.object({ withinTolerance: z.boolean() }).strict(),
        manifest: z
          .object({
            compatibility: z.enum([
              "compatible",
              "migratable",
              "incompatible",
            ]),
          })
          .strict(),
      })
      .strict(),
    hardNegativeCases: z
      .array(
        z
          .object({
            caseId: nonEmptyStringSchema,
            passed: z.boolean(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export type ReleaseGateReport = z.infer<typeof releaseGateReportSchema>;

export type ReleaseGateFailureReasonCode =
  | "DETERMINISTIC_REGRESSION"
  | "BUSINESS_CONSTRAINT_REGRESSION"
  | "DUPLICATE_SIDE_EFFECT_REGRESSION"
  | "RECOVERY_BOUND_REGRESSION"
  | "COST_LATENCY_REGRESSION"
  | "MANIFEST_INCOMPATIBLE"
  | "HARD_NEGATIVE_REGRESSION"
  | "RELEASE_GATE_REPORT_INVALID";

export interface ReleaseGateResult {
  status: "passed" | "failed" | "invalid_report";
  reportVersion: string | null;
  datasetVersion: string | null;
  failureReasonCodes: ReleaseGateFailureReasonCode[];
}

export function evaluateReleaseGate(
  reportValue: unknown
): ReleaseGateResult {
  const parsed = releaseGateReportSchema.safeParse(reportValue);
  if (!parsed.success) {
    return {
      status: "invalid_report",
      reportVersion: null,
      datasetVersion: null,
      failureReasonCodes: ["RELEASE_GATE_REPORT_INVALID"],
    };
  }
  const report = parsed.data;
  const failureReasonCodes: ReleaseGateFailureReasonCode[] = [];
  if (!report.checks.deterministicRegression.passed) {
    failureReasonCodes.push("DETERMINISTIC_REGRESSION");
  }
  if (report.checks.businessConstraint.regressionCount > 0) {
    failureReasonCodes.push("BUSINESS_CONSTRAINT_REGRESSION");
  }
  if (report.checks.duplicateSideEffect.regressionCount > 0) {
    failureReasonCodes.push("DUPLICATE_SIDE_EFFECT_REGRESSION");
  }
  if (!report.checks.recovery.withinBounds) {
    failureReasonCodes.push("RECOVERY_BOUND_REGRESSION");
  }
  if (!report.checks.costLatency.withinTolerance) {
    failureReasonCodes.push("COST_LATENCY_REGRESSION");
  }
  if (report.checks.manifest.compatibility === "incompatible") {
    failureReasonCodes.push("MANIFEST_INCOMPATIBLE");
  }
  if (report.hardNegativeCases.some((testCase) => !testCase.passed)) {
    failureReasonCodes.push("HARD_NEGATIVE_REGRESSION");
  }
  return {
    status: failureReasonCodes.length === 0 ? "passed" : "failed",
    reportVersion: report.reportVersion,
    datasetVersion: report.dataset.version,
    failureReasonCodes,
  };
}
