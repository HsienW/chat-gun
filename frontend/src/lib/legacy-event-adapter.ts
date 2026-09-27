import {
  parseRuntimeEventEnvelope,
  type RuntimeEventParseResult,
} from './runtime-event-envelope';

export type IncomingRuntimeEventResult =
  | RuntimeEventParseResult
  | { kind: 'legacy'; value: unknown };

export interface IncomingRuntimeEventOptions {
  enabled?: boolean;
}

export function getRuntimeEventEnvelopeEnabled(
  rawValue: unknown = import.meta.env.VITE_RUNTIME_EVENT_ENVELOPE_ENABLED
): boolean {
  if (rawValue === undefined || rawValue === '') return true;
  if (typeof rawValue !== 'string') return false;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return false;
}

export function parseIncomingRuntimeEvent(
  value: unknown,
  options: IncomingRuntimeEventOptions = {}
): IncomingRuntimeEventResult {
  const enabled = options.enabled ?? getRuntimeEventEnvelopeEnabled();
  if (!enabled) return { kind: 'legacy', value };

  const record = asRecord(value);
  if (!record || typeof record.schemaVersion !== 'string') {
    return { kind: 'legacy', value };
  }
  return parseRuntimeEventEnvelope(value);
}

export function extractIncomingRuntimeEventResults(
  event: Record<string, unknown>,
  options: IncomingRuntimeEventOptions = {}
): IncomingRuntimeEventResult[] {
  return [event, ...Object.values(event)].flatMap((container) => {
    const runtimeEvents = asRecord(container)?.runtimeEvents;
    return Array.isArray(runtimeEvents)
      ? runtimeEvents.map((value) => parseIncomingRuntimeEvent(value, options))
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
