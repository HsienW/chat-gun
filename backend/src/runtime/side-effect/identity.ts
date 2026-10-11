import { createHash, randomUUID } from "node:crypto";

import {
  createReplayKey as createKernelReplayKey,
  createRequestDedupKey as createKernelRequestDedupKey,
  createToolExecutionAttemptIdentity as createKernelToolExecutionAttemptIdentity,
  hashBusinessEffectKey as hashKernelBusinessEffectKey,
} from "@gun-ai/harness-kernel";
import type {
  ReplayIdentityInput,
  ReplayKey,
  RequestDedupIdentityInput,
  RequestDedupKey,
  BusinessEffectKey,
  ToolExecutionAttemptIdentity,
} from "@gun-ai/harness-contracts";

export type {
  BusinessEffectKey,
  ReplayIdentityInput,
  ReplayKey,
  RequestDedupIdentityInput,
  RequestDedupKey,
  ToolExecutionAttemptId,
  ToolExecutionAttemptIdentity,
  TrustedScope,
} from "@gun-ai/harness-contracts";

const hash = (values: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

export function createReplayKey(input: ReplayIdentityInput): ReplayKey {
  return createKernelReplayKey(input, { hash });
}

export function createToolExecutionAttemptIdentity(input: {
  toolExecutionId: string;
  executionAttempt: number;
}): ToolExecutionAttemptIdentity {
  return createKernelToolExecutionAttemptIdentity(input, { randomUUID });
}

export function hashBusinessEffectKey(rawKey: string): BusinessEffectKey {
  return hashKernelBusinessEffectKey(rawKey, { hash });
}

export function createRequestDedupKey(input: RequestDedupIdentityInput): RequestDedupKey {
  return createKernelRequestDedupKey(input, { hash });
}
