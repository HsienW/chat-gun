import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { UsageMetadata } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { getEnv } from "./env.js";
import { createErrorEnvelope, formatErrorEnvelope } from "./errors.js";
import {
  decodeJsonText,
  type JsonDecodeOptions,
  type JsonDecodeResult,
} from "./json-decode.js";
import { configureNetwork } from "./network.js";
import {
  FallbackChatModelInvoker,
  type ModelFallbackPolicy,
} from "./llm-fallback.js";
import { getAgentRuntimeConfig } from "./runtime-config.js";
import { getSpanManager } from "./tracing/span-manager.js";
import { getOpikTracer } from "./tracing/opik/opik-tracer.js";
import { auditLogger, recordMetric } from "./observability.js";
import {
  ProviderEnvelopeValidationError,
  validateProviderEnvelope,
  type AnthropicMessagesEnvelope,
  type OpenAiChatCompletionEnvelope,
  type ProviderEnvelopeKind,
} from "./provider-envelope.js";
import {
  repairStructuredOutput,
  StructuredOutputExhaustedError,
  StructuredOutputRefusalError,
} from "./structured-output-repair.js";
import type { RepairStrategy } from "./llm-fallback.js";

configureNetwork();

export type ModelPurpose = "chat" | "math" | "research" | "vision" | "tool";

export type ChatResponseFormat = {
  type: "json_object";
};

export interface ChatModelOptions {
  model?: string;
  purpose?: ModelPurpose;
  temperature?: number;
  maxRetries?: number;
  responseFormat?: ChatResponseFormat;
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

type ChatModelInput = unknown;
type ChatModelOutput = BaseMessage;

export type ChatModelInvokeOptions = {
  signal?: AbortSignal;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolCallId?: string;
};

export interface ChatModelInvoker {
  invoke(
    input: ChatModelInput,
    options?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput>;
  bindTools?: (
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ) => ChatModelInvoker;
}

export interface LlmGateway {
  createChatModel(options?: ChatModelOptions): ChatModelInvoker;
  createChatModelWithFallback(
    options?: ChatModelOptions,
    fallbackPolicy?: Partial<ModelFallbackPolicy>
  ): ChatModelInvoker;
}

interface ProviderGateway {
  createChatModel(options?: ChatModelOptions): ChatModelInvoker;
}

class TracedChatModelInvoker implements ChatModelInvoker {
  constructor(
    private readonly delegate: ChatModelInvoker,
    private readonly provider: LlmProviderName,
    private readonly model: string
  ) {}

  bindTools(
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ): ChatModelInvoker {
    if (!this.delegate.bindTools) {
      throw new Error(`Provider ${this.provider} does not support tool binding.`);
    }
    return new TracedChatModelInvoker(
      this.delegate.bindTools(tools, kwargs),
      this.provider,
      this.model
    );
  }

  invoke(
    input: ChatModelInput,
    options?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput> {
    return getSpanManager().withSpan(
      "llm.call",
      {
        attributes: {
          "model.name": this.model,
          "model.provider": this.provider,
          ...(options?.taskId ? { "task.id": options.taskId } : {}),
          ...(options?.stepId ? { "step.id": options.stepId } : {}),
        },
      },
      () =>
        getOpikTracer().withLlmSpan(
          {
            modelName: this.model,
            providerName: this.provider,
            ...(options?.stepId ? { stepId: options.stepId } : {}),
          },
          () => this.delegate.invoke(input, options),
          input
        )
    );
  }
}

class ModelCallMetricInvoker implements ChatModelInvoker {
  constructor(
    private readonly delegate: ChatModelInvoker,
    private readonly provider: LlmProviderName
  ) {}

  bindTools(
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ): ChatModelInvoker {
    if (!this.delegate.bindTools) {
      throw new Error(`Provider ${this.provider} does not support tool binding.`);
    }
    return new ModelCallMetricInvoker(
      this.delegate.bindTools(tools, kwargs),
      this.provider
    );
  }

  async invoke(
    input: ChatModelInput,
    options?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput> {
    await recordMetric("model.call", {
      callId: crypto.randomUUID(),
      provider: this.provider,
    });
    return this.delegate.invoke(input, options);
  }
}

const JSON_OBJECT_SCHEMA = z.object({}).passthrough();

function appendStructuredOutputHint(input: ChatModelInput, hint?: string): ChatModelInput {
  if (!hint) return input;
  const instruction = [
    "The previous response was not a valid JSON object.",
    `Validation hint: ${hint}`,
    "Return only one valid JSON object without markdown.",
  ].join("\n");
  return Array.isArray(input)
    ? [...input, { role: "user", content: instruction }]
    : typeof input === "string"
      ? `${input}\n\n${instruction}`
      : [input, { role: "user", content: instruction }];
}

class StructuredOutputRepairChatModelInvoker implements ChatModelInvoker {
  constructor(
    private readonly delegate: ChatModelInvoker,
    private readonly strategy: RepairStrategy
  ) {}

  bindTools(
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ): ChatModelInvoker {
    if (!this.delegate.bindTools) {
      throw new Error("Structured output provider does not support tool binding.");
    }
    return new StructuredOutputRepairChatModelInvoker(
      this.delegate.bindTools(tools, kwargs),
      this.strategy
    );
  }

  async invoke(
    input: ChatModelInput,
    options?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput> {
    let lastResponse: BaseMessage | undefined;
    const result = await repairStructuredOutput({
      invoke: async (hint) => {
        lastResponse = await this.delegate.invoke(
          appendStructuredOutputHint(input, hint),
          options
        );
        return lastResponse;
      },
      schema: JSON_OBJECT_SCHEMA,
      strategy: this.strategy,
    });

    if (result.status === "refusal") {
      throw new StructuredOutputRefusalError();
    }
    if (!result.output) {
      throw new StructuredOutputExhaustedError(result.lastError);
    }

    return new AIMessage({
      content: JSON.stringify(result.output),
      usage_metadata:
        lastResponse instanceof AIMessage
          ? lastResponse.usage_metadata
          : undefined,
      response_metadata: {
        ...lastResponse?.response_metadata,
        structured_output_status: result.status,
        structured_output_attempts: result.attempts,
      },
    });
  }
}

export type LlmProviderName = "ccr" | "openai-compatible" | "qwen";
export type LlmEndpointKind = ProviderEnvelopeKind;

export type LlmCapabilities = {
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsUsageMetadata: boolean;
};

type LlmResponseDiagnostics = {
  provider: LlmProviderName;
  endpointKind: LlmEndpointKind;
  responseContentLength: number;
  jsonParseFailureCode?: "llm_response_json_parse_failed";
  decodeKind?: Exclude<JsonDecodeResult<unknown>["status"], "valid">;
  errorCode?: string;
  byteLength?: number;
  rawHash?: string;
};

type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
};

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string | { url?: string } };

type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

type OpenAiToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type OpenAiChatCompletionResponse = OpenAiChatCompletionEnvelope;

type AnthropicContentBlock = {
  type: "text";
  text: string;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicMessagesResponse = AnthropicMessagesEnvelope;

class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly provider: LlmProviderName,
    readonly endpointKind: LlmEndpointKind,
    readonly responseContentLength: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export class ProviderResponseParseError extends Error {
  readonly code = "llm_response_json_parse_failed";

  constructor(
    message: string,
    readonly provider: LlmProviderName,
    readonly endpointKind: LlmEndpointKind,
    readonly responseContentLength: number,
    readonly decodeKind: Exclude<JsonDecodeResult<unknown>["status"], "valid">,
    readonly errorCode: string,
    readonly byteLength: number,
    readonly rawHash?: string
  ) {
    super(message);
    this.name = "ProviderResponseParseError";
  }
}

function responseDiagnostics(
  provider: LlmProviderName,
  endpointKind: LlmEndpointKind,
  responseText: string,
  jsonParseFailureCode?: LlmResponseDiagnostics["jsonParseFailureCode"],
  decodeResult?: Exclude<JsonDecodeResult<unknown>, { status: "valid" }>
): LlmResponseDiagnostics {
  return {
    provider,
    endpointKind,
    responseContentLength: responseText.length,
    ...(jsonParseFailureCode ? { jsonParseFailureCode } : {}),
    ...(decodeResult
      ? {
          decodeKind: decodeResult.status,
          errorCode:
            decodeResult.status === "aborted"
              ? "JSON_DECODE_ABORTED"
              : decodeResult.errorCode,
          ...(decodeResult.status === "aborted"
            ? {}
            : { byteLength: decodeResult.byteLength }),
          ...(decodeResult.status === "incomplete" || decodeResult.status === "invalid"
            ? { rawHash: decodeResult.rawHash }
            : {}),
        }
      : {}),
  };
}

function formatResponseDiagnostics(diagnostics: LlmResponseDiagnostics): string {
  return JSON.stringify(diagnostics);
}

function parseJsonResponse<T>(
  responseText: string,
  provider: LlmProviderName,
  endpointKind: LlmEndpointKind,
  options: JsonDecodeOptions
): T {
  const decoded = decodeJsonText<T>(responseText, options);
  if (decoded.status === "valid") {
    return decoded.value;
  }

  const diagnostics = responseDiagnostics(
    provider,
    endpointKind,
    responseText,
    "llm_response_json_parse_failed",
    decoded
  );
  throw new ProviderResponseParseError(
    `LLM gateway response JSON parse failed: ${formatResponseDiagnostics(diagnostics)}`,
    provider,
    endpointKind,
    responseText.length,
    decoded.status,
    decoded.status === "aborted" ? "JSON_DECODE_ABORTED" : decoded.errorCode,
    decoded.status === "aborted" ? 0 : decoded.byteLength,
    decoded.status === "incomplete" || decoded.status === "invalid"
      ? decoded.rawHash
      : undefined
  );
}

function endpointKindForProvider(provider: LlmProviderName): LlmEndpointKind {
  if (provider === "ccr") {
    return "anthropic-messages";
  }
  return "openai-chat-completions";
}

function capabilitiesForProvider(provider: LlmProviderName, purpose: ModelPurpose): LlmCapabilities {
  if (provider === "ccr") {
    return {
      supportsStructuredOutput: false,
      supportsToolCalling: false,
      supportsVision: false,
      supportsStreaming: false,
      supportsUsageMetadata: false,
    };
  }

  return {
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    supportsVision: purpose === "vision",
    supportsStreaming: false,
    supportsUsageMetadata: true,
  };
}

function assertProviderCapability(
  capabilities: LlmCapabilities,
  provider: LlmProviderName,
  endpointKind: LlmEndpointKind,
  capability: keyof Pick<LlmCapabilities, "supportsStructuredOutput" | "supportsToolCalling">
): void {
  if (capabilities[capability]) {
    return;
  }

  throw new Error(
    `Provider ${provider} endpoint ${endpointKind} does not support ${capability}.`
  );
}

function getFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = getEnv(name).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function getOpenAiCompatibleBaseUrl(): string {
  return getFirstEnv([
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_BASE_URL",
    "CCR_BASE_URL",
  ]);
}

function getOpenAiCompatibleApiKey(): string {
  return getFirstEnv([
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_API_KEY",
    "CCR_API_KEY",
  ]);
}

function getQwenBaseUrl(): string {
  return getEnv("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").trim();
}

function getQwenApiKey(): string {
  return getEnv("QWEN_API_KEY").trim();
}

function getLegacyPurposeModel(purpose: ModelPurpose): string {
  switch (purpose) {
    case "chat":
      return getFirstEnv(["CHAT_MODEL", "DEFAULT_MODEL"]);
    case "math":
      return getFirstEnv(["MATH_MODEL", "CHAT_MODEL", "DEFAULT_MODEL"]);
    case "research":
    case "vision":
      return getEnv("DEFAULT_MODEL").trim();
    case "tool":
      return getFirstEnv(["MCP_AGENT_MODEL", "CHAT_MODEL", "DEFAULT_MODEL"]);
  }
}

function resolveQwenModel(purpose: ModelPurpose, requestedModel: string | undefined): string {
  const requested = requestedModel?.trim();
  if (requested) {
    return requested;
  }

  const qwenPurposeModel =
    purpose === "research"
      ? getFirstEnv(["QWEN_RESEARCH_MODEL", "QWEN_CHAT_MODEL"])
      : purpose === "vision"
        ? getEnv("QWEN_VISION_MODEL").trim()
        : purpose === "tool"
          ? getFirstEnv(["QWEN_TOOL_MODEL", "QWEN_CHAT_MODEL"])
          : getEnv("QWEN_CHAT_MODEL").trim();

  const fallback =
    purpose === "vision"
      ? "qwen-vl-plus"
      : "qwen-plus";

  return qwenPurposeModel || getLegacyPurposeModel(purpose) || fallback;
}

function getOpenAiCompatibleModel(requestedModel: string | undefined, purpose: ModelPurpose): string {
  const configuredModel = getFirstEnv([
    "OPENAI_COMPATIBLE_MODEL",
    "OPENAI_MODEL",
    "CCR_MODEL",
    ...(
      purpose === "tool"
        ? ["MCP_AGENT_MODEL"]
        : purpose === "math"
          ? ["MATH_MODEL"]
          : purpose === "chat"
            ? ["CHAT_MODEL"]
            : []
    ),
    "DEFAULT_MODEL",
  ]);
  const requested = requestedModel?.trim();

  if (requested) {
    return requested;
  }

  return configuredModel || requested || "gpt-4o-mini";
}

function resolveProviderModel(
  provider: LlmProviderName,
  purpose: ModelPurpose,
  requestedModel: string | undefined
): string {
  const requested = requestedModel?.trim();
  if (provider === "qwen") {
    return resolveQwenModel(purpose, requested);
  }
  if (provider === "openai-compatible") {
    return getOpenAiCompatibleModel(requested, purpose);
  }
  if (provider === "ccr") {
    return getCcrModel(requested);
  }
  return resolveQwenModel(purpose, requested);
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function getCcrBaseUrl(): string {
  return getEnv("CCR_BASE_URL").trim();
}

function getCcrApiKey(): string {
  return getEnv("CCR_API_KEY").trim();
}

function getCcrProvider(): string {
  return getEnv("CCR_PROVIDER", "deepseek").trim();
}

function getCcrModel(requestedModel: string | undefined): string {
  const configuredModel = getEnv("CCR_MODEL").trim();
  const requested = requestedModel?.trim();
  const model = configuredModel || requested || "deepseek-v4-flash";

  if (model.includes(",")) {
    return model;
  }

  const provider = getCcrProvider();
  return provider ? `${provider},${model}` : model;
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/messages")) {
    return `${trimmed}?beta=true`;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/messages?beta=true`;
  }
  return `${trimmed}/v1/messages?beta=true`;
}

function roleForMessage(message: BaseMessage | { role?: unknown }): OpenAiChatMessage["role"] {
  const role = "role" in message && typeof message.role === "string"
    ? message.role
    : undefined;

  if (role === "system" || role === "assistant" || role === "tool") {
    return role;
  }
  if (role === "human" || role === "user") {
    return "user";
  }

  switch ("getType" in message ? message.getType?.() : undefined) {
    case "system":
      return "system";
    case "ai":
      return "assistant";
    case "tool":
      return "tool";
    case "human":
    default:
      return "user";
  }
}

function isSupportedContentPart(part: unknown): part is OpenAiContentPart {
  if (!part || typeof part !== "object") {
    return false;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return true;
  }
  return record.type === "image_url" && (
    typeof record.image_url === "string" ||
    Boolean(record.image_url && typeof record.image_url === "object")
  );
}

function contentToOpenAiContent(content: unknown): OpenAiChatMessage["content"] {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content.filter(isSupportedContentPart);
    if (parts.length === content.length && parts.length > 0) {
      return parts;
    }
    return contentToString(content);
  }
  return content === undefined || content === null ? "" : contentToString(content);
}

function openAiToolCallsFromMessage(message: BaseMessage): OpenAiChatMessage["tool_calls"] {
  const toolCalls = (message as { tool_calls?: ToolCall[] }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id ?? `tool-call-${toolCall.name}-${index}`,
    type: "function" as const,
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args ?? {}),
    },
  }));
}

function toOpenAiMessages(input: unknown): OpenAiChatMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (
    input &&
    typeof input === "object" &&
    "toChatMessages" in input &&
    typeof (input as { toChatMessages?: unknown }).toChatMessages === "function"
  ) {
    return toOpenAiMessages((input as { toChatMessages: () => unknown }).toChatMessages());
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: contentToString(input) }];
  }

  return input.map((message) => {
    const role = roleForMessage(message);
    const content =
      message &&
      typeof message === "object" &&
      "content" in message
        ? contentToOpenAiContent((message as { content?: unknown }).content)
        : contentToString(message);

    if (role === "tool") {
      const toolMessage = message as ToolMessage;
      return {
        role,
        content: contentToString(content),
        tool_call_id: toolMessage.tool_call_id,
      };
    }

    if (role === "assistant" && message instanceof BaseMessage) {
      return {
        role,
        content: content ?? "",
        tool_calls: openAiToolCallsFromMessage(message),
      };
    }

    return {
      role,
      content,
    };
  });
}

function contentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function toAnthropicPayload(input: unknown): {
  messages: AnthropicMessage[];
  system?: AnthropicContentBlock[];
} {
  const openAiMessages = toOpenAiMessages(input);
  const messages: AnthropicMessage[] = [];
  const system: AnthropicContentBlock[] = [];

  for (const message of openAiMessages) {
    const block = { type: "text" as const, text: contentToString(message.content) };
    if (message.role === "system") {
      system.push(block);
      continue;
    }

    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [block],
    });
  }

  return {
    messages: messages.length ? messages : [{ role: "user", content: [{ type: "text", text: "" }] }],
    system: system.length ? system : undefined,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageMetadataFromResponse(
  usage: OpenAiChatCompletionResponse["usage"] | undefined
): UsageMetadata | undefined {
  const input = numberOrUndefined(usage?.prompt_tokens);
  const output = numberOrUndefined(usage?.completion_tokens);
  const total = numberOrUndefined(usage?.total_tokens);
  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: total ?? (input ?? 0) + (output ?? 0),
  };
}

export type ToolCallDecodeKind =
  | Exclude<JsonDecodeResult<unknown>["status"], "valid">
  | "schema_invalid";

export interface ToolCallDecodeDiagnostic {
  index: number;
  reason: "missing_name" | "arguments_decode_failed";
  decodeKind?: ToolCallDecodeKind;
  errorCode?: string;
  byteLength?: number;
  rawHash?: string;
}

export interface ToolCallsDecodeResult {
  toolCalls: ToolCall[];
  diagnostics: ToolCallDecodeDiagnostic[];
}

type ToolSchemaValidationResult =
  | { success: true; data: unknown }
  | { success: false; error: unknown };

type ToolArgumentSchema = {
  safeParse(value: unknown): ToolSchemaValidationResult;
};

type ToolArgumentDecodeResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; diagnostic: Omit<ToolCallDecodeDiagnostic, "index" | "reason"> };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolArgumentSchema(value: unknown): value is ToolArgumentSchema {
  return isPlainRecord(value) && typeof value.safeParse === "function";
}

function parseToolCallArgs(
  rawArgs: unknown,
  options: JsonDecodeOptions
): ToolArgumentDecodeResult {
  if (typeof rawArgs !== "string") {
    return {
      ok: false,
      diagnostic: {
        decodeKind: "schema_invalid",
        errorCode: "TOOL_ARGUMENT_TYPE_INVALID",
      },
    };
  }

  const decoded = decodeJsonText<unknown>(rawArgs, options);
  if (decoded.status === "aborted") {
    return {
      ok: false,
      diagnostic: {
        decodeKind: "aborted",
        errorCode: "JSON_DECODE_ABORTED",
      },
    };
  }
  if (decoded.status !== "valid") {
    return {
      ok: false,
      diagnostic: {
        decodeKind: decoded.status,
        errorCode: decoded.errorCode,
        byteLength: decoded.byteLength,
        ...(decoded.status === "incomplete" || decoded.status === "invalid"
          ? { rawHash: decoded.rawHash }
          : {}),
      },
    };
  }
  if (!isPlainRecord(decoded.value)) {
    return {
      ok: false,
      diagnostic: {
        decodeKind: "schema_invalid",
        errorCode: "TOOL_ARGUMENT_NOT_OBJECT",
        byteLength: Buffer.byteLength(rawArgs, "utf8"),
      },
    };
  }

  return { ok: true, args: decoded.value };
}

export function parseOpenAiToolCalls(
  value: unknown,
  options: JsonDecodeOptions,
  toolSchemas?: ReadonlyMap<string, ToolArgumentSchema>
): ToolCallsDecodeResult {
  const toolCalls: ToolCall[] = [];
  const diagnostics: ToolCallDecodeDiagnostic[] = [];
  if (!Array.isArray(value)) {
    return { toolCalls, diagnostics };
  }

  for (const [index, entry] of value.entries()) {
    if (!isPlainRecord(entry)) {
      diagnostics.push({ index, reason: "missing_name" });
      continue;
    }

    const toolCall = entry as OpenAiToolCall;
    const name = toolCall.function?.name;
    if (typeof name !== "string" || !name.trim()) {
      diagnostics.push({ index, reason: "missing_name" });
      continue;
    }

    const decodedArguments = parseToolCallArgs(
      toolCall.function?.arguments,
      options
    );
    if (!decodedArguments.ok) {
      diagnostics.push({
        index,
        reason: "arguments_decode_failed",
        ...decodedArguments.diagnostic,
      });
      continue;
    }

    const toolSchema = toolSchemas?.get(name);
    if (toolSchemas && !toolSchema) {
      diagnostics.push({
        index,
        reason: "arguments_decode_failed",
        decodeKind: "schema_invalid",
        errorCode: "TOOL_ARGUMENT_SCHEMA_NOT_FOUND",
        byteLength: typeof toolCall.function?.arguments === "string"
          ? Buffer.byteLength(toolCall.function.arguments, "utf8")
          : undefined,
      });
      continue;
    }
    const schemaValidation = toolSchema?.safeParse(decodedArguments.args);
    if (schemaValidation && !schemaValidation.success) {
      diagnostics.push({
        index,
        reason: "arguments_decode_failed",
        decodeKind: "schema_invalid",
        errorCode: "TOOL_ARGUMENT_SCHEMA_INVALID",
        byteLength: typeof toolCall.function?.arguments === "string"
          ? Buffer.byteLength(toolCall.function.arguments, "utf8")
          : undefined,
      });
      continue;
    }

    const validatedArguments = schemaValidation?.success
      ? schemaValidation.data
      : decodedArguments.args;
    if (!isPlainRecord(validatedArguments)) {
      diagnostics.push({
        index,
        reason: "arguments_decode_failed",
        decodeKind: "schema_invalid",
        errorCode: "TOOL_ARGUMENT_SCHEMA_OUTPUT_INVALID",
      });
      continue;
    }

    toolCalls.push({
      id: typeof toolCall.id === "string"
        ? toolCall.id
        : `tool-call-${name}-${index}`,
      name,
      args: validatedArguments,
      type: "tool_call",
    });
  }

  return { toolCalls, diagnostics };
}

export class ToolArgumentDecodeError extends Error {
  readonly code = "provider_decode_failure";

  constructor(
    readonly decodeKind: ToolCallDecodeKind,
    readonly errorCode: string,
    readonly provider: LlmProviderName,
    readonly endpointKind: LlmEndpointKind,
    readonly byteLength?: number,
    readonly rawHash?: string,
    readonly finishReason?: string,
    readonly runId?: string,
    readonly taskId?: string,
    readonly stepId?: string,
    readonly toolCallId?: string
  ) {
    super(`Tool argument decoding failed (${decodeKind}/${errorCode}).`);
    this.name = "ToolArgumentDecodeError";
  }
}

function toolArgumentDecodeError(input: {
  diagnostic: ToolCallDecodeDiagnostic;
  provider: LlmProviderName;
  endpointKind: LlmEndpointKind;
  finishReason?: string;
  invokeOptions?: ChatModelInvokeOptions;
}): ToolArgumentDecodeError {
  return new ToolArgumentDecodeError(
    input.diagnostic.decodeKind ?? "schema_invalid",
    input.diagnostic.errorCode ?? "TOOL_CALL_NAME_MISSING",
    input.provider,
    input.endpointKind,
    input.diagnostic.byteLength,
    input.diagnostic.rawHash,
    input.finishReason,
    input.invokeOptions?.runId,
    input.invokeOptions?.taskId,
    input.invokeOptions?.stepId,
    input.invokeOptions?.toolCallId
  );
}

function isToolArgumentRepairEligible(
  diagnostic: ToolCallDecodeDiagnostic,
  finishReason: string | undefined
): boolean {
  if (diagnostic.reason !== "arguments_decode_failed") return false;
  if (diagnostic.decodeKind === "incomplete") return true;
  if (diagnostic.decodeKind === "schema_invalid") return true;
  return diagnostic.decodeKind === "invalid" && finishReason === "length";
}

function appendToolArgumentRepairHint(input: ChatModelInput): ChatModelInput {
  const instruction = [
    "The previous Tool call arguments were incomplete or failed schema validation.",
    "Return the Tool call once with one complete strict JSON object matching the Tool schema.",
    "Do not include markdown or explanatory text in the Tool arguments.",
  ].join("\n");
  return Array.isArray(input)
    ? [...input, { role: "user", content: instruction }]
    : typeof input === "string"
      ? `${input}\n\n${instruction}`
      : [input, { role: "user", content: instruction }];
}

type ToolCallDecodeTelemetryInput = {
  provider: LlmProviderName;
  endpointKind: LlmEndpointKind;
  finishReason?: string;
  invokeOptions?: ChatModelInvokeOptions;
  diagnostics: ToolCallDecodeDiagnostic[];
};

export type ToolCallDecodeTelemetryPayload = {
  provider: LlmProviderName;
  endpointKind: LlmEndpointKind;
  finishReason?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolCallId?: string;
  byteLength?: number;
  rawHash?: string;
  errorCode: string;
};

export function createToolCallDecodeTelemetryPayloads(
  input: ToolCallDecodeTelemetryInput
): ToolCallDecodeTelemetryPayload[] {
  return input.diagnostics.map((diagnostic) => ({
    provider: input.provider,
    endpointKind: input.endpointKind,
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    ...(input.invokeOptions?.runId ? { runId: input.invokeOptions.runId } : {}),
    ...(input.invokeOptions?.taskId ? { taskId: input.invokeOptions.taskId } : {}),
    ...(input.invokeOptions?.stepId ? { stepId: input.invokeOptions.stepId } : {}),
    ...(input.invokeOptions?.toolCallId
      ? { toolCallId: input.invokeOptions.toolCallId }
      : {}),
    ...(diagnostic.byteLength !== undefined
      ? { byteLength: diagnostic.byteLength }
      : {}),
    ...(diagnostic.rawHash ? { rawHash: diagnostic.rawHash } : {}),
    errorCode: diagnostic.errorCode ?? "TOOL_CALL_NAME_MISSING",
  }));
}

async function recordToolCallDecodeDiagnostics(
  input: ToolCallDecodeTelemetryInput
): Promise<void> {
  if (input.diagnostics.length === 0) return;

  const payloads = createToolCallDecodeTelemetryPayloads(input);

  try {
    for (const payload of payloads) {
      await auditLogger.record("llm.tool_call.decode_failed", { ...payload });
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: "llm_tool_call_decode_audit_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }

  try {
    const manager = getSpanManager();
    const span = manager.getActiveSpan();
    if (span) {
      for (const payload of payloads) {
        manager.setAttributes(span, {
          "tool_call.decode.provider": payload.provider,
          "tool_call.decode.endpoint_kind": payload.endpointKind,
          ...(payload.finishReason
            ? { "tool_call.decode.finish_reason": payload.finishReason }
            : {}),
          ...(payload.runId ? { "tool_call.decode.run_id": payload.runId } : {}),
          ...(payload.taskId ? { "tool_call.decode.task_id": payload.taskId } : {}),
          ...(payload.stepId ? { "tool_call.decode.step_id": payload.stepId } : {}),
          ...(payload.toolCallId
            ? { "tool_call.decode.tool_call_id": payload.toolCallId }
            : {}),
          ...(payload.byteLength !== undefined
            ? { "tool_call.decode.byte_length": payload.byteLength }
            : {}),
          ...(payload.rawHash
            ? { "tool_call.decode.raw_hash": payload.rawHash }
            : {}),
          "tool_call.decode.error_code": payload.errorCode,
        });
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: "llm_tool_call_decode_trace_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

function jsonSchemaFromZod(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) {
    return { type: "object", additionalProperties: true };
  }

  const zodSchema = schema as z.ZodTypeAny;
  const def = zodSchema._def as { typeName?: z.ZodFirstPartyTypeKind; [key: string]: unknown };
  const description = typeof zodSchema.description === "string" ? zodSchema.description : undefined;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shapeFactory = def.shape;
      const shape = typeof shapeFactory === "function"
        ? shapeFactory() as Record<string, z.ZodTypeAny>
        : {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = jsonSchemaFromZod(value);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
          required.push(key);
        }
      }
      return {
        type: "object",
        ...(description ? { description } : {}),
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string", ...(description ? { description } : {}) };
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number", ...(description ? { description } : {}) };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean", ...(description ? { description } : {}) };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const itemType = def.type;
      return {
        type: "array",
        ...(description ? { description } : {}),
        items: jsonSchemaFromZod(itemType),
      };
    }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return {
        type: "string",
        ...(description ? { description } : {}),
        enum: Array.isArray(def.values) ? def.values : undefined,
      };
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return jsonSchemaFromZod(def.innerType);
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return jsonSchemaFromZod(def.schema);
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return {
        enum: "value" in def ? [def.value] : undefined,
        ...(description ? { description } : {}),
      };
    default:
      return { type: "object", ...(description ? { description } : {}), additionalProperties: true };
  }
}

function toOpenAiTool(tool: StructuredToolInterface): OpenAiToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaFromZod(tool.schema),
    },
  };
}

function sanitizeHeaderValue(value: string): string {
  return value ? "[redacted]" : "";
}

function createProviderHttpError(
  status: number,
  statusText: string,
  responseText: string,
  provider: LlmProviderName,
  endpointKind: LlmEndpointKind
): ProviderHttpError {
  return new ProviderHttpError(
    `Provider request failed: [${status} ${statusText}] ${formatResponseDiagnostics(
      responseDiagnostics(provider, endpointKind, responseText)
    )}`,
    status,
    provider,
    endpointKind,
    responseText.length
  );
}

class OpenAiCompatibleChatModel implements ChatModelInvoker {
  constructor(
    private readonly options: Required<Pick<ChatModelOptions, "temperature" | "maxRetries">> & {
      model: string;
      baseUrl: string;
      provider: Extract<LlmProviderName, "openai-compatible" | "qwen">;
      apiKey?: string;
      purpose: ModelPurpose;
      responseFormat?: ChatResponseFormat;
      tools?: OpenAiToolDefinition[];
      toolSchemas?: ReadonlyMap<string, ToolArgumentSchema>;
      toolChoice?: ChatModelOptions["toolChoice"];
    }
  ) {}

  bindTools(
    tools: StructuredToolInterface[],
    kwargs?: Pick<ChatModelOptions, "toolChoice">
  ): ChatModelInvoker {
    assertProviderCapability(
      capabilitiesForProvider(this.options.provider, this.options.purpose),
      this.options.provider,
      "openai-chat-completions",
      "supportsToolCalling"
    );

    const toolSchemas = new Map<string, ToolArgumentSchema>();
    for (const tool of tools) {
      if (isToolArgumentSchema(tool.schema)) {
        toolSchemas.set(tool.name, tool.schema);
      }
    }

    return new OpenAiCompatibleChatModel({
      ...this.options,
      tools: tools.map(toOpenAiTool),
      toolSchemas,
      toolChoice: kwargs?.toolChoice ?? this.options.toolChoice ?? "auto",
    });
  }

  async invoke(
    input: ChatModelInput,
    invokeOptions?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput> {
    const url = buildChatCompletionsUrl(this.options.baseUrl);
    const endpointKind = "openai-chat-completions" as const;
    const capabilities = capabilitiesForProvider(this.options.provider, this.options.purpose);
    const runtimeConfig = getAgentRuntimeConfig();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    if (this.options.purpose === "vision" && !capabilities.supportsVision) {
      throw new Error(
        `Selected provider does not support vision: ${JSON.stringify({
          provider: this.options.provider,
          endpointKind,
          model: this.options.model,
        })}`
      );
    }

    if (this.options.responseFormat) {
      assertProviderCapability(
        capabilities,
        this.options.provider,
        endpointKind,
        "supportsStructuredOutput"
      );
    }

    let lastError: Error | undefined;
    let providerFailureCount = 0;
    let requestInput = input;
    let isRepairRequest = false;
    while (true) {
      try {
        const body = {
          model: this.options.model,
          temperature: this.options.temperature,
          messages: toOpenAiMessages(requestInput),
          ...(this.options.responseFormat ? { response_format: this.options.responseFormat } : {}),
          ...(this.options.tools?.length ? { tools: this.options.tools } : {}),
          ...(this.options.tools?.length
            ? { tool_choice: this.options.toolChoice ?? "auto" }
            : {}),
        };
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: invokeOptions?.signal,
        });
        const responseText = await response.text();

        if (!response.ok) {
          throw createProviderHttpError(
            response.status,
            response.statusText,
            responseText,
            this.options.provider,
            endpointKind
          );
        }

        const parsed = validateProviderEnvelope(
          parseJsonResponse<unknown>(
            responseText,
            this.options.provider,
            endpointKind,
            {
              maxBytes: runtimeConfig.llmProviderResponseMaxBytes,
              maxDepth: runtimeConfig.llmJsonMaxDepth,
              signal: invokeOptions?.signal,
            }
          ),
          endpointKind
        );
        const choice = parsed.choices?.[0];
        const message = choice?.message;
        const finishReason = typeof choice?.finish_reason === "string"
          ? choice.finish_reason
          : undefined;
        if (finishReason === "content_filter") {
          throw new StructuredOutputRefusalError();
        }
        const { toolCalls, diagnostics } = parseOpenAiToolCalls(
          message?.tool_calls,
          {
            maxBytes: runtimeConfig.llmToolArgumentMaxBytes,
            maxDepth: runtimeConfig.llmJsonMaxDepth,
            signal: invokeOptions?.signal,
          },
          this.options.toolSchemas
        );
        await recordToolCallDecodeDiagnostics({
          provider: this.options.provider,
          endpointKind,
          finishReason,
          invokeOptions,
          diagnostics,
        });
        if (diagnostics.length > 0) {
          const diagnostic = diagnostics[0];
          if (
            !isRepairRequest
            && runtimeConfig.llmRepairStrategy !== "none"
            && isToolArgumentRepairEligible(diagnostic, finishReason)
          ) {
            requestInput = runtimeConfig.llmRepairStrategy === "retry_with_hint"
              ? appendToolArgumentRepairHint(input)
              : input;
            isRepairRequest = true;
            continue;
          }
          throw toolArgumentDecodeError({
            diagnostic,
            provider: this.options.provider,
            endpointKind,
            finishReason,
            invokeOptions,
          });
        }
        const content = contentToString(message?.content);
        return new AIMessage({
          content: toolCalls.length ? "" : content,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          usage_metadata: usageMetadataFromResponse(parsed.usage),
          response_metadata: {
            provider: this.options.provider,
            endpointKind,
            model: typeof parsed.model === "string" ? parsed.model : this.options.model,
            id: typeof parsed.id === "string" ? parsed.id : undefined,
            finish_reason: choice?.finish_reason,
            tool_call_diagnostic_count: diagnostics.length,
            capabilities,
          },
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (invokeOptions?.signal?.aborted) {
          throw lastError;
        }
        if (
          lastError instanceof ToolArgumentDecodeError
          || lastError instanceof StructuredOutputRefusalError
          || isRepairRequest
          || providerFailureCount >= this.options.maxRetries
        ) {
          throw lastError;
        }
        providerFailureCount += 1;
      }
    }
  }

  redactForDiagnostics(): Record<string, unknown> {
    return {
      ...this.options,
      apiKey: this.options.apiKey ? sanitizeHeaderValue(this.options.apiKey) : undefined,
    };
  }
}

class OpenAiCompatibleGateway implements ProviderGateway {
  createChatModel(options: ChatModelOptions = {}): ChatModelInvoker {
    const baseUrl = getOpenAiCompatibleBaseUrl();
    if (!baseUrl) {
      throw new Error(
        "OpenAI-compatible LLM provider selected but CCR_BASE_URL, OPENAI_COMPATIBLE_BASE_URL, or OPENAI_BASE_URL is not configured."
      );
    }
    const purpose = options.purpose ?? "chat";

    return new OpenAiCompatibleChatModel({
      model: resolveProviderModel("openai-compatible", purpose, options.model),
      baseUrl,
      provider: "openai-compatible",
      apiKey: getOpenAiCompatibleApiKey() || undefined,
      temperature: options.temperature ?? 0.7,
      maxRetries: options.maxRetries ?? 2,
      purpose,
      responseFormat: options.responseFormat,
      toolChoice: options.toolChoice,
    });
  }
}

class QwenGateway implements ProviderGateway {
  createChatModel(options: ChatModelOptions = {}): ChatModelInvoker {
    const purpose = options.purpose ?? "chat";
    return new OpenAiCompatibleChatModel({
      model: resolveProviderModel("qwen", purpose, options.model),
      baseUrl: getQwenBaseUrl(),
      provider: "qwen",
      apiKey: getQwenApiKey() || undefined,
      temperature: options.temperature ?? 0.7,
      maxRetries: options.maxRetries ?? 2,
      purpose,
      responseFormat: options.responseFormat,
      toolChoice: options.toolChoice,
    });
  }
}

class CcrAnthropicChatModel implements ChatModelInvoker {
  constructor(
    private readonly options: Required<Pick<ChatModelOptions, "temperature" | "maxRetries">> & {
      model: string;
      baseUrl: string;
      apiKey?: string;
    }
  ) {}

  async invoke(
    input: ChatModelInput,
    invokeOptions?: ChatModelInvokeOptions
  ): Promise<ChatModelOutput> {
    const url = buildAnthropicMessagesUrl(this.options.baseUrl);
    const provider: LlmProviderName = "ccr";
    const endpointKind = "anthropic-messages" as const;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    if (this.options.apiKey) {
      headers["x-api-key"] = this.options.apiKey;
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    const payload = toAnthropicPayload(input);
    const runtimeConfig = getAgentRuntimeConfig();
    let lastError: Error | undefined;
    const attempts = Math.max(1, this.options.maxRetries + 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.options.model,
            max_tokens: 8192,
            temperature: this.options.temperature,
            messages: payload.messages,
            ...(payload.system ? { system: payload.system } : {}),
          }),
          signal: invokeOptions?.signal,
        });
        const responseText = await response.text();

        if (!response.ok) {
          throw createProviderHttpError(
            response.status,
            response.statusText,
            responseText,
            provider,
            endpointKind
          );
        }

        const parsed = validateProviderEnvelope(
          parseJsonResponse<unknown>(
            responseText,
            provider,
            endpointKind,
            {
              maxBytes: runtimeConfig.llmProviderResponseMaxBytes,
              maxDepth: runtimeConfig.llmJsonMaxDepth,
              signal: invokeOptions?.signal,
            }
          ),
          endpointKind
        );
        const content = parsed.content
          ?.map((block) => block.type === "text" ? contentToString(block.text) : "")
          .filter(Boolean)
          .join("\n") ?? "";
        return new AIMessage(content);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (invokeOptions?.signal?.aborted) {
          throw lastError;
        }
        if (attempt >= attempts) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error("CCR messages request failed.");
  }
}

class CcrGateway implements ProviderGateway {
  createChatModel(options: ChatModelOptions = {}): ChatModelInvoker {
    const baseUrl = getCcrBaseUrl();
    if (!baseUrl) {
      throw new Error("CCR LLM provider selected but CCR_BASE_URL is not configured.");
    }
    const provider: LlmProviderName = "ccr";
    const purpose = options.purpose ?? "chat";
    const endpointKind: LlmEndpointKind = "anthropic-messages";

    if (options.responseFormat) {
      assertProviderCapability(
        capabilitiesForProvider(provider, purpose),
        provider,
        endpointKind,
        "supportsStructuredOutput"
      );
    }

    return new CcrAnthropicChatModel({
      model: resolveProviderModel(provider, purpose, options.model),
      baseUrl,
      apiKey: getCcrApiKey() || undefined,
      temperature: options.temperature ?? 0.7,
      maxRetries: options.maxRetries ?? 2,
    });
  }
}

export function getConfiguredLlmProvider(): LlmProviderName {
  const provider = getEnv("LLM_PROVIDER").trim().toLowerCase();
  if (provider === "qwen") {
    return "qwen";
  }

  if (provider === "ccr") {
    return "ccr";
  }

  if (provider === "openai" || provider === "openai-compatible") {
    return "openai-compatible";
  }
  if (provider) {
    throw new Error(
      `Unsupported LLM_PROVIDER "${provider}". Supported providers: qwen, ccr, openai-compatible.`
    );
  }

  if (getCcrBaseUrl()) {
    return "ccr";
  }

  if (getFirstEnv(["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"])) {
    return "openai-compatible";
  }

  return "qwen";
}

function createGatewayForProvider(provider: LlmProviderName): ProviderGateway {
  if (provider === "qwen") {
    return new QwenGateway();
  }
  if (provider === "ccr") {
    return new CcrGateway();
  }
  if (provider === "openai-compatible") {
    return new OpenAiCompatibleGateway();
  }
  return new QwenGateway();
}

function isLlmProviderName(value: string): value is LlmProviderName {
  return value === "ccr" || value === "openai-compatible" || value === "qwen";
}

export function getDefaultFallbackPolicy(): ModelFallbackPolicy {
  const config = getAgentRuntimeConfig();
  const fallbackProviders = config.llmFallbackProviders.map((provider) => {
    if (!isLlmProviderName(provider)) {
      throw new Error(`Unsupported fallback LLM provider: ${provider}`);
    }
    return provider;
  });
  return {
    primaryProvider: getConfiguredLlmProvider(),
    fallbackProviders,
    maxTotalAttempts: config.llmFallbackMaxAttempts,
    repairStrategy: config.llmRepairStrategy,
    perProviderTimeoutMs: config.llmFallbackTimeoutMs,
  };
}

class ConfiguredLlmGateway implements LlmGateway {
  constructor(
    private readonly primaryProvider: LlmProviderName,
    private readonly primaryGateway: ProviderGateway
  ) {}

  private tracedModel(
    provider: LlmProviderName,
    options: ChatModelOptions,
    invoker: ChatModelInvoker
  ): ChatModelInvoker {
    const purpose = options.purpose ?? "chat";
    return new TracedChatModelInvoker(
      invoker,
      provider,
      resolveProviderModel(provider, purpose, options.model)
    );
  }

  createChatModel(options: ChatModelOptions = {}): ChatModelInvoker {
    return new ModelCallMetricInvoker(
      this.tracedModel(
        this.primaryProvider,
        options,
        this.primaryGateway.createChatModel(options)
      ),
      this.primaryProvider
    );
  }

  createChatModelWithFallback(
    options: ChatModelOptions = {},
    fallbackPolicy?: Partial<ModelFallbackPolicy>
  ): ChatModelInvoker {
    const config = getAgentRuntimeConfig();
    const explicitlyEnabled = Boolean(fallbackPolicy?.fallbackProviders?.length);
    if (!config.llmFallbackEnabled && !explicitlyEnabled) {
      return this.createChatModel(options);
    }

    const defaults = getDefaultFallbackPolicy();
    const policy: ModelFallbackPolicy = {
      ...defaults,
      ...fallbackPolicy,
      fallbackProviders:
        fallbackPolicy?.fallbackProviders ?? defaults.fallbackProviders,
    };
    if (policy.fallbackProviders.length === 0) {
      return this.createChatModel(options);
    }

    const providers = [
      policy.primaryProvider,
      ...policy.fallbackProviders.filter(
        (provider, index, all) =>
          provider !== policy.primaryProvider && all.indexOf(provider) === index
      ),
    ];
    return new FallbackChatModelInvoker(
      providers.map((provider) => {
        const tracedInvoker = this.tracedModel(
          provider,
          options,
          createGatewayForProvider(provider).createChatModel(options)
        );
        return {
          provider,
          invoker: options.responseFormat
            ? new StructuredOutputRepairChatModelInvoker(
                tracedInvoker,
                policy.repairStrategy
              )
            : tracedInvoker,
        };
      }),
      policy
    );
  }
}

export function describeLlmGatewayConfig(): Record<string, string | boolean> {
  const provider = getConfiguredLlmProvider();
  return {
    provider,
    endpointKind: endpointKindForProvider(provider),
    baseUrlConfigured: provider === "ccr"
      ? Boolean(getCcrBaseUrl())
      : provider === "openai-compatible"
        ? Boolean(getOpenAiCompatibleBaseUrl())
        : Boolean(getQwenBaseUrl()),
    apiKeyConfigured: provider === "ccr"
      ? Boolean(getCcrApiKey())
      : provider === "openai-compatible"
        ? Boolean(getOpenAiCompatibleApiKey())
        : Boolean(getQwenApiKey()),
  };
}

export function getConfiguredLlmCapabilities(
  purpose: ModelPurpose = "chat"
): Readonly<LlmCapabilities> {
  return capabilitiesForProvider(getConfiguredLlmProvider(), purpose);
}

const configuredLlmProvider = getConfiguredLlmProvider();
export const llmGateway: LlmGateway = new ConfiguredLlmGateway(
  configuredLlmProvider,
  createGatewayForProvider(configuredLlmProvider)
);

export function resolveModel(requestedModel: unknown, fallback: string): string {
  if (typeof requestedModel !== "string" || !requestedModel.trim()) {
    return fallback;
  }

  return requestedModel.trim();
}

export function resolveModelForPurpose(
  purpose: ModelPurpose,
  requestedModel?: string
): string {
  return resolveProviderModel(getConfiguredLlmProvider(), purpose, requestedModel);
}

export function formatLlmError(error: unknown): string {
  return formatErrorEnvelope(
    createErrorEnvelope(error, {
      source: "backend",
      stage: "llm_request",
      provider: getConfiguredLlmProvider(),
      details:
        error instanceof ProviderHttpError
          ? {
              statusCode: error.statusCode,
              endpointKind: error.endpointKind,
              responseContentLength: error.responseContentLength,
            }
          : error instanceof ProviderResponseParseError
            ? {
                endpointKind: error.endpointKind,
                responseContentLength: error.responseContentLength,
                byteLength: error.byteLength,
                rawHash: error.rawHash,
                errorCode: error.errorCode,
              }
            : error instanceof ProviderEnvelopeValidationError
              ? {
                  endpointKind: error.endpointKind,
                  issueCount: error.issueCount,
                }
              : error instanceof ToolArgumentDecodeError
                ? {
                    endpointKind: error.endpointKind,
                    finishReason: error.finishReason,
                    runId: error.runId,
                    taskId: error.taskId,
                    stepId: error.stepId,
                    toolCallId: error.toolCallId,
                    byteLength: error.byteLength,
                    rawHash: error.rawHash,
                    errorCode: error.errorCode,
                  }
                : undefined,
    })
  );
}
