import { isDeepStrictEqual } from "node:util";
import { GraphRecursionError, isGraphInterrupt } from "@langchain/langgraph";

import { parseRuntimeEventEnvelope, projectExecutionEventContext } from "../event-envelope.js";
import { isRuntimeEventType, parseRuntimeEventPayload, type JsonValue } from "../event-payloads.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { CheckpointCompatibilityPolicy } from "../persistence/checkpoint-adapter-metadata.js";
import { isRunTerminalStatus, type RunStatus } from "../run-status.js";
import { FrameworkAdapterError } from "./bounded-operation.js";
import { createReferenceAdapter } from "./reference-adapter.js";
import type { FrameworkInvocation, FrameworkOutcome } from "./registry.js";

const MAX_EVENT_PAYLOAD_DEPTH = 32;
function parseJsonPayload(value: unknown, depth = MAX_EVENT_PAYLOAD_DEPTH): JsonValue {
  if (depth < 0) throw new FrameworkAdapterError("ADAPTER_EVENT_LIMIT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => parseJsonPayload(item, depth - 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonPayload(item, depth - 1)]));
  }
  throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
}

/** Preserve native interrupt control flow; expose a safe, typed node failure. */
export function guardLangGraphNode<Args extends unknown[], Output>(node: (...args: Args) => Promise<Output>) {
  return async (...args: Args): Promise<Output> => {
    try { return await node(...args); }
    catch (error) {
      if (isGraphInterrupt(error) || error instanceof FrameworkAdapterError) throw error;
      throw new FrameworkAdapterError("ADAPTER_NODE_FAILED");
    }
  };
}

/** Internal custom-stream consumer. The trusted X19 producer owns normalization and identity. */
export function createLangGraphStreamAdapter(host: {
  adapterId: string;
  timeoutMs: number;
  maxEvents: number;
  maxBufferedEvents: number;
  maxEventBytes: number;
  policy(request: FrameworkInvocation): CheckpointCompatibilityPolicy;
  initialSequence(request: FrameworkInvocation): number;
  authorizeResume(request: FrameworkInvocation): Promise<boolean>;
  open(mode: "invoke" | "resume", request: FrameworkInvocation): Promise<AsyncIterable<unknown>>;
  readStatus(request: FrameworkInvocation): Promise<RunStatus>;
  outcome(request: FrameworkInvocation): Promise<FrameworkOutcome>;
  contextForEvent?: (eventId: string, request: FrameworkInvocation) => ExecutionContext;
}) {
  if (![host.maxEvents, host.maxBufferedEvents, host.maxEventBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
    throw new FrameworkAdapterError("ADAPTER_EVENT_LIMIT");
  }
  return createReferenceAdapter({
    adapterId: host.adapterId, timeoutMs: host.timeoutMs, policy: host.policy,
    execute: async (mode, request) => {
      if (mode === "resume" && !(await host.authorizeResume(request))) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
      if (request.signal.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
      let nextSequence = host.initialSequence(request) + 1;
      if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
      type Event = Omit<ReturnType<typeof parseRuntimeEventEnvelope>, "payload"> & { payload: JsonValue };
      const seen = new Map<string, Event>();
      const pending = new Map<number, Event>();
      let terminalStatus: RunStatus | undefined;
      let source: AsyncIterable<unknown>;
      try { source = await host.open(mode, request); }
      catch (error) {
        if (error instanceof FrameworkAdapterError) throw error;
        if (error instanceof GraphRecursionError) throw new FrameworkAdapterError("ADAPTER_STEP_LIMIT");
        throw new FrameworkAdapterError("ADAPTER_INITIALIZATION_FAILED");
      }
      try {
        for await (const raw of source) {
          if (request.signal.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
          if (terminalStatus) continue;
          let event: Event;
          try {
            const parsed = parseRuntimeEventEnvelope(raw);
            event = { ...parsed, payload: parseJsonPayload(parsed.payload) };
            if (isRuntimeEventType(event.type)) parseRuntimeEventPayload(event.type, event.payload);
          } catch (error) {
            if (error instanceof FrameworkAdapterError) throw error;
            throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
          }
          if (Buffer.byteLength(JSON.stringify(event)) > host.maxEventBytes) throw new FrameworkAdapterError("ADAPTER_EVENT_LIMIT");
          const trusted = host.contextForEvent?.(event.eventId, request) ?? request.context;
          const product = projectExecutionEventContext(request.context);
          const expected = projectExecutionEventContext(trusted);
          for (const key of ["requestId", "threadId", "runId", "taskId", "principalId", "tenantId", "scopeId", "scopeType"] as const) {
            if (expected[key] !== product[key]) throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
          }
          if (!isDeepStrictEqual(event.context, expected)) throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
          const duplicate = seen.get(event.eventId);
          if (duplicate) {
            if (!isDeepStrictEqual(duplicate, event)) throw new FrameworkAdapterError("ADAPTER_EVENT_CONFLICT");
            continue;
          }
          if (seen.size >= host.maxEvents || event.sequence - nextSequence > host.maxBufferedEvents) throw new FrameworkAdapterError("ADAPTER_EVENT_LIMIT");
          if (event.sequence < nextSequence || pending.has(event.sequence)) throw new FrameworkAdapterError("ADAPTER_EVENT_CONFLICT");
          seen.set(event.eventId, event);
          pending.set(event.sequence, event);
          if (pending.size > host.maxBufferedEvents) throw new FrameworkAdapterError("ADAPTER_EVENT_LIMIT");
          while (pending.has(nextSequence) && !terminalStatus) {
            const ordered = pending.get(nextSequence);
            if (!ordered) throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
            if (request.signal.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
            if (ordered.type === "run.terminal") {
              const authority = await host.readStatus(request);
              const payload = ordered.payload;
              if (!isRunTerminalStatus(authority) || payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.status !== authority) {
                throw new FrameworkAdapterError("ADAPTER_EVENT_INVALID");
              }
              terminalStatus = authority;
            }
            await request.observe({ kind: "event", event: { ...ordered, payload: parseJsonPayload(ordered.payload) } });
            pending.delete(nextSequence++);
            if (terminalStatus && isRunTerminalStatus(terminalStatus)) {
              pending.clear();
              await request.observe({ kind: "terminal", status: terminalStatus });
            }
          }
        }
      } catch (error) {
        if (error instanceof FrameworkAdapterError) throw error;
        if (error instanceof GraphRecursionError) throw new FrameworkAdapterError("ADAPTER_STEP_LIMIT");
        throw new FrameworkAdapterError("ADAPTER_STREAM_INTERRUPTED");
      }
      const outcome = await host.outcome(request);
      if (outcome.status === "waiting" && !terminalStatus && pending.size === 0 && await host.readStatus(request) === "needs_user") return outcome;
      if (!terminalStatus || pending.size > 0) throw new FrameworkAdapterError("ADAPTER_STREAM_INTERRUPTED");
      if ((outcome.status === "completed") !== (terminalStatus === "completed") || outcome.status === "waiting") throw new FrameworkAdapterError("ADAPTER_EVENT_CONFLICT");
      return outcome;
    },
  });
}
