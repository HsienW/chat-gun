import { createHash } from "node:crypto";

import type { ConfirmationRequiredDescriptor } from "../authorization/confirmation.js";
import {
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
  type ExecutionManifestRef,
} from "./interrupt-manifest.js";

export function createConfirmationInterruptId(
  descriptor: ConfirmationRequiredDescriptor
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        descriptor.decisionId,
        descriptor.runId,
        descriptor.taskId,
        descriptor.scope.scopeId,
      ])
    )
    .digest("hex");
  return `confirmation:${digest}`;
}

export function createConfirmationInterruptManifest(input: {
  descriptor: ConfirmationRequiredDescriptor;
  executionManifest: ExecutionManifestRef;
  now?: Date;
}): DurableInterruptManifest {
  const now = input.now ?? new Date();
  return parseDurableInterruptManifest({
    interruptId: createConfirmationInterruptId(input.descriptor),
    kind: "confirmation",
    runId: input.descriptor.runId,
    threadId: input.descriptor.threadId,
    taskId: input.descriptor.taskId,
    ...(input.descriptor.stepId ? { stepId: input.descriptor.stepId } : {}),
    scopeId: input.descriptor.scope.scopeId,
    expectedResponseSchemaRef: "tool_authorization_confirmation@1.0",
    expiryAt: input.descriptor.expiresAt,
    executionManifest: input.executionManifest,
    status: "waiting",
    decisionRef: {
      decisionId: input.descriptor.decisionId,
      approvalId: input.descriptor.approvalId,
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}
