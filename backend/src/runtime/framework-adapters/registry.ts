import { z } from "zod";
import type { JsonValue, RuntimeEventEnvelope, RunTerminalStatus } from "@gun-ai/harness-contracts";

import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { CheckpointAdapterMetadataV1 } from "../persistence/checkpoint-adapter-metadata.js";
import { FrameworkAdapterError, runBoundedAdapterOperation, type BoundedOperationOptions } from "./bounded-operation.js";

export const FRAMEWORK_ADAPTER_CONTRACT_VERSION = "1.0.0";
export const FRAMEWORK_ADAPTER_CAPABILITIES = ["invocation", "step", "checkpoint", "waitResume", "event", "cancel", "terminal"] as const;

const descriptorSchema = z.object({
  adapterId: z.string().min(1).max(256),
  contractVersion: z.string().min(1).max(128),
  capabilities: z.array(z.enum(FRAMEWORK_ADAPTER_CAPABILITIES)).refine((capabilities) => new Set(capabilities).size === capabilities.length),
}).strict();

export type FrameworkObservation =
  | { kind: "step"; stepId: string; attempt: number; phase: "started" | "completed" }
  | { kind: "checkpoint"; metadata: CheckpointAdapterMetadataV1 }
  | { kind: "event"; event: RuntimeEventEnvelope<string, JsonValue> }
  | { kind: "terminal"; status: RunTerminalStatus };

export type FrameworkOutcome =
  | { status: "completed"; output: JsonValue }
  | { status: "waiting"; checkpoint: CheckpointAdapterMetadataV1 }
  | { status: "failed"; reasonCode: string };

export interface FrameworkInvocation {
  input: JsonValue;
  context: ExecutionContext;
  checkpoint: CheckpointAdapterMetadataV1;
  signal: AbortSignal;
  observe: (observation: FrameworkObservation) => Promise<void>;
}

export interface FrameworkAdapterPort {
  descriptor: z.infer<typeof descriptorSchema>;
  invoke(request: FrameworkInvocation): Promise<FrameworkOutcome>;
  resume(request: FrameworkInvocation): Promise<FrameworkOutcome>;
  cancel(runId: string): Promise<void>;
}

const portSchema = z.object({
  descriptor: descriptorSchema,
  invoke: z.custom<FrameworkAdapterPort["invoke"]>((candidate) => typeof candidate === "function"),
  resume: z.custom<FrameworkAdapterPort["resume"]>((candidate) => typeof candidate === "function"),
  cancel: z.custom<FrameworkAdapterPort["cancel"]>((candidate) => typeof candidate === "function"),
}).strict();

export class FrameworkAdapterRegistry {
  private adapters = new Map<string, FrameworkAdapterPort>();

  get(adapterId: string): FrameworkAdapterPort | undefined { return this.adapters.get(adapterId); }

  async register(loaders: readonly ((signal: AbortSignal) => Promise<unknown>)[], options: BoundedOperationOptions): Promise<void> {
    const staged = await runBoundedAdapterOperation(async (signal) => Promise.all(loaders.map(async (load) => {
      const candidate = await load(signal);
      const parsed = portSchema.safeParse(candidate);
      if (!parsed.success) throw new FrameworkAdapterError("ADAPTER_INVALID");
      const port = parsed.data;
      port.invoke = port.invoke.bind(candidate);
      port.resume = port.resume.bind(candidate);
      port.cancel = port.cancel.bind(candidate);
      if (port.descriptor.contractVersion !== FRAMEWORK_ADAPTER_CONTRACT_VERSION || FRAMEWORK_ADAPTER_CAPABILITIES.some((capability) => !port.descriptor.capabilities.includes(capability))) throw new FrameworkAdapterError("ADAPTER_UNSUPPORTED");
      Object.freeze(port.descriptor.capabilities);
      Object.freeze(port.descriptor);
      return Object.freeze(port);
    })), options);
    if (options.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
    const published = new Map(this.adapters);
    for (const port of staged) {
      if (published.has(port.descriptor.adapterId)) throw new FrameworkAdapterError("ADAPTER_DUPLICATE");
      published.set(port.descriptor.adapterId, port);
    }
    this.adapters = published;
  }
}
