import type { TaskStatus, StepStatus } from "../types.js";
import type {
  ReconciliationInput,
  SideEffectReconciler,
} from "../side-effect/side-effect-descriptor.js";
import {
  classifyLastExecutionPoint,
  routeRecoveryContinuation,
  type LastExecutionPoint,
} from "./last-execution-point.js";
import type { RecoveryCheckpointAdapter } from "./langgraph-checkpoint-adapter.js";
import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import type {
  DurableInterruptManifest,
  ExecutionManifestRef,
} from "./interrupt-manifest.js";
import {
  sanitizeRecoveryHistory,
  type SanitizeResult,
} from "./recovery-sanitizer.js";
import type { ResumeResponseSchemaRegistry } from "./resume-response-schema-registry.js";

export interface DurableRecoveryEvidence {
  taskStatus: TaskStatus;
  stepStatus?: StepStatus;
  ledgerStatus: "none" | "prepared" | "executing" | "committed" | "unknown";
  isMutation: boolean;
  canRetry: boolean;
  reconciliationInput: ReconciliationInput;
}

export interface ConversationRecoveryInput {
  interruptId: string;
  threadId: string;
  runId: string;
  taskId: string;
  scopeId: string;
  response?: unknown;
  now?: Date;
}

export type ConversationRecoveryResult =
  | {
      status: "manual_intervention_required";
      reasonCodes: string[];
      classification?: LastExecutionPoint;
    }
  | { status: "waiting_user"; classification: "waiting_user" }
  | {
      status: "ready_to_continue";
      classification: "not_started" | "executing" | "committed";
    }
  | { status: "terminal"; classification: "terminal" }
  | {
      status: "resumed";
      classification: "waiting_user";
      sanitizeStatus: "valid" | "sanitized";
    }
  | {
      status: "reconciled";
      classification: "committed" | "unknown";
      action: "commit" | "retry";
      reconciliationState: "committed" | "not_committed" | "unknown";
    };

export interface ConfirmationResumeAuthorizer {
  consume(input: {
    manifest: Extract<DurableInterruptManifest, { kind: "confirmation" }>;
    response: unknown;
  }): Promise<boolean>;
}

export interface ConversationRecoveryDependencies {
  checkpoint: RecoveryCheckpointAdapter;
  manifests: InterruptManifestRepository;
  responseSchemas: ResumeResponseSchemaRegistry;
  currentExecutionManifest: ExecutionManifestRef;
  loadDurableEvidence(taskId: string): Promise<DurableRecoveryEvidence>;
  resolveReconciler?: (
    evidence: DurableRecoveryEvidence
  ) => SideEffectReconciler<unknown> | undefined;
  confirmationAuthorizer?: ConfirmationResumeAuthorizer;
}

function hasExpectedCorrelation(
  manifest: DurableInterruptManifest,
  input: ConversationRecoveryInput
): boolean {
  return (
    manifest.interruptId === input.interruptId &&
    manifest.threadId === input.threadId &&
    manifest.runId === input.runId &&
    manifest.taskId === input.taskId &&
    manifest.scopeId === input.scopeId
  );
}

function manual(
  reasonCodes: string[],
  classification?: LastExecutionPoint
): ConversationRecoveryResult {
  return {
    status: "manual_intervention_required",
    reasonCodes,
    ...(classification ? { classification } : {}),
  };
}

function sanitizerDiagnostic(result: SanitizeResult) {
  return result.status === "sanitized"
    ? { status: result.status, reasonCodes: result.reasonCodes }
    : result.status === "valid"
      ? { status: result.status, reasonCodes: [] }
      : undefined;
}

async function consumeResume(input: {
  manifest: DurableInterruptManifest;
  response: unknown;
  now: Date;
  dependencies: ConversationRecoveryDependencies;
}): Promise<boolean> {
  if (input.manifest.kind === "confirmation") {
    return (
      input.dependencies.confirmationAuthorizer?.consume({
        manifest: input.manifest,
        response: input.response,
      }) ?? Promise.resolve(false)
    );
  }
  const consumed = await input.dependencies.manifests.consume({
    interruptId: input.manifest.interruptId,
    runId: input.manifest.runId,
    taskId: input.manifest.taskId,
    scopeId: input.manifest.scopeId,
    now: input.now,
  });
  return consumed !== null;
}

export function createConversationRecovery(
  dependencies: ConversationRecoveryDependencies
) {
  return {
    async recover(
      input: ConversationRecoveryInput
    ): Promise<ConversationRecoveryResult> {
      const now = input.now ?? new Date();
      const manifest = await dependencies.manifests.findByInterruptId(
        input.interruptId
      );
      if (!manifest) return manual(["MANIFEST_NOT_FOUND"]);
      if (!hasExpectedCorrelation(manifest, input)) {
        return manual(["MANIFEST_CORRELATION_MISMATCH"]);
      }
      if (input.response !== undefined && manifest.status !== "waiting") {
        return manual(["MANIFEST_NOT_WAITING"]);
      }
      const manifestExpired =
        new Date(manifest.expiryAt).getTime() <= now.getTime();
      if (input.response !== undefined && manifestExpired) {
        if (manifest.status === "waiting") {
          await dependencies.manifests.transitionStatus({
            interruptId: manifest.interruptId,
            expectedStatus: "waiting",
            nextStatus: "expired",
            now,
          });
        }
        return manual(["MANIFEST_EXPIRED"]);
      }

      const checkpoint = await dependencies.checkpoint.read(input.threadId);
      if (!checkpoint.exists) return manual(["CHECKPOINT_NOT_FOUND"]);
      const sanitized = sanitizeRecoveryHistory({
        messages: checkpoint.messages,
        persistedExecutionManifest: manifest.executionManifest,
        currentExecutionManifest: dependencies.currentExecutionManifest,
      });
      if (sanitized.status === "parked") {
        return manual([...sanitized.reasonCodes]);
      }

      const evidence = await dependencies.loadDurableEvidence(input.taskId);
      const classification = classifyLastExecutionPoint({
        taskStatus: evidence.taskStatus,
        ...(evidence.stepStatus ? { stepStatus: evidence.stepStatus } : {}),
        ledgerStatus: evidence.ledgerStatus,
        checkpoint: {
          exists: checkpoint.exists,
          hasPendingNodes: checkpoint.hasPendingNodes,
          isTerminal: checkpoint.isTerminal,
        },
        manifestStatus: manifest.status,
        sanitizeDiagnostic: sanitizerDiagnostic(sanitized),
      });
      const continuation = await routeRecoveryContinuation({
        classification,
        isMutation: evidence.isMutation,
        reconciler: dependencies.resolveReconciler?.(evidence),
        reconciliationInput: evidence.reconciliationInput,
        canRetry: evidence.canRetry,
      });

      if (continuation.action === "stop") {
        return { status: "terminal", classification: "terminal" };
      }
      if (continuation.action === "park") {
        return manual([continuation.reasonCode], classification);
      }
      if (continuation.action === "defer") {
        return manual(["RECONCILIATION_DEFERRED"], classification);
      }
      if (continuation.action === "commit" || continuation.action === "retry") {
        return {
          status: "reconciled",
          classification: classification === "committed" ? "committed" : "unknown",
          action: continuation.action,
          reconciliationState: continuation.reconciliationState,
        };
      }
      if (continuation.action === "resume") {
        return {
          status: "ready_to_continue",
          classification:
            classification === "not_started" || classification === "committed"
              ? classification
              : "executing",
        };
      }
      if (input.response === undefined) {
        if (manifestExpired) {
          await dependencies.manifests.transitionStatus({
            interruptId: manifest.interruptId,
            expectedStatus: "waiting",
            nextStatus: "expired",
            now,
          });
          return manual(["MANIFEST_EXPIRED"], classification);
        }
        return { status: "waiting_user", classification: "waiting_user" };
      }

      const validated = dependencies.responseSchemas.validate(
        manifest.expectedResponseSchemaRef,
        input.response
      );
      if (!validated.ok) return manual([validated.reasonCode], classification);
      if (!(await consumeResume({ manifest, response: validated.value, now, dependencies }))) {
        return manual(["RESUME_CONSUME_REJECTED"], classification);
      }
      await dependencies.checkpoint.resume({
        threadId: input.threadId,
        response: validated.value,
        sanitizedHistory: sanitized.history,
      });
      return {
        status: "resumed",
        classification: "waiting_user",
        sanitizeStatus: sanitized.status,
      };
    },
  };
}
