import {
  RUNTIME_EVENT_LABELS,
  RUNTIME_EVENT_NODE_KEYS,
} from '@/lib/runtime-event-config';
import { isInteractionActiveRunHint } from '@/lib/interaction-request-metadata';
import type { InteractionActiveRunHint } from '@/lib/interaction-request-metadata';
import type {
  AgentRuntimeEvent,
  ContextSource,
  ExecutionEventCorrelation,
} from '@/types/agent-runtime-events';

type ProcessedRuntimeEvent = {
  title: string;
  data: string | string[] | Record<string, unknown>;
  eventType: AgentRuntimeEvent['type'];
};

type RuntimeEventRule = {
  nodeKey: string;
  toEvents: (nodeValue: unknown) => AgentRuntimeEvent[];
};

export type WeatherClarificationInterruptToolResult = {
  toolName: 'current_weather' | 'weather_forecast';
  toolCallId: string;
  content: string;
};

export type TaskEventActiveRunHint = InteractionActiveRunHint;

const KNOWN_RUNTIME_EVENT_TYPES = new Set<AgentRuntimeEvent['type']>([
  'agent.plan.start',
  'agent.tool.start',
  'agent.tool.success',
  'agent.tool.error',
  'agent.context.build',
  'agent.answer.stream',
  'agent.card.emit',
  'agent.unknown',
]);

const NODE_EVENT_RULES: RuntimeEventRule[] = [
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.buildContextPack,
    toEvents: (nodeValue) => [getContextPackEvent(nodeValue)],
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.planResearch,
    toEvents: (nodeValue) => [
      {
        type: 'agent.plan.start',
        title: getPlanTitle(nodeValue),
        ts: Date.now(),
      },
    ],
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.targetedTools,
    toEvents: (nodeValue) => getToolEvents(nodeValue),
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.searchWeb,
    toEvents: (nodeValue) => getToolEvents(nodeValue),
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.fetchSources,
    toEvents: (nodeValue) => getToolEvents(nodeValue),
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.rankSources,
    toEvents: (nodeValue) => [getContextEvent(nodeValue)],
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.extractEvidence,
    toEvents: (nodeValue) => [getContextEvent(nodeValue)],
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.verifyCitations,
    toEvents: (nodeValue) => [getContextEvent(nodeValue)],
  },
  {
    nodeKey: RUNTIME_EVENT_NODE_KEYS.synthesizeAnswer,
    toEvents: (nodeValue) => getAnswerEvents(nodeValue),
  },
];

function stringifyEventData(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(stringifyEventData).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asPositiveGeneration(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function findTaskEventGeneration(value: unknown, depth: number): number | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value) ?? parseJsonRecord(value);
  if (!record) return undefined;

  const payload = asRecord(record.payload);
  if (typeof record.eventType === 'string') {
    const generation = asPositiveGeneration(payload?.generation);
    if (generation !== undefined) return generation;
  }

  for (const key of [
    'interaction_runtime',
    'data',
    'taskEvent',
    'task_event',
    'payload',
  ]) {
    const generation = findTaskEventGeneration(record[key], depth + 1);
    if (generation !== undefined) return generation;
  }
  if (Array.isArray(record.events)) {
    for (const event of record.events) {
      const generation = findTaskEventGeneration(event, depth + 1);
      if (generation !== undefined) return generation;
    }
  }
  return undefined;
}

export function extractTaskEventGeneration(value: unknown): number | undefined {
  return findTaskEventGeneration(value, 0);
}

function findTaskEventActiveRunHint(
  value: unknown,
  depth: number
): TaskEventActiveRunHint | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value) ?? parseJsonRecord(value);
  if (!record) return undefined;

  const payload = asRecord(record.payload);
  if (typeof record.eventType === 'string' && payload) {
    const generation = asPositiveGeneration(payload.generation);
    const runId =
      typeof payload.replacementRunId === 'string' && payload.replacementRunId
        ? payload.replacementRunId
        : typeof payload.priorRunId === 'string' && payload.priorRunId
          ? payload.priorRunId
          : undefined;
    const hint = { runId, generation };
    if (isInteractionActiveRunHint(hint)) return hint;
  }

  for (const key of [
    'interaction_runtime',
    'data',
    'taskEvent',
    'task_event',
    'payload',
  ]) {
    const hint = findTaskEventActiveRunHint(record[key], depth + 1);
    if (hint) return hint;
  }
  if (Array.isArray(record.events)) {
    for (const event of record.events) {
      const hint = findTaskEventActiveRunHint(event, depth + 1);
      if (hint) return hint;
    }
  }
  return undefined;
}

export function extractTaskEventActiveRunHint(
  value: unknown
): TaskEventActiveRunHint | undefined {
  return findTaskEventActiveRunHint(value, 0);
}

function isSerializablePrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function toSafeSerializableValue(value: unknown): unknown {
  if (isSerializablePrimitive(value)) return value;
  if (Array.isArray(value)) {
    return value
      .map(toSafeSerializableValue)
      .filter((item) => item !== undefined);
  }

  const record = asRecord(value);
  if (!record) return undefined;

  return Object.fromEntries(
    Object.entries(record)
      .map(([key, item]) => [key, toSafeSerializableValue(item)] as const)
      .filter(([, item]) => item !== undefined)
  );
}

function getEventTimestamp(record: Record<string, unknown>): number {
  return typeof record.ts === 'number' && Number.isFinite(record.ts)
    ? record.ts
    : Date.now();
}

function getUnknownRawPayload(
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const payloadEntries = Object.entries(record).filter(
    ([key]) => key !== 'type' && key !== 'ts'
  );
  const payload = Object.fromEntries(
    payloadEntries
      .map(([key, value]) => [key, toSafeSerializableValue(value)] as const)
      .filter(([, value]) => value !== undefined)
  );

  return Object.keys(payload).length > 0 ? payload : undefined;
}

const EVENT_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,256}$/;

function parseEventCorrelation(value: unknown): ExecutionEventCorrelation | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { requestId, threadId, runId } = record;
  if (
    typeof requestId !== 'string' || !EVENT_CORRELATION_ID_PATTERN.test(requestId) ||
    typeof threadId !== 'string' || !EVENT_CORRELATION_ID_PATTERN.test(threadId) ||
    typeof runId !== 'string' || !EVENT_CORRELATION_ID_PATTERN.test(runId)
  ) return undefined;
  return { requestId, threadId, runId };
}

function normalizeAgentRuntimeEvent(value: unknown): AgentRuntimeEvent | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const correlation = parseEventCorrelation(record.correlation);
  const correlationFields = correlation ? { correlation } : {};

  const type = record.type;

  if (typeof type !== 'string' || !type.startsWith('agent.')) {
    return undefined;
  }

  if (!KNOWN_RUNTIME_EVENT_TYPES.has(type as AgentRuntimeEvent['type'])) {
    return {
      type: 'agent.unknown',
      originalType: type,
      rawPayload: getUnknownRawPayload(record),
      ts: getEventTimestamp(record),
      ...correlationFields,
    };
  }

  if (type === 'agent.unknown') {
    return typeof record.originalType === 'string'
      ? {
          type,
          originalType: record.originalType,
          rawPayload: asRecord(record.rawPayload),
          ts: getEventTimestamp(record),
          ...correlationFields,
        }
      : undefined;
  }

  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) {
    return undefined;
  }

  switch (type) {
    case 'agent.plan.start':
      return typeof record.title === 'string'
        ? { type, title: record.title, ts: record.ts, ...correlationFields }
        : undefined;
    case 'agent.tool.start':
      return typeof record.toolName === 'string'
        ? {
            type,
            toolName: record.toolName,
            input: record.input,
            ts: record.ts,
            ...correlationFields,
          }
        : undefined;
    case 'agent.tool.success':
      return typeof record.toolName === 'string' && typeof record.costMs === 'number'
        ? {
            type,
            toolName: record.toolName,
            output: record.output,
            costMs: record.costMs,
            ts: record.ts,
            ...correlationFields,
          }
        : undefined;
    case 'agent.tool.error':
      return typeof record.toolName === 'string' && typeof record.error === 'string'
        ? {
            type,
            toolName: record.toolName,
            error: record.error,
            ts: record.ts,
            ...correlationFields,
          }
        : undefined;
    case 'agent.context.build':
      return Array.isArray(record.sources) && typeof record.tokenEstimate === 'number'
        ? {
            type,
            sources: record.sources as ContextSource[],
            tokenEstimate: record.tokenEstimate,
            ts: record.ts,
            ...correlationFields,
          }
        : undefined;
    case 'agent.answer.stream':
      return typeof record.delta === 'string'
        ? { type, delta: record.delta, ts: record.ts, ...correlationFields }
        : undefined;
    case 'agent.card.emit':
      return typeof record.cardType === 'string'
        ? {
            type,
            cardType: record.cardType,
            payload: record.payload,
            ts: record.ts,
            ...correlationFields,
          }
        : undefined;
  }
}

function getNodeMessages(nodeValue: unknown): unknown[] {
  const messages = asRecord(nodeValue)?.messages;
  return Array.isArray(messages) ? messages : [];
}

function getRuntimeEvents(value: unknown): AgentRuntimeEvent[] {
  const runtimeEvents = asRecord(value)?.runtimeEvents;
  return Array.isArray(runtimeEvents)
    ? runtimeEvents.flatMap((event) => {
        const normalized = normalizeAgentRuntimeEvent(event);
        return normalized ? [normalized] : [];
      })
    : [];
}

export function isAgentRuntimeEvent(value: unknown): value is AgentRuntimeEvent {
  return normalizeAgentRuntimeEvent(value) !== undefined;
}

function getPlanTitle(nodeValue: unknown): string {
  const plan = asRecord(asRecord(nodeValue)?.plan);
  const mode = typeof plan?.answerMode === 'string' ? plan.answerMode : undefined;
  return mode ? `${RUNTIME_EVENT_LABELS.plan}: ${mode}` : RUNTIME_EVENT_LABELS.plan;
}

function getToolName(message: unknown, fallback: string): string {
  const record = asRecord(message);
  return typeof record?.name === 'string' && record.name.trim()
    ? record.name
    : fallback;
}

function isErrorOutput(value: unknown): boolean {
  const text = stringifyEventData(value);
  return text.startsWith('Error:') || text.includes('"error"');
}

function getToolEvents(nodeValue: unknown): AgentRuntimeEvent[] {
  const messages = getNodeMessages(nodeValue);
  const fallbackToolName =
    typeof asRecord(nodeValue)?.toolName === 'string'
      ? String(asRecord(nodeValue)?.toolName)
      : 'tool';

  return messages.map((message) => {
    const record = asRecord(message);
    const toolName = getToolName(message, fallbackToolName);
    const content = record?.content;

    if (isErrorOutput(content)) {
      return {
        type: 'agent.tool.error',
        toolName,
        error: stringifyEventData(content),
        ts: Date.now(),
      };
    }

    return {
      type: 'agent.tool.success',
      toolName,
      output: content,
      costMs: 0,
      ts: Date.now(),
    };
  });
}

function getContextPackEvent(nodeValue: unknown): AgentRuntimeEvent {
  const contextPack = asRecord(asRecord(nodeValue)?.contextPack);
  return {
    type: 'agent.context.build',
    sources: getContextPackSources(contextPack),
    tokenEstimate: estimateTokens(JSON.stringify(contextPack ?? {})),
    ts: Date.now(),
  };
}

function getContextPackSources(
  contextPack: Record<string, unknown> | undefined
): ContextSource[] {
  const recentMessages = Array.isArray(contextPack?.recentMessages)
    ? contextPack.recentMessages
    : [];
  const assets = Array.isArray(contextPack?.assets) ? contextPack.assets : [];

  return [
    ...recentMessages.slice(0, 6).map((value, index) => {
      const message = asRecord(value);
      const role = typeof message?.role === 'string' ? message.role : 'message';
      return {
        sourceId: `recent-message-${index + 1}`,
        sourceType: 'message' as const,
        title: RUNTIME_EVENT_LABELS.contextSources.message(index + 1, role),
        summary: typeof message?.content === 'string' ? message.content : undefined,
      };
    }),
    ...assets.slice(0, 6).map((value, index) => {
      const asset = asRecord(value);
      return {
        sourceId:
          (typeof asset?.assetId === 'string' && asset.assetId) ||
          `asset-${index + 1}`,
        sourceType: 'asset' as const,
        title:
          (typeof asset?.caption === 'string' && asset.caption) ||
          RUNTIME_EVENT_LABELS.contextSources.asset(index + 1),
        summary: typeof asset?.status === 'string' ? asset.status : undefined,
      };
    }),
  ];
}

function getContextEvent(nodeValue: unknown): AgentRuntimeEvent {
  return {
    type: 'agent.context.build',
    sources: getContextSources(nodeValue),
    tokenEstimate: estimateTokens(JSON.stringify(nodeValue ?? {})),
    ts: Date.now(),
  };
}

function getContextSources(nodeValue: unknown): ContextSource[] {
  const record = asRecord(nodeValue);
  const values = Object.values(record ?? {}).flatMap((value) =>
    Array.isArray(value) ? value : []
  );

  if (values.length === 0) {
    return [
      {
        sourceId: 'context-source',
        sourceType: 'tool',
        title: RUNTIME_EVENT_LABELS.contextSources.fallback,
      },
    ];
  }

  return values.slice(0, 6).map((value, index) => {
    const item = asRecord(value);
    return {
      sourceId:
        (typeof item?.url === 'string' && item.url) ||
        (typeof item?.id === 'string' && item.id) ||
        `context-source-${index + 1}`,
      sourceType: 'tool',
      title:
        (typeof item?.title === 'string' && item.title) ||
        (typeof item?.name === 'string' && item.name) ||
        RUNTIME_EVENT_LABELS.contextSources.tool(index + 1),
      summary:
        (typeof item?.summary === 'string' && item.summary) ||
        (typeof item?.snippet === 'string' && item.snippet) ||
        undefined,
    };
  });
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getAnswerEvents(nodeValue: unknown): AgentRuntimeEvent[] {
  const messages = getNodeMessages(nodeValue);
  return messages.map((message) => ({
    type: 'agent.answer.stream',
    delta: stringifyEventData(asRecord(message)?.content ?? message),
    ts: Date.now(),
  }));
}

export function extractAgentRuntimeEvents(
  event: Record<string, unknown>
): AgentRuntimeEvent[] {
  return [
    ...extractDirectAgentRuntimeEvents(event),
    ...extractNestedAgentRuntimeEvents(event),
    ...extractNodeAdapterRuntimeEvents(event),
  ];
}

export function isLangGraphInterruptEvent(event: Record<string, unknown>): boolean {
  if (event.event === 'interrupt' || event.type === 'interrupt') {
    return true;
  }
  if (Array.isArray(event.__interrupt__)) {
    return true;
  }
  const values = Object.values(event);
  return values.some((value) => {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Array.isArray(record.__interrupt__) || record.event === 'interrupt' || record.type === 'interrupt';
  });
}

export function extractClarificationInterruptId(
  event: Record<string, unknown>
): string | undefined {
  for (const payload of getInterruptPayloads(event)) {
    if (
      payload.eventType === 'clarification_requested' &&
      typeof payload.interruptId === 'string' &&
      /^clarification:[a-f0-9]{64}$/.test(payload.interruptId)
    ) {
      return payload.interruptId;
    }
  }
  return undefined;
}

function getInterruptPayloads(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return [];

  const parsed = parseJsonRecord(value);
  if (parsed) return getInterruptPayloads(parsed, depth + 1);

  const record = asRecord(value);
  if (!record) return [];

  const direct = record.type === 'weather_clarification' ? [record] : [];
  const fromInterruptArray = Array.isArray(record.__interrupt__)
    ? record.__interrupt__.flatMap((entry) =>
        getInterruptPayloads(asRecord(entry)?.value ?? entry, depth + 1)
      )
    : [];
  const fromValue = record.value ? getInterruptPayloads(record.value, depth + 1) : [];
  const fromData = record.data ? getInterruptPayloads(record.data, depth + 1) : [];
  const fromNested = Object.values(record).flatMap((entry) => {
    if (entry === record.value || entry === record.data || entry === record.__interrupt__) {
      return [];
    }
    return getInterruptPayloads(entry, depth + 1);
  });

  return [...direct, ...fromInterruptArray, ...fromValue, ...fromData, ...fromNested];
}

function getWeatherClarificationToolName(
  payload: Record<string, unknown>,
  result?: Record<string, unknown>
): 'current_weather' | 'weather_forecast' {
  if (result?.tool === 'weather_forecast') return 'weather_forecast';
  if (result?.tool === 'current_weather') return 'current_weather';
  return payload.weatherCapability === 'hourly' || payload.weatherCapability === 'daily'
    ? 'weather_forecast'
    : 'current_weather';
}

export function extractWeatherClarificationInterruptToolResult(
  event: Record<string, unknown>
): WeatherClarificationInterruptToolResult | undefined {
  const payload = getInterruptPayloads(event)[0];
  if (!payload) return undefined;

  const execution = asRecord(payload.weatherExecution);
  const executionResult = asRecord(execution?.result);
  const toolName = getWeatherClarificationToolName(payload, executionResult);
  const content =
    executionResult?.status === 'needs_clarification'
      ? JSON.stringify({ ...executionResult, tool: toolName })
      : JSON.stringify({
          schemaVersion: toolName === 'weather_forecast' ? '1.1' : '1.0',
          tool: toolName,
          status: 'needs_clarification',
          requestedLocation:
            asRecord(payload.originalQuery) ?? { raw: '', location: '' },
          candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
          message: typeof payload.summary === 'string' ? payload.summary : 'Location clarification is required.',
          summary: typeof payload.summary === 'string' ? payload.summary : 'Location clarification is required.',
        });

  return {
    toolName,
    toolCallId: 'weather-clarification-interrupt',
    content,
  };
}

export function extractDirectAgentRuntimeEvents(
  event: Record<string, unknown>
): AgentRuntimeEvent[] {
  return getRuntimeEvents(event);
}

export function extractNestedAgentRuntimeEvents(
  event: Record<string, unknown>
): AgentRuntimeEvent[] {
  return Object.values(event).flatMap(getRuntimeEvents);
}

export function extractNodeAdapterRuntimeEvents(
  event: Record<string, unknown>
): AgentRuntimeEvent[] {
  return NODE_EVENT_RULES.flatMap((rule) => {
    if (!(rule.nodeKey in event)) return [];
    if (getRuntimeEvents(event[rule.nodeKey]).length > 0) return [];
    return rule.toEvents(event[rule.nodeKey]);
  });
}

export function runtimeEventToProcessedEvent(
  event: AgentRuntimeEvent
): ProcessedRuntimeEvent {
  switch (event.type) {
    case 'agent.plan.start':
      return {
        title: event.title,
        data: RUNTIME_EVENT_LABELS.planCreated,
        eventType: event.type,
      };
    case 'agent.tool.start':
      return {
        title: RUNTIME_EVENT_LABELS.toolStarted(event.toolName),
        data: stringifyEventData(event.input),
        eventType: event.type,
      };
    case 'agent.tool.success':
      return {
        title: RUNTIME_EVENT_LABELS.toolSuccess(event.toolName),
        data: stringifyEventData(event.output),
        eventType: event.type,
      };
    case 'agent.tool.error':
      return {
        title: RUNTIME_EVENT_LABELS.toolError(event.toolName),
        data: event.error,
        eventType: event.type,
      };
    case 'agent.context.build':
      return {
        title: RUNTIME_EVENT_LABELS.contextBuilt,
        data: {
          tokenEstimate: event.tokenEstimate,
          sources: event.sources.map((source) => source.title),
        },
        eventType: event.type,
      };
    case 'agent.answer.stream':
      return {
        title: RUNTIME_EVENT_LABELS.finalAnswer,
        data: event.delta,
        eventType: event.type,
      };
    case 'agent.card.emit':
      return {
        title: RUNTIME_EVENT_LABELS.card(event.cardType),
        data: stringifyEventData(event.payload),
        eventType: event.type,
      };
    case 'agent.unknown':
      return {
        title: RUNTIME_EVENT_LABELS.unknown(event.originalType),
        data: {
          originalType: event.originalType,
          ...(event.rawPayload ?? {}),
        },
        eventType: event.type,
      };
  }

  const exhaustiveEvent: never = event;
  return exhaustiveEvent;
}
