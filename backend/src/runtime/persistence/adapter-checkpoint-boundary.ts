import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";

import { FrameworkAdapterError, runBoundedAdapterOperation, type BoundedOperationOptions } from "../framework-adapters/bounded-operation.js";
import { checkpointAdapterMetadataV1Schema, checkpointCompatibilityPolicySchema, evaluateCheckpointAdapterCompatibility, type CheckpointAdapterMetadataV1, type CheckpointCompatibilityPolicy } from "./checkpoint-adapter-metadata.js";
import { redactCheckpointUpdate } from "./checkpoint-redaction.js";

type NativeCheckpointRef = CheckpointAdapterMetadataV1["nativeCheckpointRef"];

export interface AdapterCheckpoint<State> {
  metadata: CheckpointAdapterMetadataV1;
  state: State;
}

export interface AdapterCheckpointStore {
  read(reference: NativeCheckpointRef, signal: AbortSignal): Promise<unknown>;
  append(input: { parent: NativeCheckpointRef; checkpoint: AdapterCheckpoint<unknown> }, signal: AbortSignal): Promise<void>;
}

function assertJsonData(value: unknown, maxDepth: number, ancestors = new Set<object>()): void {
  if (maxDepth < 0) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
  for (const key of keys) {
    if (array && key === "length") continue;
    if (array && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
    assertJsonData(descriptor.value, maxDepth - 1, ancestors);
  }
  ancestors.delete(value);
}

export function createAdapterCheckpointBoundary<State>(input: {
  store: AdapterCheckpointStore;
  stateSchema: z.ZodType<State>;
  containsSecret: (serialized: string) => boolean;
  maxBytes: number;
  maxDepth: number;
}) {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || !Number.isSafeInteger(input.maxDepth) || input.maxDepth < 1) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");

  function validateState(value: unknown): State {
    try {
      assertJsonData(value, input.maxDepth);
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > input.maxBytes || input.containsSecret(serialized) || !isDeepStrictEqual(value, redactCheckpointUpdate(value))) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      const parsed = input.stateSchema.safeParse(value);
      if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      return structuredClone(parsed.data);
    } catch {
      throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
    }
  }

  return {
    async read(policy: CheckpointCompatibilityPolicy, options: BoundedOperationOptions) {
      const parsedPolicy = checkpointCompatibilityPolicySchema.safeParse(policy);
      if (!parsedPolicy.success) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
      const raw = await runBoundedAdapterOperation((signal) => input.store.read(parsedPolicy.data.nativeCheckpointRef, signal), options);
      if (raw === undefined || raw === null) throw new FrameworkAdapterError("CHECKPOINT_NOT_FOUND");
      if (typeof raw !== "object" || !Object.hasOwn(raw, "metadata") || !Object.hasOwn(raw, "state") || Reflect.ownKeys(raw).length !== 2) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      const metadata = Object.getOwnPropertyDescriptor(raw, "metadata");
      const state = Object.getOwnPropertyDescriptor(raw, "state");
      if (!metadata || !("value" in metadata) || !state || !("value" in state)) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      const compatibility = evaluateCheckpointAdapterCompatibility(metadata.value, policy);
      if (compatibility.status !== "compatible") return { status: "parked" as const, compatibility };
      if (input.containsSecret(JSON.stringify(compatibility.metadata))) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      return { status: "ready" as const, checkpoint: { metadata: compatibility.metadata, state: validateState(state.value) } };
    },

    async append(checkpoint: AdapterCheckpoint<unknown>, parentPolicy: CheckpointCompatibilityPolicy, options: BoundedOperationOptions) {
      const state = validateState(checkpoint.state);
      const parsedMetadata = checkpointAdapterMetadataV1Schema.safeParse(checkpoint.metadata);
      const parsedPolicy = checkpointCompatibilityPolicySchema.safeParse(parentPolicy);
      if (!parsedMetadata.success || !parsedPolicy.success) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
      const nextRef = parsedMetadata.data.nativeCheckpointRef;
      const parent = parsedPolicy.data.nativeCheckpointRef;
      if (nextRef.threadId !== parent.threadId || nextRef.checkpointNamespace !== parent.checkpointNamespace || nextRef.checkpointId === parent.checkpointId) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      const compatibility = evaluateCheckpointAdapterCompatibility(checkpoint.metadata, { ...parentPolicy, nativeCheckpointRef: nextRef });
      if (compatibility.status !== "compatible") return { status: "parked" as const, compatibility };
      const validated = { metadata: compatibility.metadata, state };
      if (input.containsSecret(JSON.stringify(validated.metadata))) throw new FrameworkAdapterError("CHECKPOINT_STATE_INVALID");
      let attempted = false;
      try {
        await runBoundedAdapterOperation((signal) => {
          attempted = true;
          return input.store.append({ parent: structuredClone(parent), checkpoint: structuredClone(validated) }, signal);
        }, options);
        return { status: "saved" as const, checkpoint: validated };
      } catch (error) {
        if (!attempted) throw error;
        return { status: "indeterminate" as const, action: "reconcile" as const, reasonCode: error instanceof FrameworkAdapterError ? error.code : "ADAPTER_OPERATION_FAILED" as const, reference: structuredClone(nextRef) };
      }
    },
  };
}
