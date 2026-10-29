import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";

import { getGovernedToolExecutor } from "../../platform/tool-governance.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import {
  readExecutionContext,
  withExecutionContext,
} from "../execution-context/read-execution-context.js";
import { createToolDispatchStepId } from "../execution-context/tool-call-context.js";
import type { GovernedToolOutcome } from "../side-effect/governed-outcome.js";
import {
  createConfirmationInterruptId,
  createConfirmationInterruptManifest,
} from "../recovery/confirmation-manifest.js";
import { classifyExecutionManifestCompatibility } from "../recovery/execution-manifest.js";
import type { ExecutionManifestRef } from "../recovery/interrupt-manifest.js";
import type { InterruptManifestRepository } from "../recovery/interrupt-manifest-repository.js";
import { redactCheckpointUpdate } from "../persistence/checkpoint-redaction.js";
import {
  confirmationRequiredDescriptorSchema,
  parseConfirmationResume,
  toConfirmationInterruptPayload,
  type AuthorizationConfirmationStore,
  type AuthorizationConfirmationWithdrawalStore,
  type ConfirmationConsumeResult,
  type ConfirmationAuditSink,
  type ConfirmationRequiredDescriptor,
} from "./confirmation.js";

export type ConfirmationOutcome = "denied" | "expired" | "withdrawn";

export interface ConfirmationOutcomeRecord {
  toolCallId: string;
  outcome: ConfirmationOutcome;
}

export interface AuthorizationGraphToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
  /**
   * Set only by the gate or confirmation node from a server-side authorization
   * decision; never derived from model output.
   */
  authorizationDecisionId?: string;
}

export interface AuthorizationGraphState {
  messages: unknown[];
  toolQueue: AuthorizationGraphToolCall[];
  activeToolCall?: AuthorizationGraphToolCall | null;
  pendingAuthorization?: ConfirmationRequiredDescriptor | null;
  /** Written only when `confirmationOutcome` is enabled; graphs without the option never see it. */
  confirmationOutcome?: ConfirmationOutcomeRecord | null;
}

export interface CreateToolAuthorizationGraphNodesInput {
  tools: readonly StructuredToolInterface[];
  confirmationStore: AuthorizationConfirmationStore;
  confirmationAudit?: ConfirmationAuditSink;
  interruptManifestRepository: InterruptManifestRepository;
  executionManifest: ExecutionManifestRef;
  /**
   * Opt-in machine-readable confirmation outcome. Disabled by default so existing
   * graphs keep their tool message content byte-for-byte.
   */
  confirmationOutcome?: {
    statusReader: Pick<AuthorizationConfirmationWithdrawalStore, "findStatus">;
  };
  /**
   * Opt-in record written before the approval exists. When it fails, no
   * approval or interrupt is created and the call ends with `unavailableErrorCode`.
   */
  confirmationRequestRecorder?: ConfirmationRequestRecorder;
}

export interface ConfirmationRequestRecorder {
  record(input: {
    descriptor: ConfirmationRequiredDescriptor;
    call: AuthorizationGraphToolCall;
    executionContext: ExecutionContext;
  }): Promise<void>;
  unavailableErrorCode: string;
}

/** Maps a non-approved consume result to an outcome without parsing error strings. */
export async function resolveConfirmationOutcome(
  consumed: ConfirmationConsumeResult,
  descriptor: ConfirmationRequiredDescriptor,
  statusReader: Pick<AuthorizationConfirmationWithdrawalStore, "findStatus">
): Promise<ConfirmationOutcome | undefined> {
  if (consumed.ok) return consumed.status === "denied" ? "denied" : undefined;
  if (consumed.reasonCode === "CONFIRMATION_TIMEOUT") return "expired";
  if (consumed.reasonCode !== "CONFIRMATION_REPLAYED_OR_EXPIRED") return undefined;
  const current = await statusReader
    .findStatus({
      approvalId: descriptor.approvalId,
      decisionId: descriptor.decisionId,
    })
    .catch(() => null);
  if (!current) return undefined;
  if (current.withdrawn) return "withdrawn";
  if (current.status === "expired") return "expired";
  return current.status === "denied" ? "denied" : undefined;
}

function withAuthorizationDecision(
  call: AuthorizationGraphToolCall,
  decisionId: string | undefined
): AuthorizationGraphToolCall {
  const { authorizationDecisionId: _ignored, ...base } = call;
  return decisionId === undefined
    ? base
    : { ...base, authorizationDecisionId: decisionId };
}

function extractToolCalls(messages: readonly unknown[]): AuthorizationGraphToolCall[] {
  const lastMessage = messages.at(-1);
  if (lastMessage === null || typeof lastMessage !== "object") return [];
  const calls = (lastMessage as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const call = candidate as { id?: unknown; name?: unknown; args?: unknown };
    return typeof call.id === "string" && typeof call.name === "string"
      ? [{ toolName: call.name, toolCallId: call.id, input: call.args ?? {} }]
      : [];
  });
}

function errorCode(outcome: GovernedToolOutcome<unknown>): string {
  if (outcome.type === "succeeded") return "";
  if (outcome.type === "cancelled") return "TOOL_EXECUTION_CANCELLED";
  if (outcome.type === "confirmation_required") return "REQUIRES_CONFIRMATION";
  if (outcome.type === "deduplicated") return "SIDE_EFFECT_CLAIM_NOT_ACQUIRED";
  return outcome.errorCode;
}

function toolMessage(
  call: AuthorizationGraphToolCall,
  content: unknown
): ToolMessage {
  const redactedContent = redactCheckpointUpdate(content);
  return new ToolMessage({
    name: call.toolName,
    tool_call_id: call.toolCallId,
    content:
      typeof redactedContent === "string"
        ? redactedContent
        : JSON.stringify(redactedContent ?? null),
  });
}

function executionConfig(
  config: RunnableConfig,
  call: AuthorizationGraphToolCall,
  options: { dispatchStep?: boolean } = {}
): RunnableConfig {
  const context = readExecutionContext(undefined, config, "production");
  const compatibleConfig: Record<string, unknown> = { ...config };
  // Only dispatch gets a step: the gate leaves it unset so the approval and its
  // manifest never point at a step the dispatch has not created (design §6.16).
  const enriched = withExecutionContext(compatibleConfig, {
    ...context,
    toolCallId: call.toolCallId,
    ...(options.dispatchStep
      ? {
          stepId: createToolDispatchStepId({
            taskId: context.taskId,
            nodeName: "physical_dispatch",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            input: call.input,
          }),
        }
      : {}),
  });
  if (
    enriched.configurable === null ||
    typeof enriched.configurable !== "object" ||
    Array.isArray(enriched.configurable)
  ) {
    throw new Error("Execution context adapter returned invalid configurable state");
  }
  return { ...config, configurable: { ...enriched.configurable } };
}

export function createToolAuthorizationGraphNodes(
  input: CreateToolAuthorizationGraphNodesInput
) {
  const toolByName = new Map(input.tools.map((tool) => [tool.name, tool]));

  async function authorizationGate(
    state: AuthorizationGraphState,
    config: RunnableConfig
  ): Promise<Partial<AuthorizationGraphState>> {
    const queue =
      state.toolQueue.length > 0
        ? state.toolQueue
        : extractToolCalls(state.messages);
    const [call, ...remaining] = queue;
    if (call === undefined) {
      return {
        toolQueue: [],
        activeToolCall: null,
        pendingAuthorization: null,
      };
    }
    const tool = toolByName.get(call.toolName);
    const executor = tool ? getGovernedToolExecutor(tool) : null;
    if (executor?.authorizeTyped === undefined) {
      return {
        messages: [toolMessage(call, { errorCode: "AUTHORIZATION_UNAVAILABLE" })],
        toolQueue: remaining,
        activeToolCall: null,
        pendingAuthorization: null,
      };
    }
    const outcome = await executor.authorizeTyped(
      call.input,
      executionConfig(config, call)
    );
    if (outcome.type === "confirmation_required") {
      const descriptor = confirmationRequiredDescriptorSchema.parse(
        outcome.descriptor
      );
      const recorder = input.confirmationRequestRecorder;
      if (recorder !== undefined) {
        try {
          await recorder.record({
            descriptor,
            call,
            executionContext: readExecutionContext(undefined, config, "production"),
          });
        } catch {
          return {
            messages: [toolMessage(call, { errorCode: recorder.unavailableErrorCode })],
            toolQueue: remaining,
            activeToolCall: null,
            pendingAuthorization: null,
          };
        }
      }
      await input.confirmationStore.upsertPending(descriptor);
      await input.interruptManifestRepository.create(
        createConfirmationInterruptManifest({
          descriptor,
          executionManifest: input.executionManifest,
        })
      );
      return {
        toolQueue: remaining,
        activeToolCall: call,
        pendingAuthorization: descriptor,
      };
    }
    if (outcome.type === "denied_by_authorization") {
      return {
        messages: [toolMessage(call, { errorCode: outcome.errorCode })],
        toolQueue: remaining,
        activeToolCall: null,
        pendingAuthorization: null,
      };
    }
    return {
      toolQueue: remaining,
      activeToolCall: withAuthorizationDecision(call, outcome.decisionId),
      pendingAuthorization: null,
    };
  }

  async function authorizationConfirmation(
    state: AuthorizationGraphState,
    config: RunnableConfig
  ): Promise<Partial<AuthorizationGraphState>> {
    const descriptor = confirmationRequiredDescriptorSchema.parse(
      state.pendingAuthorization
    );
    const call = state.activeToolCall;
    if (!call) throw new Error("Confirmation state is missing its tool call");

    const interruptId = createConfirmationInterruptId(descriptor);
    const manifest = await input.interruptManifestRepository.findByInterruptId(
      interruptId
    );
    if (
      !manifest ||
      manifest.kind !== "confirmation" ||
      manifest.interruptId !== interruptId ||
      manifest.threadId !== descriptor.threadId ||
      manifest.runId !== descriptor.runId ||
      manifest.taskId !== descriptor.taskId ||
      manifest.stepId !== descriptor.stepId ||
      manifest.scopeId !== descriptor.scope.scopeId ||
      manifest.expectedResponseSchemaRef !==
        "tool_authorization_confirmation@1.0" ||
      manifest.decisionRef.decisionId !== descriptor.decisionId ||
      manifest.decisionRef.approvalId !== descriptor.approvalId ||
      classifyExecutionManifestCompatibility(
        manifest.executionManifest,
        input.executionManifest
      ) !== "compatible"
    ) {
      throw new Error("Confirmation interrupt manifest is unavailable or incompatible");
    }

    const context = readExecutionContext(undefined, config, "production");
    const rejectionCode = manifest.status !== "waiting"
      ? "CONFIRMATION_REPLAYED_OR_EXPIRED"
      : context.threadId !== descriptor.threadId
        ? "CONFIRMATION_BINDING_MISMATCH"
        : undefined;
    let consumed: ConfirmationConsumeResult;
    if (rejectionCode !== undefined) {
      // Isolate both synchronous and asynchronous sink failures from rejection.
      await Promise.resolve().then(() => input.confirmationAudit?.record(
        "authorization.confirmation.rejected",
        {
          decisionId: descriptor.decisionId,
          reasonCode: rejectionCode,
          waitingRunId: descriptor.runId,
          resumeRunId: context.runId,
        }
      )).catch(() => undefined);
      consumed = { ok: false, reasonCode: rejectionCode };
    } else {
      const resume = parseConfirmationResume(
        interrupt(toConfirmationInterruptPayload(descriptor))
      );
      consumed = await input.confirmationStore.consume({
        descriptor,
        resume,
        executionContext: { ...context, toolCallId: call.toolCallId },
      });
    }
    if (!consumed.ok || consumed.status !== "approved") {
      if (consumed.ok && consumed.status === "denied") {
        await input.interruptManifestRepository.transitionStatus({
          interruptId,
          expectedStatus: "waiting",
          nextStatus: "rejected",
        });
      } else if (!consumed.ok && consumed.reasonCode === "CONFIRMATION_TIMEOUT") {
        await input.interruptManifestRepository.transitionStatus({
          interruptId,
          expectedStatus: "waiting",
          nextStatus: "expired",
        });
      }
      const errorCode = consumed.ok ? "CONFIRMATION_CANCELLED" : consumed.reasonCode;
      const outcome = input.confirmationOutcome
        ? await resolveConfirmationOutcome(
            consumed,
            descriptor,
            input.confirmationOutcome.statusReader
          )
        : undefined;
      if (outcome === undefined) {
        return {
          messages: [toolMessage(call, { errorCode })],
          activeToolCall: null,
          pendingAuthorization: null,
        };
      }
      return {
        messages: [toolMessage(call, { errorCode, confirmationOutcome: outcome })],
        activeToolCall: null,
        pendingAuthorization: null,
        confirmationOutcome: { toolCallId: call.toolCallId, outcome },
      };
    }
    await input.interruptManifestRepository.transitionStatus({
      interruptId,
      expectedStatus: "waiting",
      nextStatus: "resumed",
    });
    return {
      activeToolCall: withAuthorizationDecision(call, descriptor.decisionId),
      pendingAuthorization: null,
    };
  }

  async function physicalDispatch(
    state: AuthorizationGraphState,
    config: RunnableConfig
  ): Promise<Partial<AuthorizationGraphState>> {
    const call = state.activeToolCall;
    if (!call) throw new Error("Physical dispatch is missing its tool call");
    const tool = toolByName.get(call.toolName);
    const executor = tool ? getGovernedToolExecutor(tool) : null;
    if (executor?.executeAuthorizedTyped === undefined) {
      return {
        messages: [toolMessage(call, { errorCode: "AUTHORIZATION_UNAVAILABLE" })],
        activeToolCall: null,
      };
    }
    const outcome = await executor.executeAuthorizedTyped(
      call.input,
      executionConfig(config, call, { dispatchStep: true }),
      call.authorizationDecisionId === undefined
        ? undefined
        : { decisionId: call.authorizationDecisionId }
    );
    return {
      messages: [
        toolMessage(
          call,
          outcome.type === "succeeded"
            ? outcome.result
            : { errorCode: errorCode(outcome) }
        ),
      ],
      activeToolCall: null,
    };
  }

  return { authorizationGate, authorizationConfirmation, physicalDispatch };
}

export function routeAfterAuthorizationGate(
  state: AuthorizationGraphState
): "confirmation" | "dispatch" | "gate" | "model" {
  if (state.pendingAuthorization) return "confirmation";
  if (state.activeToolCall) return "dispatch";
  return state.toolQueue.length > 0 ? "gate" : "model";
}

export function routeAfterAuthorizationConfirmation(
  state: AuthorizationGraphState
): "dispatch" | "gate" | "model" {
  if (state.activeToolCall) return "dispatch";
  return state.toolQueue.length > 0 ? "gate" : "model";
}

export function routeAfterPhysicalDispatch(
  state: AuthorizationGraphState
): "gate" | "model" {
  return state.toolQueue.length > 0 ? "gate" : "model";
}
