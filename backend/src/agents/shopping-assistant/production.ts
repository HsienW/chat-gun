import { getEnv } from "../../platform/env.js";
import {
  applyInteractionGovernance,
  productionInteractionOrchestrator,
} from "../../platform/interaction-runtime.js";
import { getConfiguredLlmCapabilities, llmGateway } from "../../platform/llm-gateway.js";
import { auditLogger } from "../../platform/observability.js";
import { instrumentGraphWithOpik } from "../../platform/tracing/opik/opik-graph.js";
import { getRuntimeIdentityStatusInstrumentation } from "../../runtime/authorization/identity-status-composition.js";
import { instrumentGraphWithExecutionContext } from "../../runtime/execution-context/instrument-graph.js";
import {
  readDevelopmentExecutionContext,
  readExecutionContext,
} from "../../runtime/execution-context/read-execution-context.js";
import { MockOrderProvider } from "../../tools/orders/mock-order-provider.js";
import type { OrderOperationStatusReader } from "../../tools/orders/order-tools.js";
import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { loadShoppingAssistantToolRuntime } from "../../tools/registry.js";
import { createShoppingAssistantGraph, SHOPPING_ASSISTANT_GRAPH_ID } from "./graph.js";
import { LlmShoppingIntentRouter } from "./intent-router.js";

const DEFAULT_INTENT_TIMEOUT_MS = 20_000;

function readIntentTimeoutMs(): number {
  const raw = getEnv("SHOPPING_INTENT_TIMEOUT_MS").trim();
  if (raw.length === 0) return DEFAULT_INTENT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) {
    throw new Error("Invalid SHOPPING_INTENT_TIMEOUT_MS");
  }
  return value;
}

function readTemperature(): number {
  const raw = getEnv("SHOPPING_ASSISTANT_TEMPERATURE").trim();
  const value = raw.length === 0 ? 0 : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("Invalid SHOPPING_ASSISTANT_TEMPERATURE");
  }
  return value;
}

/**
 * The status reader over ledger, approvals and reconciliation tasks arrives
 * with the status lookup task; until then a lookup fails closed as an
 * unavailable store, never as "not found".
 */
const unavailableStatusReader: OrderOperationStatusReader = {
  read: async () => {
    throw new Error("Order operation status reader is unavailable");
  },
};

const model = getEnv("SHOPPING_ASSISTANT_MODEL").trim() || undefined;
const temperature = readTemperature();
// Structured output is chosen by declared capability, never by model name.
const routingCapabilities = getConfiguredLlmCapabilities("chat");

const runtime = await loadShoppingAssistantToolRuntime({
  orderProvider: new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() }),
  statusReader: unavailableStatusReader,
});

const graph = createShoppingAssistantGraph({
  tools: runtime.tools,
  confirmationStore: runtime.confirmationStore,
  interruptManifestRepository: runtime.interruptManifestRepository,
  intentRouter: new LlmShoppingIntentRouter({
    timeoutMs: readIntentTimeoutMs(),
    createModel: () =>
      llmGateway.createChatModel({
        purpose: "chat",
        model,
        temperature,
        ...(routingCapabilities.supportsStructuredOutput
          ? { responseFormat: { type: "json_object" as const } }
          : {}),
      }),
  }),
  createProductRequestModel: () =>
    llmGateway.createChatModel({ purpose: "tool", model, temperature }),
  audit: (eventName, payload, context) => auditLogger.record(eventName, payload, context),
});

function resolveShoppingExecutionContext(input: unknown, config: unknown) {
  return getEnv("TOOL_AUTHORIZATION_PROFILE", "production") === "development"
    ? readDevelopmentExecutionContext(input, config)
    : readExecutionContext(input, config, "production");
}

export const shoppingAssistantGraph = instrumentGraphWithExecutionContext(
  applyInteractionGovernance(
    instrumentGraphWithOpik(graph, SHOPPING_ASSISTANT_GRAPH_ID),
    productionInteractionOrchestrator
  ),
  resolveShoppingExecutionContext,
  getRuntimeIdentityStatusInstrumentation(),
);
