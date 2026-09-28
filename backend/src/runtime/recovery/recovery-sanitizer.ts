import { classifyExecutionManifestCompatibility } from "./execution-manifest.js";
import type { ExecutionManifestRef } from "./interrupt-manifest.js";

export const SANITIZE_REASON_CODES = [
  "UNMATCHED_TOOL_CALL",
  "UNMATCHED_TOOL_RESULT",
  "DUPLICATE_TOOL_RESULT",
  "INCOMPLETE_TOOL_ARGUMENTS",
  "ORPHANED_CONTENT_BLOCK",
  "PARTIAL_ASSISTANT_MESSAGE",
  "INVALID_LEGACY_VALUE",
  "ALREADY_TERMINAL_TOOL_RESULT",
  "INCOMPATIBLE_EXECUTION_MANIFEST",
  "EXECUTION_MANIFEST_MIGRATION_REQUIRED",
  "UNPROVABLE_HISTORY",
] as const;

export type SanitizeReasonCode = (typeof SANITIZE_REASON_CODES)[number];

export interface SanitizedFragment {
  fragmentType: "message" | "content_block" | "tool_result";
  reasonCode: SanitizeReasonCode;
  messageId?: string;
  blockId?: string;
  toolCallId?: string;
}

export interface RedactedDiagnostic {
  reasonCode: SanitizeReasonCode;
  index?: number;
  messageId?: string;
  toolCallId?: string;
}

export type SanitizedRecoveryMessage = Record<string, unknown> & {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
};

export type SanitizeResult =
  | { status: "valid"; history: SanitizedRecoveryMessage[] }
  | {
      status: "sanitized";
      history: SanitizedRecoveryMessage[];
      dropped: SanitizedFragment[];
      reasonCodes: SanitizeReasonCode[];
    }
  | {
      status: "parked";
      reasonCodes: SanitizeReasonCode[];
      diagnostics: RedactedDiagnostic[];
    };

export interface SanitizeRecoveryHistoryInput {
  messages: readonly unknown[];
  persistedExecutionManifest: ExecutionManifestRef;
  currentExecutionManifest: ExecutionManifestRef;
}

const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
const LEGACY_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  run_status: new Set([
    "running",
    "needs_user",
    "manual_intervention_required",
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ]),
  tool_status: new Set([
    "running",
    "success",
    "error",
    "timeout",
    "cancelled",
    "denied",
    "unknown",
  ]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessageRole(
  value: unknown
): value is SanitizedRecoveryMessage["role"] {
  return (
    typeof value === "string" &&
    MESSAGE_ROLES.includes(value as SanitizedRecoveryMessage["role"])
  );
}

function addUniqueReason(
  reasons: SanitizeReasonCode[],
  reasonCode: SanitizeReasonCode
): void {
  if (!reasons.includes(reasonCode)) reasons.push(reasonCode);
}

function redactedDiagnostic(
  reasonCode: SanitizeReasonCode,
  input: { index?: number; messageId?: string; toolCallId?: string } = {}
): RedactedDiagnostic {
  return { reasonCode, ...input };
}

function validateLegacyConfig(message: Record<string, unknown>): boolean {
  if (message.legacyConfig === undefined) return true;
  if (!isRecord(message.legacyConfig)) return false;
  const { kind, value } = message.legacyConfig;
  return (
    typeof kind === "string" &&
    typeof value === "string" &&
    LEGACY_VALUES[kind]?.has(value) === true
  );
}

function sanitizeContentBlocks(input: {
  message: Record<string, unknown>;
  messageId: string;
  dropped: SanitizedFragment[];
  reasons: SanitizeReasonCode[];
}): { valid: boolean; blocks?: Record<string, unknown>[] } {
  if (input.message.contentBlocks === undefined) return { valid: true };
  if (!Array.isArray(input.message.contentBlocks)) return { valid: false };
  const blocks: Record<string, unknown>[] = [];
  for (const candidate of input.message.contentBlocks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.blockId !== "string" ||
      (candidate.type !== "thinking" && candidate.type !== "content")
    ) {
      return { valid: false };
    }
    if (candidate.parentMessageId !== input.messageId) {
      addUniqueReason(input.reasons, "ORPHANED_CONTENT_BLOCK");
      input.dropped.push({
        fragmentType: "content_block",
        reasonCode: "ORPHANED_CONTENT_BLOCK",
        messageId: input.messageId,
        blockId: candidate.blockId,
      });
      continue;
    }
    blocks.push(candidate);
  }
  return { valid: true, blocks };
}

function readToolCalls(message: Record<string, unknown>):
  | { valid: true; calls: Array<{ id: string; argumentState: string }> }
  | { valid: false } {
  if (message.toolCalls === undefined) return { valid: true, calls: [] };
  if (!Array.isArray(message.toolCalls)) return { valid: false };
  const calls: Array<{ id: string; argumentState: string }> = [];
  for (const candidate of message.toolCalls) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      !["complete", "incomplete", "invalid"].includes(
        String(candidate.argumentState)
      )
    ) {
      return { valid: false };
    }
    calls.push({ id: candidate.id, argumentState: String(candidate.argumentState) });
  }
  return { valid: true, calls };
}

export function sanitizeRecoveryHistory(
  input: SanitizeRecoveryHistoryInput
): SanitizeResult {
  const compatibility = classifyExecutionManifestCompatibility(
    input.persistedExecutionManifest,
    input.currentExecutionManifest
  );
  if (compatibility !== "compatible") {
    const reasonCode =
      compatibility === "migratable"
        ? "EXECUTION_MANIFEST_MIGRATION_REQUIRED"
        : "INCOMPATIBLE_EXECUTION_MANIFEST";
    return {
      status: "parked",
      reasonCodes: [reasonCode],
      diagnostics: [redactedDiagnostic(reasonCode)],
    };
  }

  const sanitizedHistory: SanitizedRecoveryMessage[] = [];
  const dropped: SanitizedFragment[] = [];
  const reasons: SanitizeReasonCode[] = [];
  const hardReasons: SanitizeReasonCode[] = [];
  const diagnostics: RedactedDiagnostic[] = [];
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();

  for (const [index, candidate] of input.messages.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !isMessageRole(candidate.role)
    ) {
      addUniqueReason(hardReasons, "UNPROVABLE_HISTORY");
      diagnostics.push(redactedDiagnostic("UNPROVABLE_HISTORY", { index }));
      continue;
    }
    const messageId = candidate.id;
    if (!validateLegacyConfig(candidate)) {
      addUniqueReason(hardReasons, "INVALID_LEGACY_VALUE");
      diagnostics.push(
        redactedDiagnostic("INVALID_LEGACY_VALUE", { index, messageId })
      );
      continue;
    }
    if (candidate.role === "assistant" && candidate.status === "partial") {
      addUniqueReason(reasons, "PARTIAL_ASSISTANT_MESSAGE");
      dropped.push({
        fragmentType: "message",
        reasonCode: "PARTIAL_ASSISTANT_MESSAGE",
        messageId,
      });
      continue;
    }
    const blocks = sanitizeContentBlocks({
      message: candidate,
      messageId,
      dropped,
      reasons,
    });
    if (!blocks.valid) {
      addUniqueReason(hardReasons, "UNPROVABLE_HISTORY");
      diagnostics.push(
        redactedDiagnostic("UNPROVABLE_HISTORY", { index, messageId })
      );
      continue;
    }
    const parsedToolCalls = readToolCalls(candidate);
    if (!parsedToolCalls.valid) {
      addUniqueReason(hardReasons, "UNPROVABLE_HISTORY");
      diagnostics.push(
        redactedDiagnostic("UNPROVABLE_HISTORY", { index, messageId })
      );
      continue;
    }
    for (const call of parsedToolCalls.calls) {
      if (call.argumentState !== "complete") {
        addUniqueReason(hardReasons, "INCOMPLETE_TOOL_ARGUMENTS");
        diagnostics.push(
          redactedDiagnostic("INCOMPLETE_TOOL_ARGUMENTS", {
            index,
            messageId,
            toolCallId: call.id,
          })
        );
      }
      toolCalls.add(call.id);
    }

    if (candidate.role === "tool") {
      if (
        typeof candidate.toolCallId !== "string" ||
        (candidate.resultState !== "active" &&
          candidate.resultState !== "terminal")
      ) {
        addUniqueReason(hardReasons, "UNPROVABLE_HISTORY");
        diagnostics.push(
          redactedDiagnostic("UNPROVABLE_HISTORY", { index, messageId })
        );
        continue;
      }
      if (candidate.resultState === "terminal") {
        addUniqueReason(hardReasons, "ALREADY_TERMINAL_TOOL_RESULT");
        diagnostics.push(
          redactedDiagnostic("ALREADY_TERMINAL_TOOL_RESULT", {
            index,
            messageId,
            toolCallId: candidate.toolCallId,
          })
        );
        continue;
      }
      if (!toolCalls.has(candidate.toolCallId)) {
        addUniqueReason(reasons, "UNMATCHED_TOOL_RESULT");
        dropped.push({
          fragmentType: "tool_result",
          reasonCode: "UNMATCHED_TOOL_RESULT",
          messageId,
          toolCallId: candidate.toolCallId,
        });
        continue;
      }
      if (toolResults.has(candidate.toolCallId)) {
        addUniqueReason(reasons, "DUPLICATE_TOOL_RESULT");
        dropped.push({
          fragmentType: "tool_result",
          reasonCode: "DUPLICATE_TOOL_RESULT",
          messageId,
          toolCallId: candidate.toolCallId,
        });
        continue;
      }
      toolResults.add(candidate.toolCallId);
    }

    sanitizedHistory.push({
      ...candidate,
      id: messageId,
      role: candidate.role,
      ...(blocks.blocks ? { contentBlocks: blocks.blocks } : {}),
    });
  }

  for (const toolCallId of toolCalls) {
    if (!toolResults.has(toolCallId)) {
      addUniqueReason(hardReasons, "UNMATCHED_TOOL_CALL");
      diagnostics.push(
        redactedDiagnostic("UNMATCHED_TOOL_CALL", { toolCallId })
      );
    }
  }

  if (hardReasons.length > 0) {
    return { status: "parked", reasonCodes: hardReasons, diagnostics };
  }
  if (dropped.length > 0) {
    return {
      status: "sanitized",
      history: sanitizedHistory,
      dropped,
      reasonCodes: reasons,
    };
  }
  return { status: "valid", history: sanitizedHistory };
}
