import { parseTrustedPrincipal } from "../authorization/principal.js";
import type { PrincipalContext } from "../authorization/principal.js";
import { SCOPE_TYPES } from "../authorization/scope.js";
import type { RuntimeScope } from "../authorization/scope.js";
import { executionContextSchema, executionIdSchema, type ExecutionContext } from "./execution-context.js";

export type ExecutionEnvironment = "development" | "production" | "unknown";

const CORRELATION_KEYS = {
  requestId: ["requestId", "request_id", "x-request-id"],
  threadId: ["threadId", "thread_id"],
  runId: ["runId", "run_id"],
  taskId: ["taskId", "task_id"],
  stepId: ["stepId", "step_id"],
  toolCallId: ["toolCallId", "tool_call_id"],
  toolExecutionId: ["toolExecutionId", "tool_execution_id"],
  parentRunId: ["parentRunId", "parent_run_id"],
  agentId: ["agentId", "agent_id"],
} as const;

export type ExecutionCorrelation = Partial<Pick<ExecutionContext,
  "requestId" | "threadId" | "runId" | "taskId" | "stepId" |
  "toolCallId" | "toolExecutionId" | "parentRunId" | "agentId"
>>;

export function executionCorrelation(context: ExecutionContext): Pick<ExecutionContext,
  "requestId" | "threadId" | "runId" | "taskId"
> {
  const validated = executionContextSchema.parse(context);
  return {
    requestId: validated.requestId,
    threadId: validated.threadId,
    runId: validated.runId,
    taskId: validated.taskId,
  };
}

export function readCanonicalExecutionContext(config: unknown): ExecutionContext | undefined {
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  return configurable.execution_context === undefined
    ? undefined
    : executionContextSchema.parse(configurable.execution_context);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAliasedString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[]
): string | undefined {
  let selected: string | undefined;
  for (const record of records) {
    for (const key of keys) {
      const raw = record[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string") throw new TypeError(`Invalid execution context field: ${key}`);
      const candidate = raw.trim();
      if (candidate.length === 0) throw new TypeError(`Empty execution context field: ${key}`);
      if (selected !== undefined && selected !== candidate) {
        throw new TypeError(`Conflicting execution context field: ${key}`);
      }
      selected = candidate;
    }
  }
  return selected === undefined ? undefined : executionIdSchema.parse(selected);
}

/** Bounded compatibility entry point for callers not yet carrying trusted identity. */
export function readExecutionCorrelation(config: unknown): ExecutionCorrelation {
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const canonical = readCanonicalExecutionContext(config);
  if (canonical !== undefined) {
    const context = canonical;
    return {
      requestId: context.requestId,
      threadId: context.threadId,
      runId: context.runId,
      taskId: context.taskId,
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolExecutionId ? { toolExecutionId: context.toolExecutionId } : {}),
      ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    };
  }
  const records = [runnableConfig, configurable];
  const requestId = readAliasedString(records, CORRELATION_KEYS.requestId);
  const threadId = readAliasedString(records, CORRELATION_KEYS.threadId);
  const runId = readAliasedString(records, CORRELATION_KEYS.runId);
  const taskId = readAliasedString(records, CORRELATION_KEYS.taskId);
  const stepId = readAliasedString(records, CORRELATION_KEYS.stepId);
  const toolCallId = readAliasedString(records, CORRELATION_KEYS.toolCallId);
  const toolExecutionId = readAliasedString(records, CORRELATION_KEYS.toolExecutionId);
  const parentRunId = readAliasedString(records, CORRELATION_KEYS.parentRunId);
  const agentId = readAliasedString(records, CORRELATION_KEYS.agentId);
  return {
    ...(requestId ? { requestId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolExecutionId ? { toolExecutionId } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function readAttempt(records: readonly Record<string, unknown>[]): number {
  const raw = readAliasedString(
    records.map((record) => {
      const attempt = record.attempt ?? record.retry_attempt;
      return attempt === undefined ? {} : { attempt: String(attempt) };
    }),
    ["attempt"]
  );
  if (raw === undefined) return 1;
  const attempt = Number(raw);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("Invalid execution attempt");
  return attempt;
}

function readTrustedIdentity(
  configurable: Record<string, unknown>,
  environment: ExecutionEnvironment
): { principal?: PrincipalContext; scope?: RuntimeScope } {
  const trustedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(configurable)) {
    if (key.startsWith("x-bff-") && typeof value === "string") {
      trustedHeaders[key] = value;
    }
  }
  const principalResult = parseTrustedPrincipal(trustedHeaders);
  if (principalResult.ok) {
    const scopeId = configurable["x-bff-scope-id"];
    const scopeType = configurable["x-bff-scope-type"];
    const parsedScopeType = SCOPE_TYPES.find((candidate) => candidate === scopeType);
    if (
      typeof scopeId !== "string" ||
      scopeId.trim().length === 0 ||
      scopeId.includes(",") ||
      scopeId.trim().startsWith("[") ||
      scopeId.trim().startsWith("{") ||
      parsedScopeType === undefined
    ) {
      return { principal: principalResult.principal };
    }
    return {
      principal: principalResult.principal,
      scope: {
        scopeId,
        scopeType: parsedScopeType,
        tenantId: principalResult.principal.tenantId,
        ...(scopeType === "principal"
          ? { ownerPrincipalId: principalResult.principal.principalId }
          : {}),
      },
    };
  }

  if (Object.keys(trustedHeaders).length > 0) return {};
  if (environment !== "development") return {};
  const principal: PrincipalContext = {
    principalId: "anonymous",
    principalType: "user",
    tenantId: "public",
    roles: [],
    scopes: [],
    authSource: "development",
    authenticatedAt: new Date().toISOString(),
  };
  return {
    principal,
    scope: {
      scopeId: "development-public-anonymous",
      scopeType: "principal",
      tenantId: "public",
      ownerPrincipalId: principal.principalId,
    },
  };
}

export function readExecutionContext(
  _input: unknown,
  config: unknown,
  environment: ExecutionEnvironment = process.env.NODE_ENV === "development"
    ? "development"
    : process.env.NODE_ENV === "production"
      ? "production"
      : "unknown"
): ExecutionContext {
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  if (configurable.execution_context !== undefined) {
    return executionContextSchema.parse(configurable.execution_context);
  }

  const records = [runnableConfig, configurable];
  const correlation = readExecutionCorrelation(config);
  const identity = readTrustedIdentity(configurable, environment);
  return executionContextSchema.parse({
    ...correlation,
    attempt: readAttempt(records),
    ...identity,
  });
}

/** Development entry point never accepts client-supplied canonical or trusted identity. */
export function readDevelopmentExecutionContext(input: unknown, config: unknown): ExecutionContext {
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const untrustedIdentityRemoved = Object.fromEntries(
    Object.entries(configurable).filter(([key]) =>
      key !== "execution_context" && !key.startsWith("x-bff-")
    )
  );
  return readExecutionContext(input, {
    ...runnableConfig,
    configurable: untrustedIdentityRemoved,
  }, "development");
}

export function withExecutionContext<T extends Record<string, unknown>>(
  config: T,
  context: ExecutionContext
): T {
  const validated = executionContextSchema.parse(context);
  const configurable = isRecord(config.configurable) ? config.configurable : {};
  return {
    ...config,
    configurable: { ...configurable, execution_context: validated },
  };
}
