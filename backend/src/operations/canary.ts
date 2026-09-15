import { createHash } from "node:crypto";

import { z } from "zod";

import {
  executionManifestSchema,
  type ExecutionManifest,
} from "./types.js";

const boundedIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const safeMockToolInputSchema = z
  .object({
    canaryId: boundedIdentifierSchema,
    nonce: boundedIdentifierSchema,
  })
  .strict();
const safeMockToolOutputSchema = z
  .object({
    resourceKind: z.literal("memory_only"),
    effectId: z.string().regex(/^canary-effect:[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const canaryInputSchema = z
  .object({
    canaryId: boundedIdentifierSchema,
    nonce: boundedIdentifierSchema,
    runtimeBuildId: boundedIdentifierSchema,
    executionManifest: executionManifestSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();
const taskReferenceSchema = z
  .object({ taskId: boundedIdentifierSchema })
  .strict();
const stepReferenceSchema = z
  .object({ stepId: boundedIdentifierSchema })
  .strict();
const checkpointReferenceSchema = z
  .object({ checkpointId: boundedIdentifierSchema })
  .strict();
const verificationSchema = z
  .object({
    hasAudit: z.boolean(),
    hasOtelTrace: z.boolean(),
    duplicateEffectCount: z.number().int().nonnegative(),
  })
  .strict();
const cleanupSchema = z
  .object({ cleanupTraceRef: z.string().trim().min(1) })
  .strict();

export type SafeCanaryMockToolInput = z.infer<typeof safeMockToolInputSchema>;
export type SafeCanaryMockToolOutput = z.infer<typeof safeMockToolOutputSchema>;

export interface CanaryDependencies {
  createTask(
    input: {
      canaryId: string;
      runtimeBuildId: string;
      executionManifest: ExecutionManifest;
    },
    signal: AbortSignal
  ): Promise<unknown>;
  createStep(
    input: { taskId: string; canaryId: string },
    signal: AbortSignal
  ): Promise<unknown>;
  persistTaskStepEvent(
    input: {
      taskId: string;
      stepId: string;
      runtimeBuildId: string;
      executionManifest: ExecutionManifest;
    },
    signal: AbortSignal
  ): Promise<void>;
  invokeSafeMockTool(
    input: SafeCanaryMockToolInput,
    signal: AbortSignal
  ): Promise<unknown>;
  checkpointAndInterrupt(
    input: {
      taskId: string;
      stepId: string;
      toolOutput: SafeCanaryMockToolOutput;
    },
    signal: AbortSignal
  ): Promise<unknown>;
  resumeFromCheckpoint(
    input: { taskId: string; checkpointId: string },
    signal: AbortSignal
  ): Promise<void>;
  verifyAuditAndTrace(
    input: { taskId: string; stepId: string; effectId: string },
    signal: AbortSignal
  ): Promise<unknown>;
  cleanup(input: {
    canaryId: string;
    taskId?: string;
    stepId?: string;
  }): Promise<unknown>;
  markDeploymentHealth(
    status: "healthy" | "unhealthy",
    result: CanaryResult
  ): Promise<void>;
}

export type CanaryReasonCode =
  | "CANARY_VERIFIED"
  | "CANARY_AUDIT_MISSING"
  | "CANARY_TRACE_MISSING"
  | "CANARY_DUPLICATE_EFFECT"
  | "CANARY_TIMEOUT"
  | "CANARY_EXECUTION_FAILED"
  | "CANARY_CLEANUP_FAILED";

export interface CanaryResult {
  status: "healthy" | "unhealthy";
  reasonCode: CanaryReasonCode;
  runtimeBuildId: string;
  executionManifest: ExecutionManifest;
  taskId?: string;
  stepId?: string;
  checkpointId?: string;
  duplicateEffectCount?: number;
  cleanupTraceRef?: string;
}

class CanaryTimeoutError extends Error {
  constructor() {
    super("CANARY_TIMEOUT");
    this.name = "CanaryTimeoutError";
  }
}

function awaitWithAbort<TResult>(
  operation: Promise<TResult>,
  signal: AbortSignal
): Promise<TResult> {
  if (signal.aborted) return Promise.reject(new CanaryTimeoutError());
  return new Promise<TResult>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new CanaryTimeoutError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export function runSafeCanaryMockTool(
  inputValue: unknown
): SafeCanaryMockToolOutput {
  const input = safeMockToolInputSchema.parse(inputValue);
  const digest = createHash("sha256")
    .update(`${input.canaryId}:\0:${input.nonce}`, "utf8")
    .digest("hex");
  return safeMockToolOutputSchema.parse({
    resourceKind: "memory_only",
    effectId: `canary-effect:${digest}`,
    digest,
  });
}

function reasonFromVerification(
  verification: z.infer<typeof verificationSchema>
): CanaryReasonCode {
  if (verification.duplicateEffectCount > 0) {
    return "CANARY_DUPLICATE_EFFECT";
  }
  if (!verification.hasAudit) return "CANARY_AUDIT_MISSING";
  if (!verification.hasOtelTrace) return "CANARY_TRACE_MISSING";
  return "CANARY_VERIFIED";
}

export async function runLiveRuntimeCanary(
  inputValue: unknown,
  dependencies: CanaryDependencies
): Promise<CanaryResult> {
  const input = canaryInputSchema.parse(inputValue);
  if (input.runtimeBuildId !== input.executionManifest.runtimeBuildId) {
    throw new Error("CANARY_MANIFEST_BUILD_MISMATCH");
  }
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new CanaryTimeoutError()),
    input.timeoutMs
  );
  timeout.unref?.();
  let taskId: string | undefined;
  let stepId: string | undefined;
  let checkpointId: string | undefined;
  let duplicateEffectCount: number | undefined;
  let reasonCode: CanaryReasonCode = "CANARY_EXECUTION_FAILED";
  let cleanupTraceRef: string | undefined;

  try {
    const task = taskReferenceSchema.parse(
      await awaitWithAbort(
        dependencies.createTask(
          {
            canaryId: input.canaryId,
            runtimeBuildId: input.runtimeBuildId,
            executionManifest: input.executionManifest,
          },
          abortController.signal
        ),
        abortController.signal
      )
    );
    taskId = task.taskId;
    const step = stepReferenceSchema.parse(
      await awaitWithAbort(
        dependencies.createStep(
          { taskId, canaryId: input.canaryId },
          abortController.signal
        ),
        abortController.signal
      )
    );
    stepId = step.stepId;
    await awaitWithAbort(
      dependencies.persistTaskStepEvent(
        {
          taskId,
          stepId,
          runtimeBuildId: input.runtimeBuildId,
          executionManifest: input.executionManifest,
        },
        abortController.signal
      ),
      abortController.signal
    );
    const toolOutput = safeMockToolOutputSchema.parse(
      await awaitWithAbort(
        dependencies.invokeSafeMockTool(
          { canaryId: input.canaryId, nonce: input.nonce },
          abortController.signal
        ),
        abortController.signal
      )
    );
    const checkpoint = checkpointReferenceSchema.parse(
      await awaitWithAbort(
        dependencies.checkpointAndInterrupt(
          { taskId, stepId, toolOutput },
          abortController.signal
        ),
        abortController.signal
      )
    );
    checkpointId = checkpoint.checkpointId;
    await awaitWithAbort(
      dependencies.resumeFromCheckpoint(
        { taskId, checkpointId },
        abortController.signal
      ),
      abortController.signal
    );
    const verification = verificationSchema.parse(
      await awaitWithAbort(
        dependencies.verifyAuditAndTrace(
          { taskId, stepId, effectId: toolOutput.effectId },
          abortController.signal
        ),
        abortController.signal
      )
    );
    duplicateEffectCount = verification.duplicateEffectCount;
    reasonCode = reasonFromVerification(verification);
  } catch (error) {
    reasonCode =
      error instanceof CanaryTimeoutError
        ? "CANARY_TIMEOUT"
        : "CANARY_EXECUTION_FAILED";
  } finally {
    clearTimeout(timeout);
    try {
      const cleanup = cleanupSchema.parse(
        await dependencies.cleanup({
          canaryId: input.canaryId,
          ...(taskId ? { taskId } : {}),
          ...(stepId ? { stepId } : {}),
        })
      );
      cleanupTraceRef = cleanup.cleanupTraceRef;
    } catch {
      reasonCode = "CANARY_CLEANUP_FAILED";
    }
  }

  const result: CanaryResult = {
    status: reasonCode === "CANARY_VERIFIED" ? "healthy" : "unhealthy",
    reasonCode,
    runtimeBuildId: input.runtimeBuildId,
    executionManifest: input.executionManifest,
    ...(taskId ? { taskId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(duplicateEffectCount !== undefined ? { duplicateEffectCount } : {}),
    ...(cleanupTraceRef ? { cleanupTraceRef } : {}),
  };
  await dependencies.markDeploymentHealth(result.status, result);
  return result;
}
