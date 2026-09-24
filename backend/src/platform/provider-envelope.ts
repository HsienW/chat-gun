import { z } from "zod";

export type ProviderEnvelopeKind =
  | "openai-chat-completions"
  | "anthropic-messages";

const OpenAiToolFunctionSchema = z.object({
  name: z.string().min(1),
  arguments: z.string(),
}).passthrough();

const OpenAiToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: OpenAiToolFunctionSchema,
}).passthrough();

const OpenAiMessageSchema = z.object({
  content: z.union([z.string(), z.null(), z.array(z.unknown())]).optional(),
  tool_calls: z.array(OpenAiToolCallSchema).optional(),
}).passthrough();

const OpenAiChoiceSchema = z.object({
  finish_reason: z.union([z.string(), z.null()]).optional(),
  message: OpenAiMessageSchema,
}).passthrough();

const OpenAiUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
}).passthrough();

export const OpenAiChatCompletionEnvelopeSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(OpenAiChoiceSchema),
  usage: OpenAiUsageSchema.optional(),
}).passthrough();

const AnthropicContentBlockSchema = z.object({
  type: z.string().min(1),
  text: z.unknown().optional(),
}).passthrough().superRefine((block, context) => {
  if (block.type === "text" && typeof block.text !== "string") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Anthropic text blocks require string text.",
    });
  }
});

export const AnthropicMessagesEnvelopeSchema = z.object({
  content: z.array(AnthropicContentBlockSchema),
}).passthrough();

export type OpenAiChatCompletionEnvelope = z.infer<
  typeof OpenAiChatCompletionEnvelopeSchema
>;
export type AnthropicMessagesEnvelope = z.infer<
  typeof AnthropicMessagesEnvelopeSchema
>;

export class ProviderEnvelopeValidationError extends Error {
  readonly code = "PROVIDER_ENVELOPE_INVALID";

  constructor(
    readonly endpointKind: ProviderEnvelopeKind,
    readonly issueCount: number
  ) {
    super(`Provider envelope validation failed for ${endpointKind}.`);
    this.name = "ProviderEnvelopeValidationError";
  }
}

export function validateProviderEnvelope(
  value: unknown,
  endpointKind: "openai-chat-completions"
): OpenAiChatCompletionEnvelope;
export function validateProviderEnvelope(
  value: unknown,
  endpointKind: "anthropic-messages"
): AnthropicMessagesEnvelope;
export function validateProviderEnvelope(
  value: unknown,
  endpointKind: ProviderEnvelopeKind
): OpenAiChatCompletionEnvelope | AnthropicMessagesEnvelope {
  const validation = endpointKind === "openai-chat-completions"
    ? OpenAiChatCompletionEnvelopeSchema.safeParse(value)
    : AnthropicMessagesEnvelopeSchema.safeParse(value);

  if (!validation.success) {
    throw new ProviderEnvelopeValidationError(
      endpointKind,
      validation.error.issues.length
    );
  }

  return validation.data;
}
