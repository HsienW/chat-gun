import { z } from "zod";
import type { ChatModelInvoker } from "../platform/llm-gateway.js";

/** Optional only at the persisted boundary, so pre-migration runs remain readable. */
export const generationProvenanceSchema = z.object({
  generationModels: z.record(z.string()).optional(),
  observedProviderModels: z.array(z.string()).optional(),
  observedProviderModelsStatus: z.enum(["reported", "unreported", "partial"]).optional(),
  thinkingEnabled: z.boolean().nullable().optional(),
  llmProvider: z.string().optional(),
  llmEndpointHost: z.string().optional(),
});
export type GenerationProvenance = z.infer<typeof generationProvenanceSchema>;
/** Reads only `provider_model` (D-8); `model` may be gateway-filled and is never observed. */
const observationMetadataSchema = z.object({
  provider_model: z.string().nullable().optional(),
  thinking_enabled: z.boolean().nullable().optional(),
}).passthrough();

export interface GenerationObservationSettings {
  generationModels: Record<string, string>;
  llmProvider: string;
  /** Effective endpoint host from the gateway's read-only lookup (D-9). */
  llmEndpointHost: string;
  thinkingEnabled: boolean | null;
}

export function endpointHost(endpoint: string): string {
  if (!endpoint) return "";
  try { return new URL(endpoint).hostname; } catch { throw new Error("invalid_configuration:LLM_ENDPOINT"); }
}

/** Evaluation-local decorator: no mutation of messages, invocation options or graph output. */
export function createGenerationObserver(settings: GenerationObservationSettings) {
  if (!settings.llmEndpointHost) throw new Error("invalid_configuration:LLM_ENDPOINT");
  const llmEndpointHost = settings.llmEndpointHost;
  const observedModels = new Set<string>();
  let reportedResponses = 0;
  let unreportedResponses = 0;
  let thinkingEnabled = settings.thinkingEnabled;
  const wrap = (delegate: ChatModelInvoker): ChatModelInvoker => ({
    invoke: async (input, options) => {
      const response = await delegate.invoke(input, options);
      const parsed = observationMetadataSchema.safeParse(response.response_metadata);
      const reported = parsed.success ? parsed.data.provider_model?.trim() : undefined;
      // A missing provider_model field counts as not reported.
      if (reported) {
        observedModels.add(reported);
        reportedResponses++;
      } else {
        unreportedResponses++;
      }
      if (parsed.success && parsed.data.thinking_enabled !== undefined) thinkingEnabled = parsed.data.thinking_enabled;
      return response;
    },
    ...(delegate.bindTools ? { bindTools: (tools, kwargs) => wrap(delegate.bindTools!(tools, kwargs)) } : {}),
  });
  return {
    wrap,
    snapshot: () => ({
      generationModels: { ...settings.generationModels },
      observedProviderModels: [...observedModels].sort(),
      observedProviderModelsStatus: reportedResponses === 0
        ? "unreported" as const
        : unreportedResponses === 0 ? "reported" as const : "partial" as const,
      thinkingEnabled,
      llmProvider: settings.llmProvider,
      llmEndpointHost,
    }),
  };
}

export function renderGenerationSummary(provenance: GenerationProvenance): string {
  return `- 生成模型：${provenance.generationModels ? JSON.stringify(provenance.generationModels) : "未記錄"}；thinking=${provenance.thinkingEnabled === undefined ? "未記錄" : String(provenance.thinkingEnabled)}；endpoint=${provenance.llmEndpointHost ?? "未記錄"}`;
}
