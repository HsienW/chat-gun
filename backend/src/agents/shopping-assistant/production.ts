import {
  applyInteractionGovernance,
  createProductionInteractionOrchestrator,
} from "../../platform/interaction-runtime.js";
import { getConfiguredLlmCapabilities, llmGateway } from "../../platform/llm-gateway.js";
import { auditLogger } from "../../platform/observability.js";
import { instrumentGraphWithOpik } from "../../platform/tracing/opik/opik-graph.js";
import { getRuntimeIdentityStatusInstrumentation } from "../../runtime/authorization/identity-status-composition.js";
import { instrumentGraphWithExecutionContext } from "../../runtime/execution-context/instrument-graph.js";
import { getPool } from "../../runtime/persistence/connection.js";
import { PgInterruptManifestRepository } from "../../runtime/recovery/interrupt-manifest-repository.js";
import { MockOrderProvider } from "../../tools/orders/mock-order-provider.js";
import type { OrderOperationStatusReader } from "../../tools/orders/order-tools.js";
import { loadSyntheticOrderFixture } from "../../tools/orders/synthetic-orders.js";
import { loadShoppingAssistantToolRuntime } from "../../tools/registry.js";
import { createDispatchReadinessCheck } from "./dispatch-readiness.js";
import { createShoppingAssistantEntryResolver } from "./entry.js";
import { createShoppingAssistantGraph, SHOPPING_ASSISTANT_GRAPH_ID } from "./graph.js";
import { LlmShoppingIntentRouter } from "./intent-router.js";
import { readShoppingAssistantModelSettings } from "./model-settings.js";
import { PgOrderOperationRequestStore, unavailableOrderOperationRequestStore } from "./operation-requests.js";
import { PgOrderOperationStatusReader } from "./operation-status.js";
import { PgOriginalOperationResolver, unresolvableOriginalOperation } from "./original-operation.js";
import { LlmPolicyAnswerSynthesizer } from "./policy-answer.js";

const { model, temperature, intentTimeoutMs } = readShoppingAssistantModelSettings();
// Structured output is chosen by declared capability, never by model name.
const routingCapabilities = getConfiguredLlmCapabilities("chat");

const pool = getPool();

const originalOperationResolver = pool ? new PgOriginalOperationResolver(pool) : unresolvableOriginalOperation;

/** Without a runtime database a lookup fails closed as an unavailable store, never as "not found". */
const statusReader: OrderOperationStatusReader = pool
  ? new PgOrderOperationStatusReader(pool, { originalOperationResolver })
  : {
      read: async () => {
        throw new Error("Order operation status reader is unavailable");
      },
    };

const runtime = await loadShoppingAssistantToolRuntime({
  orderProvider: new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() }),
  statusReader,
});

const graph = createShoppingAssistantGraph({
  tools: runtime.tools,
  confirmationStore: runtime.confirmationStore,
  interruptManifestRepository: runtime.interruptManifestRepository,
  intentRouter: new LlmShoppingIntentRouter({
    timeoutMs: intentTimeoutMs,
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
  createOrderRequestModel: () =>
    llmGateway.createChatModel({ purpose: "tool", model, temperature }),
  checkDispatchReadiness: createDispatchReadinessCheck(pool),
  confirmationWithdrawal: runtime.confirmationWithdrawal,
  originalOperationResolver,
  operationRequests: pool ? new PgOrderOperationRequestStore(pool) : unavailableOrderOperationRequestStore,
  policyAnswerSynthesizer: new LlmPolicyAnswerSynthesizer(() =>
    llmGateway.createChatModel({
      purpose: "chat",
      model,
      temperature,
      ...(routingCapabilities.supportsStructuredOutput
        ? { responseFormat: { type: "json_object" as const } }
        : {}),
    })
  ),
  audit: (eventName, payload, context) => auditLogger.record(eventName, payload, context),
});

const confirmationManifests = pool ? new PgInterruptManifestRepository(pool) : undefined;

/**
 * Only this graph routes a cancel input with no active run to the graph when
 * the thread waits on a tool confirmation, so the approval can be withdrawn
 * (design §6.2 step 1); other graphs keep NOTHING_TO_CANCEL.
 */
const interactionOrchestrator = createProductionInteractionOrchestrator(
  confirmationManifests
    ? {
        isWaitingToolConfirmation: async (input) =>
          (await confirmationManifests.findWaitingConfirmationByThread(input)) !== null,
      }
    : {}
);

export const shoppingAssistantGraph = instrumentGraphWithExecutionContext(
  applyInteractionGovernance(
    instrumentGraphWithOpik(graph, SHOPPING_ASSISTANT_GRAPH_ID),
    interactionOrchestrator
  ),
  createShoppingAssistantEntryResolver(graph),
  getRuntimeIdentityStatusInstrumentation(),
);
