import { describe, expect, it } from 'vitest';

import {
  BoundedRuntimeEventBuffer,
  parseRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
} from './runtime-event-envelope';

function createEnvelope(
  sequence = 1,
  eventId = `event-${sequence}`,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    eventId,
    sequence,
    type: 'model.stream',
    emittedAt: '2026-09-27T00:00:00.000Z',
    context: {
      requestId: 'request-1',
      threadId: 'thread-1',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      principalId: 'principal-1',
      tenantId: 'tenant-1',
      scopeId: 'tenant-1',
      scopeType: 'tenant',
    },
    payload: { delta: `chunk-${sequence}` },
    ...overrides,
  };
}

function parseEnvelope(sequence: number, eventId = `event-${sequence}`): RuntimeEventEnvelope {
  const parsed = parseRuntimeEventEnvelope(createEnvelope(sequence, eventId));
  if (parsed.kind !== 'versioned') throw new Error('Expected versioned envelope');
  return parsed.envelope;
}

describe('parseRuntimeEventEnvelope', () => {
  it('validates every required envelope field', () => {
    expect(parseRuntimeEventEnvelope(createEnvelope())).toEqual(
      expect.objectContaining({
        kind: 'versioned',
        envelope: expect.objectContaining({ eventId: 'event-1', sequence: 1 }),
      })
    );
  });

  it.each(['eventId', 'sequence', 'context', 'payload'])(
    'degrades a missing %s to invalid_envelope',
    (field) => {
      const envelope = createEnvelope();
      delete envelope[field];
      expect(parseRuntimeEventEnvelope(envelope)).toEqual({
        kind: 'unknown',
        reason: 'invalid_envelope',
      });
    }
  );

  it('partially parses additive fields from the same major version', () => {
    const parsed = parseRuntimeEventEnvelope(
      createEnvelope(1, 'event-1', {
        schemaVersion: '1.7.3',
        futureOptionalField: { ignored: true },
      })
    );

    expect(parsed.kind).toBe('versioned');
    expect(parsed.kind === 'versioned' && parsed.envelope.schemaVersion).toBe('1.7.3');
  });

  it('degrades a different major without throwing', () => {
    expect(
      parseRuntimeEventEnvelope(createEnvelope(1, 'event-1', { schemaVersion: '2.0.0' }))
    ).toEqual({ kind: 'unknown', reason: 'unsupported_schema_version' });
  });

  it('degrades an unknown event type without throwing', () => {
    expect(
      parseRuntimeEventEnvelope(createEnvelope(1, 'event-1', { type: 'future.event' }))
    ).toEqual({ kind: 'unknown', reason: 'unknown_type', originalType: 'future.event' });
  });
});

describe('BoundedRuntimeEventBuffer', () => {
  it('delivers a duplicate eventId only once', () => {
    const buffer = new BoundedRuntimeEventBuffer();
    const event = parseEnvelope(1);

    expect(buffer.push(event).events).toEqual([event]);
    expect(buffer.push(event)).toEqual({
      events: [],
      observations: [{ code: 'events.duplicate.ignored', runId: 'run-1' }],
    });
  });

  it('converges out-of-order events to sequence order', () => {
    const buffer = new BoundedRuntimeEventBuffer({ windowSize: 4 });
    const second = parseEnvelope(2);
    const first = parseEnvelope(1);

    expect(buffer.push(second).events).toEqual([]);
    expect(buffer.push(first).events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('forwards a gap at the bounded window with an observable reason', () => {
    const buffer = new BoundedRuntimeEventBuffer({ windowSize: 2 });
    const third = parseEnvelope(3);

    expect(buffer.push(third)).toEqual({
      events: [third],
      observations: [
        {
          code: 'events.reorder.forwarded',
          runId: 'run-1',
          expectedSequence: 1,
          forwardedSequence: 3,
        },
      ],
    });
    expect(buffer.bufferedEventCount).toBe(0);
  });

  it('bounds the dedup set and run buffers', () => {
    const buffer = new BoundedRuntimeEventBuffer({
      maxSeenEventIds: 2,
      maxRuns: 1,
    });
    buffer.push(parseEnvelope(1, 'event-1'));
    buffer.push(parseEnvelope(2, 'event-2'));
    buffer.push(parseEnvelope(3, 'event-3'));

    expect(buffer.seenEventIdCount).toBe(2);
    expect(buffer.runCount).toBe(1);
  });
});
