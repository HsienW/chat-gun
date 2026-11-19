import { randomUUID } from "node:crypto";

import {
  createAnswerTextSink,
  recordAnswerStreamDegraded,
  type AnswerStreamDegradedReason,
  type AnswerTextSink,
  type AnswerTextSinkObserver,
} from "../../platform/answer-text-sink.js";
import { getAgentRuntimeConfig } from "../../platform/runtime-config.js";
import { emitEnvelope } from "../emit-envelope.js";
import { RunSequenceAllocator } from "../event-sequence.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import { readCanonicalExecutionContext } from "../execution-context/read-execution-context.js";

/**
 * Runtime side of answer streaming (stream-chat-answer-text design D4): builds the Gateway sink
 * from the trusted ExecutionContext and an injected allocator, and publishes each fragment as a
 * versioned `model.stream` envelope through the LangGraph custom writer.
 */

/**
 * Process-scoped allocator for answer events. A single LangGraph worker process is assumed
 * (design KL-1); graphs receive it at composition and nodes never create their own.
 */
export const answerStreamSequenceAllocator = new RunSequenceAllocator();

export type AnswerStreamSettings = { enabled: boolean; envelopeEnabled: boolean };

export type AnswerStreamPreparation =
  | { kind: "stream"; messageId: string; sink: AnswerTextSink }
  | { kind: "whole"; reason: AnswerStreamDegradedReason };

export type AnswerStreamWiringDependencies = {
  sequenceAllocator: RunSequenceAllocator;
  readSettings?: () => AnswerStreamSettings;
  /** False when the call cannot request the response format required by its sink. */
  supportsAnswerSink?: boolean;
  createMessageId?: () => string;
  now?: () => Date;
  observer?: AnswerTextSinkObserver;
};

/** Only the custom writer and the trusted context are read from the node config. */
export type AnswerStreamNodeConfig = { writer?: (chunk: unknown) => void; configurable?: unknown };

function defaultSettings(): AnswerStreamSettings {
  const config = getAgentRuntimeConfig();
  return { enabled: config.answerTextStreamingEnabled, envelopeEnabled: config.runtimeEventEnvelopeEnabled };
}

function readContext(config: AnswerStreamNodeConfig): ExecutionContext | undefined {
  try {
    return readCanonicalExecutionContext(config);
  } catch {
    // An unreadable context is treated as missing wiring; the run keeps the whole reply.
    return undefined;
  }
}

export function createAnswerStreamWiring(dependencies: AnswerStreamWiringDependencies) {
  const readSettings = dependencies.readSettings ?? defaultSettings;
  const createMessageId = dependencies.createMessageId ?? randomUUID;

  async function degrade(reason: AnswerStreamDegradedReason): Promise<AnswerStreamPreparation> {
    await recordAnswerStreamDegraded(reason, {}, dependencies.observer);
    return { kind: "whole", reason };
  }

  return {
    /** Decided before generation starts; the message id is allocated here and reused by the final message. */
    async prepare(config: AnswerStreamNodeConfig): Promise<AnswerStreamPreparation> {
      const settings = readSettings();
      if (!settings.enabled) return degrade("feature_disabled");
      if (!settings.envelopeEnabled) return degrade("envelope_disabled");
      if (dependencies.supportsAnswerSink === false) return degrade("capability_unsupported");
      const executionContext = readContext(config);
      if (!executionContext) return degrade("execution_context_missing");
      const writer = config.writer;
      if (typeof writer !== "function") return degrade("writer_missing");

      const messageId = createMessageId();
      const sink = createAnswerTextSink({
        messageId,
        observer: dependencies.observer,
        publish: async ({ delta, textOffset }) => {
          const envelope = await emitEnvelope({
            type: "model.stream",
            payload: { delta, messageId, outputKind: "answer_text", textOffset },
            executionContext,
            sequenceAllocator: dependencies.sequenceAllocator,
            legacyEvent: undefined,
            runtimeEventEnvelopeEnabled: true,
            ...(dependencies.now ? { now: dependencies.now } : {}),
          });
          writer(envelope);
        },
      });
      return { kind: "stream", messageId, sink };
    },
  };
}

export type AnswerStreamWiring = ReturnType<typeof createAnswerStreamWiring>;

const wiredGraphs = new Set<string>();

/** Called by a graph's composition once its node is wired with context and allocator. */
export function registerAnswerStreamGraph(graphId: string): void {
  wiredGraphs.add(graphId);
}

export const ANSWER_STREAM_REQUIRED_GRAPHS = ["chatbot", "deep_researcher", "shopping_assistant"] as const;

export type AnswerStreamReadiness = { ready: boolean; reasonCodes: string[] };

/** Enabled but unwired fails readiness instead of silently degrading every request (design D4, D9). */
export function evaluateAnswerStreamReadiness(
  settings: AnswerStreamSettings = defaultSettings(),
  graphs: ReadonlySet<string> = wiredGraphs,
): AnswerStreamReadiness {
  if (!settings.enabled) return { ready: true, reasonCodes: [] };
  const reasonCodes: string[] = [];
  if (!settings.envelopeEnabled) reasonCodes.push("answer_stream_envelope_disabled");
  if (ANSWER_STREAM_REQUIRED_GRAPHS.some((graphId) => !graphs.has(graphId))) {
    reasonCodes.push("answer_stream_wiring_missing");
  }
  return { ready: reasonCodes.length === 0, reasonCodes };
}
