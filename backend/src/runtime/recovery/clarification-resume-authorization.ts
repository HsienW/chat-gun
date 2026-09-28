import type { ActiveRunOwnership } from "../interaction/ownership.js";
import { classifyExecutionManifestCompatibility } from "./execution-manifest.js";
import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import type { ExecutionManifestRef } from "./interrupt-manifest.js";
import type { ResumeResponseSchemaRegistry } from "./resume-response-schema-registry.js";

export type ClarificationResumeAuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode:
        | "CLARIFICATION_MANIFEST_NOT_FOUND"
        | "CLARIFICATION_MANIFEST_KIND_MISMATCH"
        | "CLARIFICATION_MANIFEST_CORRELATION_MISMATCH"
        | "CLARIFICATION_MANIFEST_NOT_WAITING"
        | "CLARIFICATION_MANIFEST_EXPIRED"
        | "CLARIFICATION_EXECUTION_MANIFEST_INCOMPATIBLE"
        | "CLARIFICATION_RESPONSE_SCHEMA_UNKNOWN"
        | "CLARIFICATION_RESPONSE_INVALID"
        | "CLARIFICATION_RESUME_CONSUME_REJECTED";
    };

export interface AuthorizeClarificationResumeInput {
  interruptId: string;
  response: unknown;
  threadId: string;
  scopeId: string;
  activeOwnership: ActiveRunOwnership;
  now?: Date;
}

export type AuthorizeClarificationResume = (
  request: AuthorizeClarificationResumeInput
) => Promise<ClarificationResumeAuthorizationResult>;

export function createClarificationResumeAuthorizer(input: {
  manifests: InterruptManifestRepository;
  responseSchemas: ResumeResponseSchemaRegistry;
  resolveCurrentExecutionManifest(
    graphId: string
  ): ExecutionManifestRef | undefined;
}): AuthorizeClarificationResume {
  return async function authorizeClarificationResume(
    request: AuthorizeClarificationResumeInput
  ): Promise<ClarificationResumeAuthorizationResult> {
    const now = request.now ?? new Date();
    const manifest = await input.manifests.findByInterruptId(
      request.interruptId
    );
    if (!manifest) {
      return { ok: false, reasonCode: "CLARIFICATION_MANIFEST_NOT_FOUND" };
    }
    if (manifest.kind !== "clarification") {
      return { ok: false, reasonCode: "CLARIFICATION_MANIFEST_KIND_MISMATCH" };
    }
    if (
      manifest.threadId !== request.threadId ||
      manifest.scopeId !== request.scopeId ||
      manifest.runId !== request.activeOwnership.runId ||
      manifest.taskId !== request.activeOwnership.taskId
    ) {
      return {
        ok: false,
        reasonCode: "CLARIFICATION_MANIFEST_CORRELATION_MISMATCH",
      };
    }
    if (manifest.status !== "waiting") {
      return { ok: false, reasonCode: "CLARIFICATION_MANIFEST_NOT_WAITING" };
    }
    if (new Date(manifest.expiryAt).getTime() <= now.getTime()) {
      await input.manifests.transitionStatus({
        interruptId: manifest.interruptId,
        expectedStatus: "waiting",
        nextStatus: "expired",
        now,
      });
      return { ok: false, reasonCode: "CLARIFICATION_MANIFEST_EXPIRED" };
    }
    const currentManifest = input.resolveCurrentExecutionManifest(
      manifest.executionManifest.graphId
    );
    if (
      !currentManifest ||
      classifyExecutionManifestCompatibility(
        manifest.executionManifest,
        currentManifest
      ) !== "compatible"
    ) {
      return {
        ok: false,
        reasonCode: "CLARIFICATION_EXECUTION_MANIFEST_INCOMPATIBLE",
      };
    }
    const response = input.responseSchemas.validate(
      manifest.expectedResponseSchemaRef,
      request.response
    );
    if (!response.ok) {
      return {
        ok: false,
        reasonCode:
          response.reasonCode === "UNKNOWN_RESPONSE_SCHEMA"
            ? "CLARIFICATION_RESPONSE_SCHEMA_UNKNOWN"
            : "CLARIFICATION_RESPONSE_INVALID",
      };
    }
    const consumed = await input.manifests.consume({
      interruptId: manifest.interruptId,
      runId: manifest.runId,
      taskId: manifest.taskId,
      scopeId: manifest.scopeId,
      now,
    });
    return consumed
      ? { ok: true }
      : { ok: false, reasonCode: "CLARIFICATION_RESUME_CONSUME_REJECTED" };
  };
}
