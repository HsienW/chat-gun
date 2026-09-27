import { describe, expect, it } from 'vitest';

import {
  extractIncomingRuntimeEventResults,
  getRuntimeEventEnvelopeEnabled,
  parseIncomingRuntimeEvent,
} from './legacy-event-adapter';

const versionedEnvelope = {
  schemaVersion: '1.0.0',
  eventId: 'event-1',
  sequence: 1,
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
  payload: { delta: 'hello' },
};

describe('frontend legacy runtime event adapter', () => {
  it('accepts a versioned envelope when enabled', () => {
    expect(parseIncomingRuntimeEvent(versionedEnvelope, { enabled: true })).toEqual(
      expect.objectContaining({ kind: 'versioned' })
    );
  });

  it('carries legacy TaskEvent and AgentRuntimeEvent without dropping unknown fields', () => {
    const taskEvent = {
      eventType: 'task_created',
      taskId: 'task-1',
      futureOptionalField: 'kept',
    };
    const agentEvent = {
      type: 'agent.answer.stream',
      delta: 'legacy',
      ts: 1,
      futureOptionalField: 'kept',
    };

    expect(parseIncomingRuntimeEvent(taskEvent, { enabled: true })).toEqual({
      kind: 'legacy',
      value: taskEvent,
    });
    expect(parseIncomingRuntimeEvent(agentEvent, { enabled: true })).toEqual({
      kind: 'legacy',
      value: agentEvent,
    });
  });

  it('forces even versioned-looking values through legacy mode when disabled', () => {
    expect(parseIncomingRuntimeEvent(versionedEnvelope, { enabled: false })).toEqual({
      kind: 'legacy',
      value: versionedEnvelope,
    });
  });

  it('degrades an invalid versioned envelope without throwing', () => {
    expect(
      parseIncomingRuntimeEvent(
        { ...versionedEnvelope, sequence: 0 },
        { enabled: true }
      )
    ).toEqual({ kind: 'unknown', reason: 'invalid_envelope' });
  });

  it('extracts direct and one-level nested runtime event arrays', () => {
    expect(
      extractIncomingRuntimeEventResults(
        {
          runtimeEvents: [versionedEnvelope],
          node: {
            runtimeEvents: [
              { type: 'agent.answer.stream', delta: 'legacy', ts: 1 },
            ],
          },
        },
        { enabled: true }
      ).map((result) => result.kind)
    ).toEqual(['versioned', 'legacy']);
  });
});

describe('frontend runtime event flag', () => {
  it('defaults to enabled and accepts explicit values', () => {
    expect(getRuntimeEventEnvelopeEnabled(undefined)).toBe(true);
    expect(getRuntimeEventEnvelopeEnabled('true')).toBe(true);
    expect(getRuntimeEventEnvelopeEnabled('false')).toBe(false);
  });

  it('fails closed to legacy mode for an invalid public setting', () => {
    expect(getRuntimeEventEnvelopeEnabled('sometimes')).toBe(false);
  });
});
