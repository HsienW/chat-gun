/**
 * D3 live gate: one session runs a product lookup and then a policy question
 * against the real knowledge store and models, and checks that the policy
 * citations resolve to that turn's evidence only.
 *
 * Usage: npx tsx scripts/commerce/d3-live-smoke.ts --out <evidence json path>
 * Prerequisites: KNOWLEDGE_DATABASE_URL with kb-v1 ingested for synthetic-tenant,
 * the kb_search grant (scripts/commerce/grant-d3-kb-search.ts) and a valid model key.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import "dotenv/config";

import { HumanMessage, isAIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";

import { createShoppingAssistantGraph } from "../../src/agents/shopping-assistant/graph.js";
import { LlmShoppingIntentRouter } from "../../src/agents/shopping-assistant/intent-router.js";
import { LlmPolicyAnswerSynthesizer } from "../../src/agents/shopping-assistant/policy-answer.js";
import { readKbSearchOutcome } from "../../src/agents/shopping-assistant/product-results.js";
import { verifyAnswerCitations } from "../../src/knowledge/citation-verification.js";
import { readKnowledgeConfig } from "../../src/knowledge/config.js";
import { describeLlmGatewayConfig, getConfiguredLlmCapabilities, llmGateway } from "../../src/platform/llm-gateway.js";
import { parseRuntimeEventEnvelope } from "../../src/runtime/event-envelope.js";
import { NoopStepLock } from "../../src/runtime/lock/step-lock.js";
import { MockOrderProvider } from "../../src/tools/orders/mock-order-provider.js";
import { loadSyntheticOrderFixture } from "../../src/tools/orders/synthetic-orders.js";
import { loadShoppingAssistantToolRuntime } from "../../src/tools/registry.js";

// kb_search receives its model credential only through execution profile enforcement.
process.env.TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED ??= "true";

const outArgument = process.argv.indexOf("--out");
const outPath = outArgument === -1 ? undefined : process.argv[outArgument + 1];
if (outPath === undefined) throw new Error("--out <path> is required");

const TURNS = [
  { input: "有推薦適合運動戴的耳機嗎？", expectedIntent: "product_lookup" },
  { input: "退貨的期限是幾天？Plus 會員的期限有比較長嗎？", expectedIntent: "policy_question" },
] as const;
const FALLBACK_REPLIES = new Set([
  "目前暫時無法處理您的請求，請稍後再試。",
  "知識庫沒有涵蓋這個問題，我無法提供答案。",
  "目前無法回答這個問題，請稍後再試。",
  "目前無法提供經驗證的答案。",
]);

const sessionId = randomUUID();
const threadId = `d3-live-${sessionId}`;
function executionContext(runId: string) {
  return {
    requestId: `request-${runId}`,
    threadId,
    runId,
    taskId: `task-${runId}`,
    stepId: `step-${runId}`,
    attempt: 1,
    principal: {
      principalId: "synthetic-shopper-a",
      principalType: "user" as const,
      tenantId: "synthetic-tenant",
      roles: [],
      scopes: [],
      authSource: "development" as const,
      authenticatedAt: new Date().toISOString(),
    },
    scope: { scopeId: "synthetic-tenant", scopeType: "tenant" as const, tenantId: "synthetic-tenant" },
  };
}

const model = process.env.SHOPPING_ASSISTANT_MODEL?.trim() || undefined;
const temperature = Number(process.env.SHOPPING_ASSISTANT_TEMPERATURE ?? 0);
const capabilities = getConfiguredLlmCapabilities("chat");
const jsonFormat = capabilities.supportsStructuredOutput ? { responseFormat: { type: "json_object" as const } } : {};
const audits: { eventName: string; payload: Record<string, unknown> }[] = [];

const runtime = await loadShoppingAssistantToolRuntime({
  orderProvider: new MockOrderProvider({ fixture: await loadSyntheticOrderFixture() }),
  statusReader: { read: async () => { throw new Error("status reader is not used by D3"); } },
  // A single host process: Redis is not reachable from the host, and cross-instance
  // step exclusivity is not what this gate verifies.
  dispatchPipelineDependencies: { stepLock: new NoopStepLock() },
});
const intentRouter = new LlmShoppingIntentRouter({
  timeoutMs: 30_000,
  createModel: () => llmGateway.createChatModel({ purpose: "chat", model, temperature, ...jsonFormat }),
});
const policyAnswerSynthesizer = new LlmPolicyAnswerSynthesizer(() =>
  llmGateway.createChatModel({ purpose: "chat", model, temperature, ...jsonFormat })
);
const graph = createShoppingAssistantGraph(
  {
    tools: runtime.tools,
    confirmationStore: runtime.confirmationStore,
    interruptManifestRepository: runtime.interruptManifestRepository,
    intentRouter,
    createProductRequestModel: () => llmGateway.createChatModel({ purpose: "tool", model, temperature }),
    policyAnswerSynthesizer,
    audit: async (eventName, payload) => {
      audits.push({ eventName, payload });
    },
  },
  { checkpointer: new MemorySaver() }
);

function turnMessages(messages: readonly BaseMessage[], from: number) {
  return messages.slice(from);
}

const turns = [];
let seen = 0;
for (const [index, turn] of TURNS.entries()) {
  const runId = `${threadId}-run-${index + 1}`;
  const startedAt = Date.now();
  const state = await graph.invoke(
    { messages: [new HumanMessage(turn.input)] },
    { configurable: { thread_id: threadId, execution_context: executionContext(runId) } }
  );
  const messages = turnMessages(state.messages, seen);
  seen = state.messages.length;
  const request = messages.find((message) => isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0);
  const toolCall = request && isAIMessage(request) ? request.tool_calls?.[0] : undefined;
  const outcome = toolCall?.id ? readKbSearchOutcome(messages, toolCall.id) : undefined;
  const reply = String(messages.at(-1)?.content ?? "");
  const verification = outcome?.kind === "evidence_found" ? verifyAnswerCitations(reply, [outcome.result]) : undefined;
  turns.push({
    turn: index + 1,
    runId,
    input: turn.input,
    expectedIntent: turn.expectedIntent,
    route: state.turn,
    kbSearch: toolCall ? { args: toolCall.args, outcome: outcome?.kind, errorCode: outcome?.kind === "failed" ? outcome.errorCode : undefined } : null,
    toolMessages: messages.filter((message) => isToolMessage(message)).length,
    evidenceSourceIds: outcome?.kind === "evidence_found" ? [...new Set(outcome.result.citations.map((c) => c.sourceId))] : [],
    cards: state.runtimeEvents.map((event) => {
      const envelope = parseRuntimeEventEnvelope(event);
      return { sequence: envelope.sequence, eventId: envelope.eventId, payload: envelope.payload };
    }),
    reply,
    citationVerification: verification ?? null,
    turnEvidence: state.turnEvidence,
    durationMs: Date.now() - startedAt,
  });
}

const [product, policy] = turns;
const checks = {
  productRoutedCorrectly: product?.route?.routedIntent === "product_lookup",
  productCardsEmitted: (product?.cards.length ?? 0) > 0,
  policyRoutedCorrectly: policy?.route?.routedIntent === "policy_question",
  policyAnswered:
    policy?.route?.routedIntent === "policy_question" && !FALLBACK_REPLIES.has(policy.reply),
  policyCitationsVerified: policy?.citationVerification?.status === "verified",
  noCrossTurnCitation:
    policy?.citationVerification?.cited.every((citationId) =>
      policy.turnEvidence?.citations.some((entry) => entry.citationId === citationId)
    ) ?? false,
  policyEvidenceFromPolicySources:
    (policy?.evidenceSourceIds.length ?? 0) > 0 &&
    (policy?.evidenceSourceIds.every((sourceId) => !(product?.evidenceSourceIds ?? []).includes(sourceId)) ?? false),
};
const knowledge = readKnowledgeConfig();
const gateway = describeLlmGatewayConfig();
const result = {
  schemaVersion: "d3_live_smoke@1",
  changeId: "commerce-assistant-and-approved-side-effects",
  executedAt: new Date().toISOString(),
  kind: "live",
  provenance: {
    llmProvider: gateway.provider,
    model: model ?? "gateway purpose default (chat for routing and policy answer, tool for kb_request)",
    temperature,
    structuredOutput: capabilities.supportsStructuredOutput,
    prompts: {
      routing: intentRouter.promptVersion,
      policyAnswer: policyAnswerSynthesizer.promptVersion,
      kbRequest: ["shopping-product-request-v1", "shopping-policy-request-v1"],
    },
    embeddingModel: knowledge.embeddingModel,
    rerankConfigured: Boolean(knowledge.rerankUrl),
    corpus: "kb-v1 (synthetic)",
    tenantId: "synthetic-tenant",
    principalId: "synthetic-shopper-a",
    checkpointer: "MemorySaver (single process session)",
    stepLock: "NoopStepLock (single host process; Redis step lock not exercised)",
    executionProfileEnforcement: process.env.TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED,
  },
  turns,
  checks,
  passed: Object.values(checks).every(Boolean),
  audits,
};

const target = resolve(outPath);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: result.passed, checks, out: target }));
process.exit(0);
