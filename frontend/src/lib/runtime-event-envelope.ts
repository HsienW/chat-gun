export const RUNTIME_EVENT_SCHEMA_VERSION = '1.0.0' as const;
export const DEFAULT_REORDER_WINDOW_SIZE = 128;
const DEFAULT_MAX_SEEN_EVENT_IDS = 2_048;
const DEFAULT_MAX_RUNS = 64;

export const RUNTIME_EVENT_TYPES = [
  'run.started',
  'run.status',
  'run.terminal',
  'task.created',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'step.started',
  'step.completed',
  'step.failed',
  'step.retrying',
  'model.stream',
  'model.done',
  'model.error',
  'tool.start',
  'tool.success',
  'tool.error',
  'permission.request',
  'permission.decided',
  'reconciliation.status',
  'compensation.triggered',
  'compensation.completed',
  'context.build',
  'card.emit',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface ExecutionEventContext {
  requestId: string;
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  toolCallId?: string;
  toolExecutionId?: string;
  parentRunId?: string;
  agentId?: string;
  attempt: number;
  principalId: string;
  tenantId: string;
  scopeId: string;
  scopeType: string;
}

export interface RuntimeEventEnvelope<
  TType extends RuntimeEventType = RuntimeEventType,
  TPayload = unknown,
> {
  schemaVersion: string;
  eventId: string;
  sequence: number;
  type: TType;
  emittedAt: string;
  context: ExecutionEventContext;
  payload: TPayload;
}

export type RuntimeEventParseResult =
  | { kind: 'versioned'; envelope: RuntimeEventEnvelope }
  | {
      kind: 'unknown';
      reason:
        | 'invalid_envelope'
        | 'unsupported_schema_version'
        | 'unknown_type';
      originalType?: string;
    };

export type RuntimeEventBufferObservation =
  | { code: 'events.duplicate.ignored'; runId: string }
  | { code: 'events.sequence.stale'; runId: string }
  | { code: 'events.sequence.duplicate'; runId: string }
  | {
      code: 'events.reorder.forwarded';
      runId: string;
      expectedSequence: number;
      forwardedSequence: number;
    };

export interface RuntimeEventBufferResult {
  events: RuntimeEventEnvelope[];
  observations: RuntimeEventBufferObservation[];
}

interface RunBufferState {
  nextSequence: number;
  buffered: Map<number, RuntimeEventEnvelope>;
}

export interface BoundedRuntimeEventBufferOptions {
  windowSize?: number;
  maxSeenEventIds?: number;
  maxRuns?: number;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const opaqueIdPattern = /^[A-Za-z0-9_\-:.]{1,256}$/;

export function parseRuntimeEventEnvelope(value: unknown): RuntimeEventParseResult {
  const record = asRecord(value);
  if (!record) return { kind: 'unknown', reason: 'invalid_envelope' };

  const schemaVersion = readString(record.schemaVersion);
  const version = schemaVersion ? parseSemver(schemaVersion) : undefined;
  if (!schemaVersion || !version) {
    return { kind: 'unknown', reason: 'invalid_envelope' };
  }
  if (version.major !== 1) {
    return { kind: 'unknown', reason: 'unsupported_schema_version' };
  }

  const eventId = readOpaqueId(record.eventId);
  const sequence = readPositiveInteger(record.sequence);
  const type = readString(record.type);
  const emittedAt = readIsoDate(record.emittedAt);
  const context = parseExecutionEventContext(record.context);
  if (
    !eventId ||
    sequence === undefined ||
    !type ||
    !emittedAt ||
    !context ||
    !Object.prototype.hasOwnProperty.call(record, 'payload')
  ) {
    return { kind: 'unknown', reason: 'invalid_envelope' };
  }
  if (!isRuntimeEventType(type)) {
    return { kind: 'unknown', reason: 'unknown_type', originalType: type };
  }

  return {
    kind: 'versioned',
    envelope: {
      schemaVersion,
      eventId,
      sequence,
      type,
      emittedAt,
      context,
      payload: record.payload,
    },
  };
}

export function isRuntimeEventEnvelope(
  value: unknown
): value is RuntimeEventEnvelope {
  return parseRuntimeEventEnvelope(value).kind === 'versioned';
}

export class BoundedRuntimeEventBuffer {
  private readonly seenEventIds = new Map<string, true>();
  private readonly runs = new Map<string, RunBufferState>();
  private readonly windowSize: number;
  private readonly maxSeenEventIds: number;
  private readonly maxRuns: number;

  constructor(options: BoundedRuntimeEventBufferOptions = {}) {
    this.windowSize = requirePositiveInteger(
      options.windowSize ?? DEFAULT_REORDER_WINDOW_SIZE,
      'windowSize'
    );
    this.maxSeenEventIds = requirePositiveInteger(
      options.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS,
      'maxSeenEventIds'
    );
    this.maxRuns = requirePositiveInteger(
      options.maxRuns ?? DEFAULT_MAX_RUNS,
      'maxRuns'
    );
  }

  get seenEventIdCount(): number {
    return this.seenEventIds.size;
  }

  get runCount(): number {
    return this.runs.size;
  }

  get bufferedEventCount(): number {
    let count = 0;
    for (const run of this.runs.values()) count += run.buffered.size;
    return count;
  }

  push(envelope: RuntimeEventEnvelope): RuntimeEventBufferResult {
    const runId = envelope.context.runId;
    if (this.seenEventIds.has(envelope.eventId)) {
      return {
        events: [],
        observations: [{ code: 'events.duplicate.ignored', runId }],
      };
    }
    this.rememberEventId(envelope.eventId);

    const run = this.getOrCreateRun(runId);
    if (envelope.sequence < run.nextSequence) {
      return {
        events: [],
        observations: [{ code: 'events.sequence.stale', runId }],
      };
    }
    if (run.buffered.has(envelope.sequence)) {
      return {
        events: [],
        observations: [{ code: 'events.sequence.duplicate', runId }],
      };
    }
    run.buffered.set(envelope.sequence, envelope);

    const observations: RuntimeEventBufferObservation[] = [];
    const largestSequence = Math.max(...run.buffered.keys());
    if (
      largestSequence - run.nextSequence >= this.windowSize ||
      run.buffered.size > this.windowSize
    ) {
      const forwardedSequence = Math.min(...run.buffered.keys());
      observations.push({
        code: 'events.reorder.forwarded',
        runId,
        expectedSequence: run.nextSequence,
        forwardedSequence,
      });
      run.nextSequence = forwardedSequence;
    }

    const events: RuntimeEventEnvelope[] = [];
    while (run.buffered.has(run.nextSequence)) {
      const next = run.buffered.get(run.nextSequence);
      if (!next) break;
      run.buffered.delete(run.nextSequence);
      events.push(next);
      run.nextSequence += 1;
    }
    return { events, observations };
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.delete(eventId);
    this.seenEventIds.set(eventId, true);
    while (this.seenEventIds.size > this.maxSeenEventIds) {
      const oldest = this.seenEventIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.seenEventIds.delete(oldest);
    }
  }

  private getOrCreateRun(runId: string): RunBufferState {
    const existing = this.runs.get(runId);
    if (existing) {
      this.runs.delete(runId);
      this.runs.set(runId, existing);
      return existing;
    }
    while (this.runs.size >= this.maxRuns) {
      const oldest = this.runs.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.runs.delete(oldest);
    }
    const created: RunBufferState = {
      nextSequence: 1,
      buffered: new Map(),
    };
    this.runs.set(runId, created);
    return created;
  }
}

function parseExecutionEventContext(value: unknown): ExecutionEventContext | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const requestId = readOpaqueId(record.requestId);
  const threadId = readOpaqueId(record.threadId);
  const runId = readOpaqueId(record.runId);
  const taskId = readOpaqueId(record.taskId);
  const attempt = readPositiveInteger(record.attempt);
  const principalId = readOpaqueId(record.principalId);
  const tenantId = readOpaqueId(record.tenantId);
  const scopeId = readOpaqueId(record.scopeId);
  const scopeType = readString(record.scopeType);
  if (
    !requestId ||
    !threadId ||
    !runId ||
    !taskId ||
    attempt === undefined ||
    !principalId ||
    !tenantId ||
    !scopeId ||
    !scopeType
  ) {
    return undefined;
  }
  return {
    requestId,
    threadId,
    runId,
    taskId,
    ...optionalOpaqueId(record, 'stepId'),
    ...optionalOpaqueId(record, 'toolCallId'),
    ...optionalOpaqueId(record, 'toolExecutionId'),
    ...optionalOpaqueId(record, 'parentRunId'),
    ...optionalOpaqueId(record, 'agentId'),
    attempt,
    principalId,
    tenantId,
    scopeId,
    scopeType,
  };
}

function optionalOpaqueId(
  record: Record<string, unknown>,
  key: 'stepId' | 'toolCallId' | 'toolExecutionId' | 'parentRunId' | 'agentId'
): Partial<ExecutionEventContext> {
  const value = readOpaqueId(record[key]);
  return value ? { [key]: value } : {};
}

function isRuntimeEventType(value: string): value is RuntimeEventType {
  return RUNTIME_EVENT_TYPES.some((type) => type === value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOpaqueId(value: unknown): string | undefined {
  const text = readString(value);
  return text && opaqueIdPattern.test(text) ? text : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function readIsoDate(value: unknown): string | undefined {
  const text = readString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

function parseSemver(
  value: string
): { major: number; minor: number; patch: number } | undefined {
  const match = semverPattern.exec(value);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
