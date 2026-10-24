import { describe, expect, it } from 'vitest';

import fixture from './__fixtures__/shopping-card-events.json';
import { runtimeEnvelopeToAgentRuntimeEvent } from './agent-runtime-events';
import { extractIncomingRuntimeEventResults } from './legacy-event-adapter';
import {
  BoundedRuntimeEventBuffer,
  type RuntimeEventEnvelope,
} from './runtime-event-envelope';

/** Envelopes produced by the backend shopping card producer; the backend test asserts equality. */
const updates = fixture.updates as Record<string, unknown>[];

function versioned(update: Record<string, unknown>): RuntimeEventEnvelope[] {
  return extractIncomingRuntimeEventResults(update, { enabled: true }).flatMap((result) =>
    result.kind === 'versioned' ? [result.envelope] : []
  );
}

describe('shopping assistant card events', () => {
  it('parses every backend card envelope from a node update', () => {
    for (const update of updates) {
      const results = extractIncomingRuntimeEventResults(update, { enabled: true });
      expect(results.every((result) => result.kind === 'versioned')).toBe(true);
    }
  });

  it('releases cards in order per run, restarts at 1 for a new run and drops a replay', () => {
    const buffer = new BoundedRuntimeEventBuffer();
    const released = updates.map((update) =>
      versioned(update).flatMap((envelope) => buffer.push(envelope).events)
    );

    expect(released[0]?.map((envelope) => [envelope.context.runId, envelope.sequence])).toEqual([
      ['run-1', 1],
      ['run-1', 2],
    ]);
    expect(released[1]?.map((envelope) => [envelope.context.runId, envelope.sequence])).toEqual([
      ['run-2', 1],
    ]);
    expect(released[2]).toEqual([]);
    expect(buffer.bufferedEventCount).toBe(0);
  });

  it('maps a card envelope to the existing card event with its payload intact', () => {
    const [envelope] = versioned(updates[0] as Record<string, unknown>);
    const event = runtimeEnvelopeToAgentRuntimeEvent(envelope as RuntimeEventEnvelope);

    expect(event).toMatchObject({
      type: 'agent.card.emit',
      cardType: 'product_result',
      payload: { schemaVersion: 'product_result@1', sourceId: 'product-hp-1001', citationId: 'c1' },
    });
  });

  it('treats the cards as legacy values when the envelope switch is off', () => {
    const results = extractIncomingRuntimeEventResults(updates[0] as Record<string, unknown>, {
      enabled: false,
    });

    expect(results.every((result) => result.kind === 'legacy')).toBe(true);
  });
});
