import { z } from "zod";

import type { LlmGateway } from "../platform/llm-gateway.js";
import type { AuthorizationEngine } from "../runtime/authorization/authorization.js";
import { RunSequenceAllocator } from "../runtime/event-sequence.js";
import { FrameworkAdapterError, runBoundedAdapterOperation, type BoundedOperationOptions } from "../runtime/framework-adapters/bounded-operation.js";
import { FrameworkAdapterRegistry, type FrameworkAdapterPort } from "../runtime/framework-adapters/registry.js";
import type { AdapterCheckpointStore } from "../runtime/persistence/adapter-checkpoint-boundary.js";
import { runtimeVersionSetSchema } from "../runtime/persistence/checkpoint-adapter-metadata.js";
import { evaluateRuntimeVersionCompatibility, type RuntimeVersionSet } from "../runtime/persistence/version-compatibility.js";
import { readSandboxCapabilities, type SandboxRunnerPort } from "../runtime/tool-dispatch/execution-profile.js";
import type { RuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import type { RuntimeToolDescriptorRegistry } from "../runtime/tool-dispatch/runtime-tool-descriptor.js";
import type { ToolDispatchScheduler } from "../runtime/tool-dispatch/scheduler.js";
import type { SecretBrokerPort } from "../runtime/tool-dispatch/secret-broker.js";
import { createExecutionCompositionRoot, type ExecutionCompositionRoot, type ExecutionCompositionRootDependencies } from "./execution-composition-root.js";
import type { AuthoritativeIncidentProjection } from "./incident-query.js";

export interface RuntimeCompositionServices<Output> {
  identity: ExecutionCompositionRootDependencies<Output>["createCorrelation"];
  persistence: AdapterCheckpointStore;
  policy: Pick<AuthorizationEngine, "authorize">;
  providers: LlmGateway;
  toolRegistry: RuntimeToolDescriptorRegistry;
  sandbox: SandboxRunnerPort;
  secretBroker: SecretBrokerPort;
  scheduling: ToolDispatchScheduler;
  dispatchPipeline: RuntimeToolDispatchPipeline;
  sequenceAllocator: RunSequenceAllocator;
  eventPublication: AuthoritativeIncidentProjection;
  usage: ExecutionCompositionRootDependencies<Output>["collectEvidence"];
}

type ExecutionOptions<Output> = Omit<ExecutionCompositionRootDependencies<Output>,
  "createCorrelation" | "dispatchPipeline" | "sequenceAllocator" | "incidentProjection" | "collectEvidence">;

export interface RuntimeCompositionCandidate<Output> {
  versions: RuntimeVersionSet;
  services: RuntimeCompositionServices<Output>;
  execution: ExecutionOptions<Output>;
  adapters: readonly ((services: Readonly<RuntimeCompositionServices<Output>>, signal: AbortSignal) => Promise<unknown>)[];
}

export interface RuntimeCompositionSnapshot<Output> {
  readonly services: Readonly<RuntimeCompositionServices<Output>>;
  readonly execution: ExecutionCompositionRoot<Output>;
  adapter(adapterId: string): FrameworkAdapterPort | undefined;
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return value !== null && typeof value === "object"
    && methods.every((method) => method in value && typeof Reflect.get(value, method) === "function");
}

function validateServices<Output>(value: RuntimeCompositionServices<Output>): void {
  if (!value || typeof value.identity !== "function" || typeof value.usage !== "function"
    || !hasMethods(value.persistence, ["read", "append"])
    || !hasMethods(value.policy, ["authorize"])
    || !hasMethods(value.providers, ["createChatModel", "createChatModelWithFallback"])
    || !hasMethods(value.toolRegistry, ["resolve"])
    || !hasMethods(value.sandbox, ["capabilities", "run"])
    || !hasMethods(value.secretBroker, ["resolve"])
    || !hasMethods(value.scheduling, ["schedule"])
    || !hasMethods(value.dispatchPipeline, ["createExecutor", "hasCompensation", "compensate"])
    || !(value.sequenceAllocator instanceof RunSequenceAllocator)
    || !hasMethods(value.eventPublication, ["recordAuthoritative", "rebuild"])) {
    throw new FrameworkAdapterError("COMPOSITION_DEPENDENCY_UNAVAILABLE");
  }
  const capabilities = readSandboxCapabilities(value.sandbox);
  if (!capabilities?.executionModes.includes("isolated_process")
    || !capabilities.supportsProcessIsolation || !capabilities.supportsFilesystemIsolation
    || !capabilities.supportsEgressIsolation || !capabilities.supportsResourceLimits) {
    throw new FrameworkAdapterError("COMPOSITION_DEPENDENCY_UNAVAILABLE");
  }
}

export class RuntimeComposition<Output> {
  private snapshot: RuntimeCompositionSnapshot<Output> | undefined;
  private installing = false;
  private readonly supportedVersions: RuntimeVersionSet[];

  constructor(supportedVersions: readonly RuntimeVersionSet[]) {
    this.supportedVersions = z.array(runtimeVersionSetSchema).parse(supportedVersions);
  }

  current(): RuntimeCompositionSnapshot<Output> | undefined {
    return this.snapshot;
  }

  async install(
    initialize: (signal: AbortSignal) => Promise<RuntimeCompositionCandidate<Output>>,
    options: BoundedOperationOptions,
  ): Promise<void> {
    if (this.installing) throw new FrameworkAdapterError("COMPOSITION_BUSY");
    this.installing = true;
    try {
      const staged = await runBoundedAdapterOperation(async (signal) => {
        const candidate = await initialize(signal);
        signal.throwIfAborted();
        validateServices(candidate.services);
        if (!Array.isArray(candidate.adapters) || candidate.adapters.length === 0 || candidate.adapters.some((load) => typeof load !== "function")) {
          throw new FrameworkAdapterError("COMPOSITION_DEPENDENCY_UNAVAILABLE");
        }
        const versions = runtimeVersionSetSchema.safeParse(candidate.versions);
        if (!versions.success || evaluateRuntimeVersionCompatibility({ observed: versions.data, supported: this.supportedVersions }).status !== "compatible") {
          throw new FrameworkAdapterError("COMPOSITION_VERSION_UNSUPPORTED");
        }
        const services = Object.freeze({ ...candidate.services });
        const execution = createExecutionCompositionRoot({
          ...candidate.execution,
          createCorrelation: services.identity,
          dispatchPipeline: services.dispatchPipeline,
          sequenceAllocator: services.sequenceAllocator,
          incidentProjection: services.eventPublication,
          collectEvidence: services.usage,
        });
        const registry = new FrameworkAdapterRegistry();
        await registry.register(candidate.adapters.map((load) => (initializationSignal) => load(services, initializationSignal)), { signal, timeoutMs: options.timeoutMs });
        signal.throwIfAborted();
        return Object.freeze({ services, execution: Object.freeze(execution), adapter: (adapterId: string) => registry.get(adapterId) });
      }, options);
      if (options.signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
      this.snapshot = staged;
    } finally {
      this.installing = false;
    }
  }
}
