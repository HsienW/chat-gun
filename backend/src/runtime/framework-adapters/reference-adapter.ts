import { checkpointAdapterMetadataV1Schema, evaluateCheckpointAdapterCompatibility, type CheckpointCompatibilityPolicy } from "../persistence/checkpoint-adapter-metadata.js";
import { executionContextSchema } from "../execution-context/execution-context.js";
import { FrameworkAdapterError, runBoundedAdapterOperation } from "./bounded-operation.js";
import { FRAMEWORK_ADAPTER_CAPABILITIES, FRAMEWORK_ADAPTER_CONTRACT_VERSION, type FrameworkAdapterPort, type FrameworkInvocation, type FrameworkOutcome } from "./registry.js";

export function createReferenceAdapter(host: {
  adapterId: string;
  timeoutMs: number;
  policy: (request: FrameworkInvocation) => CheckpointCompatibilityPolicy;
  execute: (mode: "invoke" | "resume", request: FrameworkInvocation) => Promise<FrameworkOutcome>;
}): FrameworkAdapterPort {
  const active = new Map<string, AbortController>();

  async function execute(mode: "invoke" | "resume", request: FrameworkInvocation): Promise<FrameworkOutcome> {
    const context = executionContextSchema.safeParse(request.context);
    const checkpoint = checkpointAdapterMetadataV1Schema.safeParse(request.checkpoint);
    if (!context.success || !checkpoint.success
      || checkpoint.data.nativeCheckpointRef.threadId !== context.data.threadId
      || checkpoint.data.productIdentityRef.runId !== context.data.runId
      || checkpoint.data.productIdentityRef.taskId !== context.data.taskId) {
      throw new FrameworkAdapterError("CHECKPOINT_PARKED");
    }
    const compatibility = evaluateCheckpointAdapterCompatibility(checkpoint.data, host.policy(request));
    if (compatibility.status !== "compatible" || compatibility.metadata.adapterId !== host.adapterId) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
    const runId = compatibility.metadata.productIdentityRef.runId;
    if (active.has(runId)) throw new FrameworkAdapterError("ADAPTER_DUPLICATE");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.signal.aborted) cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    active.set(runId, controller);
    try {
      return await runBoundedAdapterOperation(async (signal) => {
        let open = true;
        try {
          return await host.execute(mode, {
            ...request,
            context: context.data,
            checkpoint: compatibility.metadata,
            signal,
            observe: async (observation) => {
              if (!open || signal.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
              await request.observe(observation);
            },
          });
        } finally {
          open = false;
        }
      }, { timeoutMs: host.timeoutMs, signal: controller.signal });
    } finally {
      request.signal.removeEventListener("abort", cancel);
      active.delete(runId);
    }
  }

  return {
    descriptor: { adapterId: host.adapterId, contractVersion: FRAMEWORK_ADAPTER_CONTRACT_VERSION, capabilities: [...FRAMEWORK_ADAPTER_CAPABILITIES] },
    invoke: (request) => execute("invoke", request),
    resume: (request) => execute("resume", request),
    cancel: async (runId) => { active.get(runId)?.abort(); },
  };
}
