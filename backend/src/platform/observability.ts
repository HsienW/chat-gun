import { PgAuditLogger } from "../runtime/audit/pg-audit-logger.js";
import type { ExecutionContext } from "../runtime/execution-context/execution-context.js";
import { executionCorrelation } from "../runtime/execution-context/read-execution-context.js";
import { getPool } from "../runtime/persistence/connection.js";
import { getEnv } from "./env.js";
import { getMetricsCollector } from "./metrics/metrics-collector.js";

export type AuditPayload = Record<string, unknown>;

export interface AuditLogger {
  record(eventName: string, payload: AuditPayload, context?: ExecutionContext): Promise<void>;
}

export class ConsoleAuditLogger implements AuditLogger {
  async record(eventName: string, payload: AuditPayload, _context?: ExecutionContext): Promise<void> {
    console.info(`[audit] ${eventName}`, JSON.stringify(payload));
  }
}

export class CompositeAuditLogger implements AuditLogger {
  constructor(private readonly loggers: readonly AuditLogger[]) {}

  async record(eventName: string, payload: AuditPayload, context?: ExecutionContext): Promise<void> {
    for (const logger of this.loggers) {
      try {
        await logger.record(eventName, payload, context);
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "audit_backend_failed",
            action: eventName,
            backend: logger.constructor.name,
            errorName: error instanceof Error ? error.name : "UnknownError",
          })
        );
      }
    }
  }
}

function warnPgUnavailable(backend: string): void {
  console.warn(
    JSON.stringify({
      event: "audit_pg_unavailable",
      backend,
      fallback: "console",
      reasonCode: "database_not_configured",
    })
  );
}

export function getAuditLogger(): AuditLogger {
  const backend = getEnv("AUDIT_BACKEND", "console");
  if (backend === "pg" || backend === "composite") {
    const pool = getPool();
    if (!pool) {
      warnPgUnavailable(backend);
      return new ConsoleAuditLogger();
    }

    const pgLogger = new PgAuditLogger(pool);
    return backend === "pg"
      ? pgLogger
      : new CompositeAuditLogger([new ConsoleAuditLogger(), pgLogger]);
  }

  return new ConsoleAuditLogger();
}

export const auditLogger: AuditLogger = getAuditLogger();

const SENSITIVE_METRIC_KEY = /(authorization|cookie|credential|password|secret|token)/i;

function sanitizeMetricPayload(
  payload: AuditPayload
): Record<string, string | number | boolean> {
  const safePayload: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_METRIC_KEY.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safePayload[key] = value;
    }
  }

  return safePayload;
}

export async function recordMetric(
  name: string,
  payload: AuditPayload = {},
  context?: ExecutionContext
): Promise<void> {
  const safePayload = sanitizeMetricPayload({
    ...payload,
    ...(context ? executionCorrelation(context) : {}),
  });
  console.info(`[metric] ${name}`, JSON.stringify(safePayload));

  try {
    const { value, ...attributes } = safePayload;
    getMetricsCollector().record({
      kind: "event",
      name,
      value: typeof value === "number" ? value : 1,
      attributes,
      ts: Date.now(),
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metric_collection_failed",
        metricKind: "event",
        metricName: name,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    );
  }
}

// Weather-specific audit helper — Task 7.1, 7.2
// Records location resolution events without sensitive data — Task 7.3
export async function recordWeatherAuditEvent(
  eventName: string,
  payload: {
    raw?: string;
    provider?: string;
    strategy?: string;
    candidateCount?: number;
    attemptCount?: number;
    durationMs?: number;
    resultStatus?: string;
    errorCode?: string;
    retryable?: boolean;
    repaired?: boolean;
  }
): Promise<void> {
  // Do not record API Key, Proxy Credential, full Prompt, or full Conversation — Task 7.3
  const safePayload: AuditPayload = {};

  if (payload.raw) {
    // Use truncated hash in production; full value for debug environments
    safePayload.raw = payload.raw.length > 80 ? payload.raw.slice(0, 80) + "..." : payload.raw;
  }
  if (payload.provider) safePayload.provider = payload.provider;
  if (payload.strategy) safePayload.strategy = payload.strategy;
  if (payload.candidateCount !== undefined) safePayload.candidateCount = payload.candidateCount;
  if (payload.attemptCount !== undefined) safePayload.attemptCount = payload.attemptCount;
  if (payload.durationMs !== undefined) safePayload.durationMs = payload.durationMs;
  if (payload.resultStatus) safePayload.resultStatus = payload.resultStatus;
  if (payload.errorCode) safePayload.errorCode = payload.errorCode;
  if (payload.retryable !== undefined) safePayload.retryable = payload.retryable;
  if (payload.repaired !== undefined) safePayload.repaired = payload.repaired;

  await auditLogger.record(eventName, safePayload);
}

// Weather metric helper — Task 7.2
export async function recordWeatherMetric(
  name: string,
  value: number,
  labels: Record<string, string | number> = {}
): Promise<void> {
  await recordMetric(`weather.${name}`, {
    value,
    ...labels,
  });
}
