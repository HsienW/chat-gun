import { readShoppingAssistantModelSettings } from "../../agents/shopping-assistant/model-settings.js";
import { getConfiguredLlmCapabilities, getEffectiveLlmEndpoint, llmGateway, resolveModelForPurpose, supportsConfiguredThinkingControl } from "../../platform/llm-gateway.js";
import { createGenerationObserver } from "../generation-provenance.js";

/** Kept in evaluation; the production settings reader remains owned by Group B. */
export function createCommerceGenerationModels(model: string) {
  // The settings reader rejects any thinking value other than unset/false before a model is built.
  const settings = readShoppingAssistantModelSettings();
  // D-9: fails before any model is built or any result is written when the endpoint is invalid.
  const { provider, endpointHost: llmEndpointHost } = getEffectiveLlmEndpoint();
  const observer = createGenerationObserver({
    generationModels: { chat: resolveModelForPurpose("chat", model), tool: resolveModelForPurpose("tool", model) },
    llmProvider: provider,
    llmEndpointHost,
    thinkingEnabled: supportsConfiguredThinkingControl() ? false : null,
  });
  const jsonFormat = getConfiguredLlmCapabilities("chat").supportsStructuredOutput ? { responseFormat: { type: "json_object" as const } } : {};
  const common = { model, temperature: settings.temperature, thinkingEnabled: false };
  return {
    settings,
    observer,
    chatModel: () => observer.wrap(llmGateway.createChatModel({ purpose: "chat", ...common, ...jsonFormat })),
    toolModel: () => observer.wrap(llmGateway.createChatModel({ purpose: "tool", ...common })),
  };
}
