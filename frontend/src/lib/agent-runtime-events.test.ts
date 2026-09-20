import { describe, expect, it, vi } from 'vitest';

import {
  extractAgentRuntimeEvents,
  extractDirectAgentRuntimeEvents,
  extractNestedAgentRuntimeEvents,
  extractNodeAdapterRuntimeEvents,
  extractTaskEventActiveRunHint,
  extractTaskEventGeneration,
  extractWeatherClarificationInterruptToolResult,
  isLangGraphInterruptEvent,
  runtimeEventToProcessedEvent,
} from '@/lib/agent-runtime-events';

describe('extractTaskEventGeneration', () => {
  it('reads the standard task event payload generation without coercion', () => {
    expect(
      extractTaskEventGeneration({
        event: 'task_event',
        data: { eventType: 'superseded', payload: { generation: 7 } },
      })
    ).toBe(7);
    expect(
      extractTaskEventGeneration({ payload: { generation: '7' } })
    ).toBeUndefined();
  });

  it('extracts the authoritative replacement run hint from a nested interaction event', () => {
    expect(
      extractTaskEventActiveRunHint({
        interaction_runtime: {
          taskEvent: {
            eventType: 'superseded',
            payload: {
              priorRunId: 'run-1',
              replacementRunId: 'run-2',
              generation: 8,
            },
          },
        },
      })
    ).toEqual({ runId: 'run-2', generation: 8 });
  });

  it('rejects incomplete or non-positive active-run hints', () => {
    expect(
      extractTaskEventActiveRunHint({
        eventType: 'queued',
        payload: { priorRunId: 'run-1', generation: 0 },
      })
    ).toBeUndefined();
    expect(
      extractTaskEventActiveRunHint({
        eventType: 'queued',
        payload: { generation: 1 },
      })
    ).toBeUndefined();
    expect(
      extractTaskEventActiveRunHint({
        eventType: 'superseded',
        payload: { replacementRunId: '../../invalid', generation: 2 },
      })
    ).toBeUndefined();
  });
});

describe('agent runtime event extraction', () => {
  it('preserves valid canonical correlation and accepts legacy events without it', () => {
    expect(extractDirectAgentRuntimeEvents({ runtimeEvents: [{
      type: 'agent.plan.start',
      title: 'Plan',
      ts: 100,
      correlation: { requestId: 'request-1', threadId: 'thread-1', runId: 'run-1' },
      futureField: 'ignored',
    }] })).toEqual([{
      type: 'agent.plan.start',
      title: 'Plan',
      ts: 100,
      correlation: { requestId: 'request-1', threadId: 'thread-1', runId: 'run-1' },
    }]);
    expect(extractDirectAgentRuntimeEvents({ runtimeEvents: [{
      type: 'agent.plan.start', title: 'Old', ts: 101,
    }] })).toEqual([{ type: 'agent.plan.start', title: 'Old', ts: 101 }]);
  });

  it('drops malformed correlation without dropping a valid event', () => {
    expect(extractDirectAgentRuntimeEvents({ runtimeEvents: [{
      type: 'agent.plan.start', title: 'Plan', ts: 100,
      correlation: { requestId: 'bad id', threadId: 'thread-1', runId: 'run-1' },
    }] })).toEqual([{ type: 'agent.plan.start', title: 'Plan', ts: 100 }]);
  });

  it('extracts direct runtime events from raw stream updates', () => {
    const events = extractDirectAgentRuntimeEvents({
      runtimeEvents: [{ type: 'agent.plan.start', title: 'Plan', ts: 100 }],
    });

    expect(events).toEqual([{ type: 'agent.plan.start', title: 'Plan', ts: 100 }]);
  });

  it('extracts nested runtime events from node values', () => {
    const events = extractNestedAgentRuntimeEvents({
      plan_research: {
        runtimeEvents: [{ type: 'agent.answer.stream', delta: 'partial', ts: 200 }],
      },
    });

    expect(events).toEqual([
      { type: 'agent.answer.stream', delta: 'partial', ts: 200 },
    ]);
  });

  it('adapts known node payloads when direct runtime events are absent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(300);

    const events = extractNodeAdapterRuntimeEvents({
      plan_research: { plan: { answerMode: 'fast' } },
    });

    expect(events).toEqual([
      {
        type: 'agent.plan.start',
        title: '研究規劃: fast',
        ts: 300,
      },
    ]);
  });

  it('skips node adapter fallback when a known node already contains runtime events', () => {
    vi.spyOn(Date, 'now').mockReturnValue(400);

    const events = extractAgentRuntimeEvents({
      plan_research: {
        plan: { answerMode: 'fast' },
        runtimeEvents: [{ type: 'agent.plan.start', title: 'Existing plan', ts: 401 }],
      },
    });

    expect(events).toEqual([
      { type: 'agent.plan.start', title: 'Existing plan', ts: 401 },
    ]);
  });

  it('skips malformed values while continuing valid events in the same update', () => {
    const events = extractAgentRuntimeEvents({
      runtimeEvents: [
        null,
        { type: 'not.agent.event', ts: 1 },
        { type: 'agent.tool.success', output: 'missing required fields', ts: 2 },
        {
          type: 'agent.tool.success',
          toolName: 'search',
          output: 'ok',
          costMs: 12,
          ts: 3,
        },
      ],
    });

    expect(events).toEqual([
      {
        type: 'agent.tool.success',
        toolName: 'search',
        output: 'ok',
        costMs: 12,
        ts: 3,
      },
    ]);
  });

  it('normalizes unknown agent events to generic processed activity items', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500);

    const [event] = extractAgentRuntimeEvents({
      runtimeEvents: [
        {
          type: 'agent.future.event',
          payload: { status: 'future' },
          unsafe: () => 'ignored',
        },
      ],
    });

    expect(event).toEqual({
      type: 'agent.unknown',
      originalType: 'agent.future.event',
      rawPayload: { payload: { status: 'future' } },
      ts: 500,
    });

    expect(runtimeEventToProcessedEvent(event)).toEqual({
      title: '未知流程事件：agent.future.event',
      data: {
        originalType: 'agent.future.event',
        payload: { status: 'future' },
      },
      eventType: 'agent.unknown',
    });
  });

  it('recognizes LangGraph interrupt updates without treating unknown events as failures', () => {
    expect(isLangGraphInterruptEvent({ event: 'interrupt', data: {} })).toBe(true);
    expect(isLangGraphInterruptEvent({ __interrupt__: [{ value: { type: 'weather_clarification' } }] })).toBe(true);
    expect(isLangGraphInterruptEvent({ nested: { __interrupt__: [{ value: {} }] } })).toBe(true);
    expect(isLangGraphInterruptEvent({ event: 'langgraph_future_event', data: {} })).toBe(false);
  });

  it('extracts weather clarification interrupt payloads as renderable tool results', () => {
    const result = extractWeatherClarificationInterruptToolResult({
      __interrupt__: [
        {
          value: {
            type: 'weather_clarification',
            weatherCapability: 'current',
            weatherExecution: {
              status: 'needs_clarification',
              result: {
                schemaVersion: '1.0',
                tool: 'current_weather',
                status: 'needs_clarification',
                requestedLocation: { raw: 'Springfield', location: 'Springfield' },
                candidates: [
                  {
                    name: 'Springfield',
                    displayName: 'Springfield, Illinois, United States',
                    latitude: 39.78,
                    longitude: -89.65,
                  },
                ],
                message: 'Location is ambiguous.',
                summary: 'Location Springfield matches multiple candidates.',
              },
            },
          },
        },
      ],
    });

    expect(result?.toolName).toBe('current_weather');
    expect(result?.toolCallId).toBe('weather-clarification-interrupt');
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({
      tool: 'current_weather',
      status: 'needs_clarification',
    });
  });
});
