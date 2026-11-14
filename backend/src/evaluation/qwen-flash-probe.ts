import { z } from "zod";
import { endpointHost } from "./generation-provenance.js";

const CAPABILITIES = ["text", "json_object", "tool_calling", "vision", "thinking_off"] as const;
type ProbeCapability = (typeof CAPABILITIES)[number];
type ProbeErrorCode = "provider_error" | "timeout" | "schema_invalid" | "unsupported" | "cancelled" | "missing_credentials" | "disabled" | "invalid_configuration";
export interface ProbeResult {
  capability: ProbeCapability;
  status: "passed" | "failed" | "not_executed";
  errorCode?: ProbeErrorCode;
}
export interface QwenFlashProbeSettings {
  isEnabled?: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
// Synthetic 1×1 PNG; no external image host or personal information.
const SYNTHETIC_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const answerSchema = z.object({ ok: z.literal(true) }).strict();
const envelopeSchema = z.object({
  choices: z.array(z.object({ message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  }) })).min(1),
  usage: z.object({ completion_tokens_details: z.object({ reasoning_tokens: z.number().nonnegative().optional() }).optional() }).optional(),
});

function requestBody(capability: ProbeCapability, model: string) {
  const content = capability === "vision"
    ? [{ type: "text", text: "Describe the image in one word." }, { type: "image_url", image_url: { url: SYNTHETIC_IMAGE } }]
    : capability === "json_object" ? 'Return JSON exactly: {"ok":true}' : "Reply with ok.";
  return {
    model, enable_thinking: false, max_tokens: 128,
    messages: [{ role: "user", content }],
    ...(capability === "json_object" ? { response_format: { type: "json_object" } } : {}),
    ...(capability === "tool_calling" ? {
      tools: [{ type: "function", function: { name: "probe_echo", description: "Return the probe result.", parameters: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } } }],
      tool_choice: { type: "function", function: { name: "probe_echo" } },
    } : {}),
  };
}

function validateProbeResponse(capability: ProbeCapability, payload: unknown): boolean {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return false;
  const message = parsed.data.choices[0]!.message;
  if (capability === "tool_calling") {
    const call = message.tool_calls?.[0];
    return call?.function.name === "probe_echo" && answerSchema.safeParse(JSON.parse(call.function.arguments)).success;
  }
  if (capability === "json_object") return answerSchema.safeParse(JSON.parse(message.content ?? "")).success;
  if (!message.content?.trim()) return false;
  return capability !== "thinking_off" || (parsed.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0) === 0;
}

/** Returns only classifications. Never returns provider bodies, headers, keys or full URLs. */
export async function runQwenFlashProbe(settings: QwenFlashProbeSettings, fetcher: typeof fetch = fetch) {
  let host = "";
  let url: URL | undefined;
  try {
    host = endpointHost(settings.endpoint);
    url = new URL(settings.endpoint);
    if (url.protocol !== "https:" || url.username || url.password) url = undefined;
    if (url) url.pathname = `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
  } catch { /* Invalid operator configuration is reported without echoing it. */ }
  const timeoutMs = settings.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const preflight: ProbeErrorCode | undefined = !settings.isEnabled ? "disabled" : !settings.apiKey.trim() ? "missing_credentials" : !url || !settings.model.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ? "invalid_configuration" : undefined;
  const results: ProbeResult[] = [];
  for (const capability of CAPABILITIES) {
    const skip = preflight ?? (settings.signal?.aborted ? "cancelled" : undefined);
    if (skip) { results.push({ capability, status: "not_executed", errorCode: skip }); continue; }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = settings.signal ? AbortSignal.any([settings.signal, timeout.signal]) : timeout.signal;
    try {
      const response = await fetcher(url!, {
        method: "POST", signal, redirect: "error",
        headers: { "content-type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify(requestBody(capability, settings.model)),
      });
      if (!response.ok) {
        results.push({ capability, status: "failed", errorCode: [400, 404, 422, 501].includes(response.status) ? "unsupported" : "provider_error" });
      } else {
        let isValid = false;
        try { isValid = validateProbeResponse(capability, await response.json()); } catch (error) {
          if (signal.aborted) throw error;
        }
        results.push({ capability, status: isValid ? "passed" : "failed", ...(!isValid ? { errorCode: "schema_invalid" as const } : {}) });
      }
    } catch {
      results.push(settings.signal?.aborted
        ? { capability, status: "not_executed", errorCode: "cancelled" }
        : { capability, status: "failed", errorCode: timeout.signal.aborted ? "timeout" : "provider_error" });
    } finally { clearTimeout(timer); }
  }
  return { endpointHost: host, model: settings.model, date: new Date().toISOString(), results };
}
