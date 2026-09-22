import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";

import { getGovernedToolExecutor } from "../../platform/tool-governance.js";
import {
  readExecutionContext,
  withExecutionContext,
} from "../execution-context/read-execution-context.js";
import type { GovernedToolOutcome } from "../side-effect/governed-outcome.js";
import {
  confirmationRequiredDescriptorSchema,
  parseConfirmationResume,
  toConfirmationInterruptPayload,
  type AuthorizationConfirmationStore,
  type ConfirmationRequiredDescriptor,
} from "./confirmation.js";

export interface AuthorizationGraphToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export interface AuthorizationGraphState {
  messages: unknown[];
  toolQueue: AuthorizationGraphToolCall[];
  activeToolCall?: AuthorizationGraphToolCall | null;
  pendingAuthorization?: ConfirmationRequiredDescriptor | null;
}

export interface CreateToolAuthorizationGraphNodesInput {
  tools: readonly StructuredToolInterface[];
  confirmationStore: AuthorizationConfirmationStore;
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
  return outcome.errorCode;
}

function toolMessage(
  call: AuthorizationGraphToolCall,
  content: unknown
): ToolMessage {
  return new ToolMessage({
    name: call.toolName,
    tool_call_id: call.toolCallId,
    content:
      typeof content === "string" ? content : JSON.stringify(content ?? null),
  });
}

function executionConfig(
  config: RunnableConfig,
  call: AuthorizationGraphToolCall
): RunnableConfig {
  const context = readExecutionContext(undefined, config, "production");
  const compatibleConfig: Record<string, unknown> = { ...config };
  const enriched = withExecutionContext(compatibleConfig, {
    ...context,
    toolCallId: call.toolCallId,
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
      await input.confirmationStore.upsertPending(descriptor);
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
      activeToolCall: call,
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

    const resume = parseConfirmationResume(
      interrupt(toConfirmationInterruptPayload(descriptor))
    );
    const context = readExecutionContext(undefined, config, "production");
    const consumed = await input.confirmationStore.consume({
      descriptor,
      resume,
      executionContext: { ...context, toolCallId: call.toolCallId },
    });
    if (!consumed.ok || consumed.status !== "approved") {
      return {
        messages: [
          toolMessage(call, {
            errorCode: consumed.ok
              ? "CONFIRMATION_CANCELLED"
              : consumed.reasonCode,
          }),
        ],
        activeToolCall: null,
        pendingAuthorization: null,
      };
    }
    return { activeToolCall: call, pendingAuthorization: null };
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
      executionConfig(config, call)
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
