import { z } from "zod";

import { assembleFromItems, type AssembledContext } from "../context/context-assembler.js";
import { ContextPriority, type ContextItem } from "../context/context-budget.js";
import type { PrincipalContext } from "../runtime/authorization/principal.js";
import type { RuntimeScope } from "../runtime/authorization/scope.js";
import {
  projectExecutionEventContext,
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from "../runtime/event-envelope.js";
import { RunSequenceAllocator, stableEventId } from "../runtime/event-sequence.js";
import {
  readExecutionContext,
  withExecutionContext,
} from "../runtime/execution-context/read-execution-context.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { readNormalizedAgentInput } from "../runtime/input/read-normalized-agent-input.js";
import type { NormalizedAgentInput } from "../runtime/input/normalized-agent-input.js";
import {
  isRunTerminalStatus,
  type RunStatus,
} from "../runtime/run-status.js";
import type {
  GovernedToolExecutor,
  GovernedToolOutcome,
} from "../runtime/side-effect/governed-outcome.js";
import type { RuntimeToolDispatchPipeline } from "../runtime/tool-dispatch/pipeline.js";
import type { StructuredToolResultEnvelope } from "../runtime/tool-dispatch/structured-tool-result.js";
import { getIncidentProjectionIndex } from "./incident-query.js";
import { executionManifestSchema, type ExecutionManifest } from "./types.js";

export const EXECUTION_COMPOSITION_STAGES = [
  "x12",
  "x17",
  "x18",
  "x14",
  "x19",
  "x20",
] as const;

export type ExecutionCompositionStage =
  (typeof EXECUTION_COMPOSITION_STAGES)[number];

export interface CanonicalExecutionRequest {
  executionManifest: ExecutionManifest;
  principal: PrincipalContext;
  input: NormalizedAgentInput;
  scope: RuntimeScope;
}

export interface ExecutionCorrelationSeed {
  requestId: string;
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  toolCallId: string;
  toolExecutionId?: string;
  parentRunId?: string;
  agentId?: string;
  attempt: number;
}

export interface ExecutionEvidence {
  auditRef?: string;
  otelTraceRef?: string;
  duplicateEffectCount: number;
  correlatedSliRef?: string;
  stages: readonly ExecutionCompositionStage[];
}

export interface RunExecutionEventPayload {
  normalizedInputKind: NormalizedAgentInput["kind"];
  toolName: string;
  dispatchOutcomeType: string;
  governedContextExceeded: boolean;
}

export type RunExecutionEvent = RuntimeEventEnvelope<
  "run.execution",
  RunExecutionEventPayload
>;

export interface CanonicalExecutionResult<TOutput = unknown> {
  runId: string;
  terminal: RunStatus;
  output: TOutput;
  evidence: ExecutionEvidence;
  executionEvent: RunExecutionEvent;
}

export interface SelectedExecutionTool {
  toolName: string;
  input: unknown;
  sourceExecutor: GovernedToolExecutor<unknown, unknown>;
}

export interface ExecutionRecoveryResult<TOutput> {
  terminal: RunStatus;
  output: TOutput;
}

export interface ExecutionCompositionRootDependencies<TOutput> {
  createCorrelation(
    request: Pick<CanonicalExecutionRequest, "executionManifest">
  ): ExecutionCorrelationSeed;
  dispatchPipeline: Pick<RuntimeToolDispatchPipeline, "createExecutor">;
  selectTool(input: {
    context: ExecutionContext;
    normalizedInput: NormalizedAgentInput;
    governedContext: AssembledContext;
    executionManifest: ExecutionManifest;
  }): SelectedExecutionTool;
  recovery: {
    recover(input: {
      context: ExecutionContext;
      executionManifest: ExecutionManifest;
      dispatchOutcome: GovernedToolOutcome<StructuredToolResultEnvelope>;
      executionEvent: RunExecutionEvent;
    }): Promise<ExecutionRecoveryResult<TOutput>>;
  };
  outputSchema: z.ZodType<TOutput>;
  collectEvidence(input: {
    context: ExecutionContext;
    executionManifest: ExecutionManifest;
    dispatchOutcome: GovernedToolOutcome<StructuredToolResultEnvelope>;
    recovery: ExecutionRecoveryResult<TOutput>;
  }): Promise<Omit<ExecutionEvidence, "stages">> | Omit<ExecutionEvidence, "stages">;
  createEventId?: () => string;
  sequenceAllocator?: RunSequenceAllocator;
  now?: () => Date;
}

export interface ExecutionCompositionRoot<TOutput> {
  execute(input: unknown): Promise<CanonicalExecutionResult<TOutput>>;
}

const canonicalExecutionRequestEnvelopeSchema = z
  .object({
    executionManifest: executionManifestSchema,
    principal: z.unknown(),
    input: z.unknown(),
    scope: z.unknown(),
  })
  .strict();

const evidenceSchema = z
  .object({
    auditRef: z.string().trim().min(1).optional(),
    otelTraceRef: z.string().trim().min(1).optional(),
    duplicateEffectCount: z.number().int().nonnegative(),
    correlatedSliRef: z.string().trim().min(1).optional(),
  })
  .strict();

export class ExecutionCompositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExecutionCompositionError";
  }
}

function requireDependencies<TOutput>(
  dependencies: ExecutionCompositionRootDependencies<TOutput>
): void {
  if (
    typeof dependencies.createCorrelation !== "function" ||
    typeof dependencies.dispatchPipeline?.createExecutor !== "function" ||
    typeof dependencies.selectTool !== "function" ||
    typeof dependencies.recovery?.recover !== "function" ||
    typeof dependencies.outputSchema?.parse !== "function" ||
    typeof dependencies.collectEvidence !== "function"
  ) {
    throw new ExecutionCompositionError("EXECUTION_COMPOSITION_DEPENDENCY_UNAVAILABLE");
  }
}

function createGovernedContextItems(
  normalizedInput: NormalizedAgentInput
): ContextItem[] {
  const content =
    normalizedInput.kind === "prompt"
      ? normalizedInput.text
      : JSON.stringify(normalizedInput);
  return [
    {
      priority: ContextPriority.P1,
      label: "normalized_input",
      content,
    },
  ];
}

function createContext(
  rawRequest: z.infer<typeof canonicalExecutionRequestEnvelopeSchema>,
  correlation: ExecutionCorrelationSeed
): ExecutionContext {
  return readExecutionContext(
    rawRequest.input,
    {
      configurable: {
        execution_context: {
          ...correlation,
          principal: rawRequest.principal,
          scope: rawRequest.scope,
        },
      },
    },
    "production"
  );
}

function createExecutionEvent(input: {
  context: ExecutionContext;
  normalizedInput: NormalizedAgentInput;
  governedContext: AssembledContext;
  selectedTool: SelectedExecutionTool;
  dispatchOutcome: GovernedToolOutcome<StructuredToolResultEnvelope>;
  sequenceAllocator: RunSequenceAllocator;
  createEventId?: () => string;
  emittedAt: string;
}): RunExecutionEvent {
  const event: RunExecutionEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: stableEventId(undefined, input.createEventId),
    sequence: input.sequenceAllocator.next(input.context.runId),
    type: "run.execution",
    emittedAt: input.emittedAt,
    context: projectExecutionEventContext(input.context),
    payload: {
      normalizedInputKind: input.normalizedInput.kind,
      toolName: input.selectedTool.toolName,
      dispatchOutcomeType: input.dispatchOutcome.type,
      governedContextExceeded: input.governedContext.exceeded,
    },
  };
  runtimeEventEnvelopeSchema.parse(event);
  return event;
}

export function createExecutionCompositionRoot<TOutput>(
  dependencies: ExecutionCompositionRootDependencies<TOutput>
): ExecutionCompositionRoot<TOutput> {
  requireDependencies(dependencies);
  const sequenceAllocator =
    dependencies.sequenceAllocator ?? new RunSequenceAllocator();
  const now = dependencies.now ?? (() => new Date());

  return {
    async execute(inputValue) {
      const rawRequest = canonicalExecutionRequestEnvelopeSchema.parse(inputValue);
      const context = createContext(
        rawRequest,
        dependencies.createCorrelation({
          executionManifest: rawRequest.executionManifest,
        })
      );
      const normalized = readNormalizedAgentInput(rawRequest.input);
      if (normalized.status !== "valid") {
        throw new ExecutionCompositionError(
          `INVALID_NORMALIZED_INPUT:${normalized.errorCode}`
        );
      }
      const governedContext = assembleFromItems(
        createGovernedContextItems(normalized.input)
      );
      const selectedTool = dependencies.selectTool({
        context,
        normalizedInput: normalized.input,
        governedContext,
        executionManifest: rawRequest.executionManifest,
      });
      const executor = dependencies.dispatchPipeline.createExecutor(
        selectedTool.toolName,
        selectedTool.sourceExecutor
      );
      const dispatchOutcome = await executor.executeTyped(
        selectedTool.input,
        withExecutionContext({}, context)
      );
      const executionEvent = createExecutionEvent({
        context,
        normalizedInput: normalized.input,
        governedContext,
        selectedTool,
        dispatchOutcome,
        sequenceAllocator,
        createEventId: dependencies.createEventId,
        emittedAt: now().toISOString(),
      });
      const recovery = await dependencies.recovery.recover({
        context,
        executionManifest: rawRequest.executionManifest,
        dispatchOutcome,
        executionEvent,
      });
      const output = dependencies.outputSchema.parse(recovery.output);
      const evidence = evidenceSchema.parse(
        await dependencies.collectEvidence({
          context,
          executionManifest: rawRequest.executionManifest,
          dispatchOutcome,
          recovery,
        })
      );
      if (isRunTerminalStatus(recovery.terminal)) {
        sequenceAllocator.release(context.runId);
      }
      getIncidentProjectionIndex().record({
        schemaVersion: "1.0",
        runId: context.runId,
        events: [
          {
            eventId: executionEvent.eventId,
            sequence: executionEvent.sequence,
            type: executionEvent.type,
            emittedAt: executionEvent.emittedAt,
            taskId: executionEvent.context.taskId,
            ...(executionEvent.context.stepId
              ? { stepId: executionEvent.context.stepId }
              : {}),
            ...(executionEvent.context.toolCallId
              ? { toolCallId: executionEvent.context.toolCallId }
              : {}),
          },
        ],
        audit: evidence.auditRef ? [{ reference: evidence.auditRef }] : [],
        traces: evidence.otelTraceRef
          ? [{ reference: evidence.otelTraceRef }]
          : [],
        toolExecutions: [
          { toolName: selectedTool.toolName, outcome: dispatchOutcome.type },
        ],
        terminalResult: { status: recovery.terminal },
      });
      return {
        runId: context.runId,
        terminal: recovery.terminal,
        output,
        evidence: {
          ...evidence,
          stages: EXECUTION_COMPOSITION_STAGES,
        },
        executionEvent,
      };
    },
  };
}
