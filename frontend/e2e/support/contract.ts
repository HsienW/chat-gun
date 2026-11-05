import {
  parseRuntimeEventEnvelope,
  type RuntimeEventParseResult,
} from '../../src/lib/runtime-event-envelope';
import {
  parseCommerceCard,
  parseToolConfirmationInterrupt,
  type CommerceCard,
} from '../../src/lib/commerce-cards';
import { extractClarificationInterruptId } from '../../src/lib/agent-runtime-events';
import type { ThreadMessage } from './fixture-server';

/**
 * Scenario content builders (design D4). Every envelope, card payload and
 * interrupt is checked with the frontend's own parser when it is built, so a
 * fixture that drifts from the contract fails the test instead of silently
 * exercising nothing. Content that is invalid on purpose must say so through
 * `expect`, and is then checked to be rejected the stated way.
 */

const EMITTED_AT = '2026-10-26T12:00:00.000Z';

export interface EnvelopeInput {
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  eventId?: string;
  /** Extra top-level fields, used to send unknown future fields. */
  extra?: Record<string, unknown>;
  /** Marks content that must not parse as a versioned envelope. */
  expect?: Extract<RuntimeEventParseResult, { kind: 'unknown' }>['reason'];
}

export function envelope(input: EnvelopeInput): Record<string, unknown> {
  const value = {
    schemaVersion: '1.0.0',
    eventId: input.eventId ?? `${input.runId}:event:${input.sequence}`,
    sequence: input.sequence,
    type: input.type,
    emittedAt: EMITTED_AT,
    context: {
      requestId: 'request-e2e',
      threadId: 'thread-e2e',
      runId: input.runId,
      taskId: 'task-1',
      stepId: 'step-1',
      attempt: 1,
      principalId: 'synthetic-shopper-a',
      tenantId: 'synthetic-tenant',
      scopeId: 'synthetic-tenant',
      scopeType: 'tenant',
    },
    payload: input.payload,
    ...input.extra,
  };
  const parsed = parseRuntimeEventEnvelope(value);
  if (input.expect === undefined && parsed.kind !== 'versioned') {
    throw new Error(`scenario envelope ${value.eventId} is not a valid envelope: ${parsed.reason}`);
  }
  if (input.expect !== undefined && (parsed.kind !== 'unknown' || parsed.reason !== input.expect)) {
    throw new Error(`scenario envelope ${value.eventId} was expected to be rejected as ${input.expect}`);
  }
  return value;
}

export interface OperationCardData {
  toolCallId: string;
  operationId?: string;
  kind?: 'refund_request' | 'cancel';
  orderId?: string;
  state: string;
  stateVersion: number;
  approvalExpiresAt?: string;
  dedup?: { reason: string; of?: string };
}

export function operationCardData(input: OperationCardData): Record<string, unknown> {
  return {
    schemaVersion: 'order_operation_status@1',
    operationRef: {
      toolCallId: input.toolCallId,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    },
    kind: input.kind ?? 'refund_request',
    orderRef: { orderId: input.orderId ?? 'ORD-1001' },
    state: input.state,
    stateVersion: input.stateVersion,
    ...(input.approvalExpiresAt ? { approvalExpiresAt: input.approvalExpiresAt } : {}),
    ...(input.dedup ? { dedup: input.dedup } : {}),
  };
}

/** A `card.emit` envelope whose payload must parse as a supported card. */
export function cardEvent(input: {
  runId: string;
  sequence: number;
  cardType: string;
  data: Record<string, unknown>;
  eventId?: string;
}): Record<string, unknown> {
  const card: CommerceCard = parseCommerceCard(input.cardType, input.data);
  if (card.type === 'unsupported') {
    throw new Error(`scenario card ${input.cardType} is not supported: ${card.reason}`);
  }
  return envelope({
    runId: input.runId,
    sequence: input.sequence,
    eventId: input.eventId,
    type: 'card.emit',
    payload: { cardType: input.cardType, data: input.data },
  });
}

/** The server thread state record for an operation (parsed by `parseOperationSnapshot`). */
export function operationSnapshot(input: OperationCardData): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    operationId: input.operationId,
    kind: input.kind ?? 'refund_request',
    orderId: input.orderId ?? 'ORD-1001',
    state: input.state,
    stateVersion: input.stateVersion,
    ...(input.approvalExpiresAt ? { approvalExpiresAt: input.approvalExpiresAt } : {}),
    ...(input.dedup ? { dedup: input.dedup } : {}),
  };
}

export function confirmationInterrupt(input: {
  approvalId: string;
  decisionId: string;
  expiresAt: string;
}): Record<string, unknown> {
  const value = {
    type: 'tool_authorization_confirmation',
    schemaVersion: '1.0',
    approvalId: input.approvalId,
    decisionId: input.decisionId,
    expiresAt: input.expiresAt,
    resumeCompatibility: {
      type: 'tool_authorization_confirmation',
      schemaVersion: '1.0',
      decisions: ['approve', 'deny'],
    },
  };
  if (!parseToolConfirmationInterrupt(value)) {
    throw new Error('scenario confirmation interrupt is not valid');
  }
  return value;
}

export interface ClarificationCandidate {
  name: string;
  displayName: string;
  country?: string;
  latitude: number;
  longitude: number;
}

/** A LangGraph `updates` frame carrying a weather clarification interrupt. */
export function clarificationInterruptUpdate(input: {
  interruptId: string;
  candidates: ClarificationCandidate[];
}): Record<string, unknown> {
  const update = {
    __interrupt__: [
      {
        value: {
          type: 'weather_clarification',
          eventType: 'clarification_requested',
          interruptId: input.interruptId,
          weatherCapability: 'current',
          weatherExecution: {
            status: 'needs_clarification',
            result: {
              schemaVersion: '1.0',
              tool: 'current_weather',
              status: 'needs_clarification',
              requestedLocation: { raw: 'Springfield', location: 'Springfield' },
              candidates: input.candidates,
              message: 'Location is ambiguous.',
              summary: 'Choose a location.',
            },
          },
        },
        resumable: true,
        ns: ['weather:1'],
        when: 'during',
      },
    ],
  };
  if (extractClarificationInterruptId(update) !== input.interruptId) {
    throw new Error('scenario clarification interrupt is not valid');
  }
  return update;
}

/** The BFF-side task event that tells the browser which run is authoritative. */
export function activeRunUpdate(runId: string, generation: number): Record<string, unknown> {
  return {
    interaction_runtime: {
      taskEvent: {
        eventId: `${runId}:task-event:${generation}`,
        taskId: 'task-1',
        eventType: 'superseded',
        payload: {
          schemaVersion: '1.0',
          threadId: 'thread-e2e',
          priorTaskId: 'task-0',
          priorRunId: 'run-0',
          replacementTaskId: 'task-1',
          replacementRunId: runId,
          generation,
        },
        createdAt: EMITTED_AT,
      },
    },
  };
}

/** A BFF ErrorEnvelope with an existing error code (no new codes). */
export function bffError(code: string, message: string): { error: Record<string, string> } {
  return { error: { source: 'bff', stage: 'proxy', code, message } };
}

export function human(text: string, id: string): ThreadMessage {
  return { type: 'human', id, content: text };
}

export function ai(text: string, id: string): ThreadMessage {
  return { type: 'ai', id, content: text };
}
