import { z } from "zod";

export const FAULT_INJECTION_CATEGORIES = [
  "decoder",
  "authorization",
  "side_effect_duplicate",
  "recovery",
  "context_overflow",
  "event_terminal_monotonicity",
] as const;

export type FaultInjectionCategory =
  (typeof FAULT_INJECTION_CATEGORIES)[number];
export type FaultInjectionGateStatus = "passed" | "failed";

const faultInjectionCaseSchema = z
  .object({
    caseId: z.string().trim().min(1).max(128),
    category: z.enum([...FAULT_INJECTION_CATEGORIES, "control"]),
    expectedGateStatus: z.enum(["passed", "failed"]),
  })
  .strict();

const faultInjectionDatasetSchema = z
  .object({
    datasetId: z.string().trim().min(1).max(128),
    datasetVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
    executionMode: z.literal("memory_only"),
    cases: z.array(faultInjectionCaseSchema).min(1),
  })
  .strict()
  .superRefine((dataset, context) => {
    const ids = dataset.cases.map((faultCase) => faultCase.caseId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate_case_id" });
    }
    for (const category of FAULT_INJECTION_CATEGORIES) {
      const matches = dataset.cases.filter(
        (faultCase) => faultCase.category === category
      );
      if (
        matches.length !== 1 ||
        matches[0]?.expectedGateStatus !== "failed"
      ) {
        context.addIssue({
          code: "custom",
          message: `missing_deliberate_fault:${category}`,
        });
      }
    }
  });

export type FaultInjectionDataset = z.input<
  typeof faultInjectionDatasetSchema
>;
export type FaultInjectionCase = z.infer<typeof faultInjectionCaseSchema>;

export interface FaultInjectionEvaluationResult {
  passed: boolean;
  failedCaseIds: string[];
  reasonCode?: "FAULT_INJECTION_NEGATIVE_CHECK_FAILED";
}

export async function evaluateFaultInjectionDataset(
  datasetValue: unknown,
  runCase: (
    faultCase: FaultInjectionCase
  ) => Promise<FaultInjectionGateStatus>
): Promise<FaultInjectionEvaluationResult> {
  const dataset = faultInjectionDatasetSchema.parse(datasetValue);
  const failedCaseIds: string[] = [];
  for (const faultCase of dataset.cases) {
    const actualStatus = await runCase(faultCase);
    if (actualStatus !== faultCase.expectedGateStatus) {
      failedCaseIds.push(faultCase.caseId);
    }
  }
  return failedCaseIds.length === 0
    ? { passed: true, failedCaseIds }
    : {
        passed: false,
        failedCaseIds,
        reasonCode: "FAULT_INJECTION_NEGATIVE_CHECK_FAILED",
      };
}
