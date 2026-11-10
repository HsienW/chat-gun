import "dotenv/config";
import { createOperationsHttpApp } from "./operations/http-app.js";
import { projectRuntimeHealth } from "./operations/metrics/health.js";
import { configureChatModelDefaults, configureUsageModelValidator, enabledChatModels, supportsConfiguredThinkingControl } from "./platform/llm-gateway.js";
import { getUsageRuntime } from "./platform/usage/runtime.js";
import { readKnowledgeConfig } from "./knowledge/config.js";
import { readShoppingAssistantModelSettings } from "./agents/shopping-assistant/model-settings.js";
import { validateDemoBackend } from "./demo/profile.js";
import { validateMonetaryBudgetConfiguration } from "./platform/usage/budget-configuration.js";

const flag = process.env.DEMO_ENABLED;
if (flag !== undefined && !["true", "false"].includes(flag)) throw new Error("invalid_configuration:DEMO_ENABLED");
const usage = getUsageRuntime(); // Validate generic configuration before listening, including outside Demo.
const shop = readShoppingAssistantModelSettings();
const knowledge = readKnowledgeConfig();
const models = [
  ...enabledChatModels([
    { purpose: "chat", model: process.env.CHAT_MODEL }, { purpose: "math" }, { purpose: "research" }, { purpose: "vision" }, { purpose: "tool" },
    { purpose: "chat", model: shop.model }, { purpose: "tool", model: shop.model },
  ]),
  { provider: "qwen", model: knowledge.embeddingModel, callKind: "embedding" as const },
  ...(knowledge.rerankUrl ? [{ provider: "qwen", model: knowledge.rerankModel, callKind: "rerank" as const }] : []),
];
if (flag === "true") {
  validateDemoBackend(process.env, usage.isShared, usage.prices, models, supportsConfiguredThinkingControl());
  configureUsageModelValidator(model => validateMonetaryBudgetConfiguration(usage.isShared, usage.prices, [model]));
  configureChatModelDefaults({ thinkingEnabled: process.env.CHAT_THINKING_ENABLED === "true" });
}
// Initialize the empty shared ledger before the first admission can read it.
if (usage.isShared) await usage.ready();

export const operationsHttpApp = createOperationsHttpApp({
  ...(flag === "true" ? { acceptNewWorkCheck: () => usage.ready() } : {}),
  healthProbe: () => projectRuntimeHealth({ observedAt: new Date().toISOString(), stuckRunAfterMs: 1, heartbeatStaleAfterMs: 1, processAlive: true }),
  usageMetadata: async () => {
    let pricesComplete = true;
    try { validateMonetaryBudgetConfiguration(usage.isShared, usage.prices, models); }
    catch { pricesComplete = false; }
    return { ...usage.metadata, shared: usage.isShared, pricesComplete, ready: await usage.ready() };
  },
});
