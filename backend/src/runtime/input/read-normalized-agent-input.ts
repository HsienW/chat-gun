import { BaseMessage } from "@langchain/core/messages";

import { getLatestUserMessage } from "../../state.js";

import {
  createRawInputReference,
  parseNormalizedAgentInput,
  type NormalizedAgentInput,
  type NormalizedInputErrorCode,
  type RawInputReference,
} from "./normalized-agent-input.js";

export type ReadNormalizedAgentInputResult =
  | {
      status: "valid";
      input: Exclude<NormalizedAgentInput, { kind: "command" }>;
      rawInputRef: RawInputReference;
    }
  | {
      status: "invalid";
      errorCode: NormalizedInputErrorCode | "input_kind_conflict";
    }
  | {
      status: "unsupported";
      errorCode: "unsupported_command";
      input: Extract<NormalizedAgentInput, { kind: "command" }>;
      rawInputRef: RawInputReference;
    };

export function readNormalizedAgentInput(
  rawInput: unknown,
  config?: unknown,
): ReadNormalizedAgentInputResult {
  const metadata = readClientInteractionMetadata(config);
  const rawKind = readStringProperty(rawInput, "kind");
  const metadataKind = readStringProperty(metadata, "inputKind");

  if (rawKind && metadataKind && rawKind !== metadataKind) {
    return { status: "invalid", errorCode: "input_kind_conflict" };
  }

  const candidate = adaptCandidate(rawInput, metadata, rawKind ?? metadataKind);
  const parsed = parseNormalizedAgentInput(candidate);
  if (!parsed.ok) {
    return { status: "invalid", errorCode: parsed.errorCode };
  }
  if (parsed.input.kind === "command") {
    return {
      status: "unsupported",
      errorCode: "unsupported_command",
      input: parsed.input,
      rawInputRef: createRawInputReference(rawInput),
    };
  }

  return {
    status: "valid",
    input: parsed.input,
    rawInputRef: createRawInputReference(rawInput),
  };
}

function adaptCandidate(
  rawInput: unknown,
  metadata: Record<string, unknown> | undefined,
  kind: string | undefined,
): unknown {
  if (kind === "clarification_resume") {
    return {
      kind,
      interruptId:
        readStringProperty(rawInput, "interruptId") ??
        readStringProperty(metadata, "interruptId"),
      value: readResumeValue(rawInput),
    };
  }

  if (kind === "cancel") {
    const targetRunId =
      readStringProperty(rawInput, "targetRunId") ??
      readStringProperty(metadata, "targetRunId");
    return targetRunId ? { kind, targetRunId } : { kind };
  }

  if (kind === "command") {
    return rawInput;
  }

  if (kind !== undefined && kind !== "prompt") {
    return { kind };
  }

  if (isRecord(rawInput) && rawInput.kind === "prompt") {
    if (typeof rawInput.text === "string") {
      return rawInput;
    }
    return {
      kind: "prompt",
      text: readLatestHumanText(rawInput.messages),
      attachments: readAttachments(rawInput.attachments, metadata),
    };
  }

  if (typeof rawInput === "string") {
    return { kind: "prompt", text: rawInput, attachments: [] };
  }

  if (isRecord(rawInput) && "messages" in rawInput) {
    return {
      kind: "prompt",
      text: readLatestHumanText(rawInput.messages),
      attachments: readAttachments(rawInput.attachments, metadata),
    };
  }

  return { kind: "prompt", text: "", attachments: [] };
}

function readClientInteractionMetadata(
  config: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const configurable = config.configurable;
  if (!isRecord(configurable)) {
    return undefined;
  }
  const metadata = configurable.clientInteractionMetadata;
  return isRecord(metadata) ? metadata : undefined;
}

function readResumeValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  if ("resume" in value) {
    return value.resume;
  }
  const command = value.command;
  return isRecord(command) ? command.resume : undefined;
}

function readLatestHumanText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  const langChainMessages = value.filter(
    (message): message is BaseMessage => message instanceof BaseMessage,
  );
  if (langChainMessages.length > 0) {
    return getLatestUserMessage(langChainMessages);
  }

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message: unknown = value[index];
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function readAttachments(
  rawAttachments: unknown,
  metadata: Record<string, unknown> | undefined,
): unknown[] {
  const value = rawAttachments ?? metadata?.attachments;
  return Array.isArray(value) ? value : [];
}

function readStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nestedValue = value[property];
  return typeof nestedValue === "string" ? nestedValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
