import { z } from "zod";
import type { ProviderEnvelopeKind } from "../provider-envelope.js";

const count = z.number().int().nonnegative().safe().optional();
const usageEnvelope = z.object({ usage: z.object({
  prompt_tokens: count, completion_tokens: count, input_tokens: count, output_tokens: count, total_tokens: count,
}).passthrough().optional() }).passthrough();

export function tokenUsageFromBody(body: unknown, endpointKind: ProviderEnvelopeKind | "total-tokens") {
  const parsed = usageEnvelope.safeParse(body);
  const usage = parsed.success ? parsed.data.usage : undefined;
  if (endpointKind === "total-tokens") {
    return { inputTokens: usage?.total_tokens ?? null, outputTokens: usage?.total_tokens === undefined ? null : 0 };
  }
  return endpointKind === "anthropic-messages"
    ? { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null }
    : { inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null };
}

export function tokenUsageFromText(text: string, endpointKind: ProviderEnvelopeKind, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { inputTokens: null, outputTokens: null };
  try { return tokenUsageFromBody(JSON.parse(text), endpointKind); }
  catch { return { inputTokens: null, outputTokens: null }; }
}
