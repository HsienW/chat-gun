import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_TEXT_LENGTH = 100_000;
const MAX_ATTACHMENTS = 20;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INTERRUPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const NORMALIZED_AGENT_INPUT_KINDS = [
  "prompt",
  "clarification_resume",
  "cancel",
  "command",
] as const;

const attachmentRefSchema = z
  .object({
    attachmentId: z.string().regex(ATTACHMENT_ID_PATTERN),
    name: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    securityValidatedAt: z.string().datetime().optional(),
  })
  .strict();

const rawNormalizedAgentInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prompt"),
      text: z.string().max(MAX_TEXT_LENGTH),
      attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarification_resume"),
      interruptId: z.string().regex(INTERRUPT_ID_PATTERN),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel"),
      targetRunId: z.string().regex(RUN_ID_PATTERN).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      commandId: z.string().regex(COMMAND_ID_PATTERN),
      arguments: z.unknown().optional(),
    })
    .strict(),
]).superRefine((input, context) => {
  if (
    input.kind === "prompt" &&
    normalizeInputText(input.text).length === 0 &&
    (input.attachments?.length ?? 0) === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "empty_input",
      path: ["text"],
    });
  }
});

export const normalizedAgentInputSchema = rawNormalizedAgentInputSchema.transform(
  (input) => {
    if (input.kind !== "prompt") {
      return input;
    }

    return {
      ...input,
      text: normalizeInputText(input.text),
      attachments: input.attachments ?? [],
    };
  },
);

export type NormalizedAgentInput = z.infer<typeof normalizedAgentInputSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export type NormalizedInputErrorCode =
  | "unsupported_input_kind"
  | "empty_input"
  | "invalid_attachment"
  | "invalid_input";

export type NormalizedInputParseResult =
  | { ok: true; input: NormalizedAgentInput }
  | {
      ok: false;
      errorCode: NormalizedInputErrorCode;
      issues: readonly string[];
    };

export interface RawInputReference {
  algorithm: "sha256";
  digest: string;
  byteLength: number;
}

export function normalizeInputText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .trim();
}

export function parseNormalizedAgentInput(
  value: unknown,
): NormalizedInputParseResult {
  const parsed = normalizedAgentInputSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, input: parsed.data };
  }

  const issues = parsed.error.issues.map((issue) => issue.message);
  return {
    ok: false,
    errorCode: classifyValidationError(value, parsed.error),
    issues,
  };
}

export function createRawInputReference(value: unknown): RawInputReference {
  const serialized = stableSerialize(value);
  const bytes = new TextEncoder().encode(serialized);
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function classifyValidationError(
  value: unknown,
  error: z.ZodError,
): NormalizedInputErrorCode {
  if (
    isRecord(value) &&
    "kind" in value &&
    !NORMALIZED_AGENT_INPUT_KINDS.includes(
      value.kind as (typeof NORMALIZED_AGENT_INPUT_KINDS)[number],
    )
  ) {
    return "unsupported_input_kind";
  }

  if (error.issues.some((issue) => issue.message === "empty_input")) {
    return "empty_input";
  }

  if (error.issues.some((issue) => issue.path[0] === "attachments")) {
    return "invalid_attachment";
  }

  return "invalid_input";
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (typeof nestedValue === "bigint") {
      return nestedValue.toString();
    }
    if (typeof nestedValue !== "object" || nestedValue === null) {
      return nestedValue;
    }
    if (seen.has(nestedValue)) {
      return "[Circular]";
    }
    seen.add(nestedValue);
    if (Array.isArray(nestedValue)) {
      return nestedValue;
    }
    return Object.fromEntries(
      Object.entries(nestedValue).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

  return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
