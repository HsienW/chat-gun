import { z } from "zod";

import { executionManifestSchema, type ExecutionManifest } from "./types.js";

export const GATE_REASON_CODES = [
  "ARCHITECTURE_CHECK_FAILED",
  "CANARY_FAILED",
  "DETERMINISTIC_GATE_FAILED",
  "FAULT_INJECTION_NEGATIVE_CHECK_FAILED",
  "CORRELATED_SLI_TOLERANCE_FAILED",
] as const;

export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

export interface ReadinessGateInput {
  policyRef: { policyId: string; version: string; digest: string };
  runtimeBuildId: string;
  executionManifest: ExecutionManifest;
  faultInjectionDataset: { datasetId: string; datasetVersion: string };
  canarySpec: { canaryId: string; timeoutMs: number };
}

export type ReadinessGateResult =
  | { status: "passed"; evaluatedAt: string; evidence: string[] }
  | { status: "failed"; evaluatedAt: string; reasons: GateReasonCode[] }
  | {
      status: "invalid_policy";
      evaluatedAt: string;
      reasonCode:
        | "READINESS_POLICY_INVALID"
        | "RUNTIME_BUILD_MANIFEST_MISMATCH";
    };

export interface ReadinessCheckResult {
  passed: boolean;
  reasonCode?: GateReasonCode;
  evidenceRef?: string;
}

type ReadinessCheck = (
  input: ReadinessGateInput
) => Promise<ReadinessCheckResult>;

export interface ReadinessGateDependencies {
  architectureChecks: ReadinessCheck;
  canary: ReadinessCheck;
  deterministicGate: ReadinessCheck;
  faultInjection: ReadinessCheck;
  correlatedSli: ReadinessCheck;
  now?: () => Date;
}

const nonEmptyStringSchema = z.string().trim().min(1).max(256);
const readinessGateInputSchema: z.ZodType<ReadinessGateInput> = z
  .object({
    policyRef: z
      .object({
        policyId: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        digest: nonEmptyStringSchema,
      })
      .strict(),
    runtimeBuildId: nonEmptyStringSchema,
    executionManifest: executionManifestSchema,
    faultInjectionDataset: z
      .object({
        datasetId: nonEmptyStringSchema,
        datasetVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
      })
      .strict(),
    canarySpec: z
      .object({
        canaryId: nonEmptyStringSchema,
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const CHECKS: ReadonlyArray<{
  dependency: keyof Pick<
    ReadinessGateDependencies,
    | "architectureChecks"
    | "canary"
    | "deterministicGate"
    | "faultInjection"
    | "correlatedSli"
  >;
  fallbackReasonCode: GateReasonCode;
}> = [
  {
    dependency: "architectureChecks",
    fallbackReasonCode: "ARCHITECTURE_CHECK_FAILED",
  },
  { dependency: "canary", fallbackReasonCode: "CANARY_FAILED" },
  {
    dependency: "deterministicGate",
    fallbackReasonCode: "DETERMINISTIC_GATE_FAILED",
  },
  {
    dependency: "faultInjection",
    fallbackReasonCode: "FAULT_INJECTION_NEGATIVE_CHECK_FAILED",
  },
  {
    dependency: "correlatedSli",
    fallbackReasonCode: "CORRELATED_SLI_TOLERANCE_FAILED",
  },
];

function assertDependencies(dependencies: ReadinessGateDependencies): void {
  for (const check of CHECKS) {
    if (typeof dependencies[check.dependency] !== "function") {
      throw new Error(`READINESS_GATE_DEPENDENCY_UNAVAILABLE:${check.dependency}`);
    }
  }
}

export function createReadinessGate(dependencies: ReadinessGateDependencies) {
  assertDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());

  return {
    async evaluate(inputValue: unknown): Promise<ReadinessGateResult> {
      const evaluatedAt = now().toISOString();
      const parsed = readinessGateInputSchema.safeParse(inputValue);
      if (!parsed.success) {
        return {
          status: "invalid_policy",
          evaluatedAt,
          reasonCode: "READINESS_POLICY_INVALID",
        };
      }
      const input = parsed.data;
      if (input.runtimeBuildId !== input.executionManifest.runtimeBuildId) {
        return {
          status: "invalid_policy",
          evaluatedAt,
          reasonCode: "RUNTIME_BUILD_MANIFEST_MISMATCH",
        };
      }

      const evidence: string[] = [];
      const reasons: GateReasonCode[] = [];
      for (const check of CHECKS) {
        const result = await dependencies[check.dependency](input);
        if (result.passed) {
          if (result.evidenceRef) evidence.push(result.evidenceRef);
          continue;
        }
        reasons.push(result.reasonCode ?? check.fallbackReasonCode);
      }

      return reasons.length > 0
        ? { status: "failed", evaluatedAt, reasons }
        : { status: "passed", evaluatedAt, evidence };
    },
  };
}
