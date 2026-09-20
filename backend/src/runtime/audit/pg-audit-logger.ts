import { createHash } from "node:crypto";

import type { AuditLogger } from "../../platform/observability.js";
import type { SpanManager } from "../../platform/tracing/span-manager.js";
import {
  DefaultContextRedactor,
  type AuthorizationDecisionObserver,
  type RecordDecisionInput,
} from "../authorization/decision-store.js";
import type { Queryable } from "../persistence/rows.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";
import { executionContextSchema } from "../execution-context/execution-context.js";
import {
  createAuditEvent,
  type AuditActorType,
  type AuditDecision,
  type AuditEvent,
} from "./audit-events.js";
import { redact } from "./redaction.js";

export interface AuditEventFilters {
  taskId?: string;
  runId?: string;
}

interface AuditEventRow extends Record<string, unknown> {
  event_id: string;
  request_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  task_id: string | null;
  step_id: string | null;
  tool_execution_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  decision: string;
  reason_code: string | null;
  payload: unknown;
  before_state_ref: string | null;
  after_state_ref: string | null;
  created_at: string | Date;
}

type ResourceReference = {
  resourceType: string;
  resourceId: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inferResource(
  eventName: string,
  payload: Record<string, unknown>
): ResourceReference {
  const explicitType = optionalString(payload.resourceType);
  const explicitId = optionalString(payload.resourceId);
  if (explicitType && explicitId) {
    return { resourceType: explicitType, resourceId: explicitId };
  }

  const rules: ReadonlyArray<{
    prefix: string;
    resourceType: string;
    payloadField: string;
  }> = [
    { prefix: "tool.", resourceType: "tool", payloadField: "toolName" },
    { prefix: "step.", resourceType: "step", payloadField: "stepId" },
    { prefix: "task.", resourceType: "task", payloadField: "taskId" },
    { prefix: "idempotency.", resourceType: "idempotency", payloadField: "key" },
  ];

  for (const rule of rules) {
    if (eventName.startsWith(rule.prefix)) {
      return {
        resourceType: rule.resourceType,
        resourceId: optionalString(payload[rule.payloadField]) ?? eventName,
      };
    }
  }

  return { resourceType: "unknown", resourceId: eventName };
}

function withoutResourceMetadata(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const { resourceType: _resourceType, resourceId: _resourceId, ...eventPayload } =
    payload;
  return eventPayload;
}

function isActorType(value: string): value is AuditActorType {
  return value === "system" || value === "user" || value === "agent";
}

function isDecision(value: string): value is AuditDecision {
  return (
    value === "allow" ||
    value === "deny" ||
    value === "pending_confirmation" ||
    value === "neutral"
  );
}

function toIsoString(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid created_at returned from audit_events");
  }
  return date.toISOString();
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  if (!isActorType(row.actor_type)) {
    throw new Error(`Unknown audit actor type from database: ${row.actor_type}`);
  }
  if (!isDecision(row.decision)) {
    throw new Error(`Unknown audit decision from database: ${row.decision}`);
  }

  return {
    eventId: row.event_id,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.tool_execution_id ? { toolExecutionId: row.tool_execution_id } : {}),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    decision: row.decision,
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    ...(row.payload !== null ? { payload: row.payload } : {}),
    ...(row.before_state_ref ? { beforeStateRef: row.before_state_ref } : {}),
    ...(row.after_state_ref ? { afterStateRef: row.after_state_ref } : {}),
    createdAt: toIsoString(row.created_at),
  };
}

export class PgAuditLogger implements AuditLogger, AuthorizationDecisionObserver {
  constructor(
    private readonly db: Queryable,
    private readonly redactEnabled = true,
    private readonly spanManager?: Pick<SpanManager, "getActiveSpan" | "setAttributes">,
    private readonly authorizationRedactor = new DefaultContextRedactor()
  ) {}

  private async persistEvent(event: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (
         event_id, request_id, thread_id, run_id,
         task_id, step_id, tool_execution_id,
         actor_type, actor_id, action, resource_type, resource_id,
         decision, reason_code, payload, before_state_ref, after_state_ref,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        event.eventId,
        event.requestId ?? null,
        event.threadId ?? null,
        event.runId ?? null,
        event.taskId ?? null,
        event.stepId ?? null,
        event.toolExecutionId ?? null,
        event.actorType,
        event.actorId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.decision,
        event.reasonCode ?? null,
        event.payload ?? null,
        event.beforeStateRef ?? null,
        event.afterStateRef ?? null,
        event.createdAt,
      ]
    );
  }

  async record(
    eventName: string,
    payload: Record<string, unknown>,
    executionContext?: ExecutionContext
  ): Promise<void> {
    try {
      const correlation = executionContext === undefined
        ? undefined
        : executionContextSchema.parse(executionContext);
      const resource = inferResource(eventName, payload);
      const resourcePayload = withoutResourceMetadata(payload);
      const eventPayload = correlation === undefined
        ? resourcePayload
        : (() => {
            const {
              requestId: _requestId,
              threadId: _threadId,
              runId: _runId,
              ...otherPayload
            } = resourcePayload;
            return otherPayload;
          })();
      const persistedPayload = this.redactEnabled
        ? redact(eventPayload)
        : eventPayload;
      const event = createAuditEvent({
        ...(correlation === undefined ? {} : {
          requestId: correlation.requestId,
          threadId: correlation.threadId,
          runId: correlation.runId,
        }),
        ...((correlation?.taskId ?? optionalString(payload.taskId))
          ? { taskId: correlation?.taskId ?? String(payload.taskId) } : {}),
        ...((correlation?.stepId ?? optionalString(payload.stepId))
          ? { stepId: correlation?.stepId ?? String(payload.stepId) } : {}),
        ...((correlation?.toolExecutionId ?? optionalString(payload.toolExecutionId))
          ? { toolExecutionId: correlation?.toolExecutionId ?? String(payload.toolExecutionId) }
          : {}),
        actorType: "system",
        actorId: "backend",
        action: eventName,
        ...resource,
        decision: "neutral",
        ...(optionalString(payload.reasonCode)
          ? { reasonCode: String(payload.reasonCode) }
          : {}),
        payload: persistedPayload,
      });

      await this.persistEvent(event);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "audit_persistence_failed",
          action: eventName,
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
      );
    }
  }

  async recordAuthorizationDecision(
    input: RecordDecisionInput,
    contextSummary: Readonly<Record<string, unknown>> =
      this.authorizationRedactor.redact(input.request.context ?? {})
  ): Promise<void> {
    const executionContext = input.executionContext === undefined
      ? undefined
      : executionContextSchema.parse(input.executionContext);
    if (executionContext && (
      executionContext.principal.principalId !== input.request.principal.principalId ||
      executionContext.scope.scopeId !== input.request.scope.scopeId
    )) {
      throw new Error("Authorization decision identity conflicts with ExecutionContext");
    }
    const opaquePrincipalId = `principal_sha256:${createHash("sha256")
      .update(input.request.principal.principalId)
      .digest("hex")}`;
    const event = createAuditEvent({
      ...(executionContext ? {
        requestId: executionContext.requestId,
        threadId: executionContext.threadId,
        runId: executionContext.runId,
      } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.toolExecutionId
        ? { toolExecutionId: input.toolExecutionId }
        : {}),
      actorType:
        input.request.principal.principalType === "service" ? "system" : "user",
      actorId: opaquePrincipalId,
      action: "authorization.decision",
      resourceType: input.request.resource.resourceType,
      resourceId: input.request.resource.resourceId,
      decision:
        input.decision.effect === "require_confirmation"
          ? "pending_confirmation"
          : input.decision.effect,
      reasonCode: input.decision.reasonCode,
      payload: {
        decisionId: input.decision.decisionId,
        principalId: opaquePrincipalId,
        scopeId: input.request.scope.scopeId,
        tenantId: input.request.principal.tenantId,
        action: input.request.action,
        ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
        ...(input.decision.matchedPolicy
          ? { matchedPolicy: input.decision.matchedPolicy }
          : {}),
        ...(input.decision.matchedGrantId
          ? { matchedGrantId: input.decision.matchedGrantId }
          : {}),
        contextSummary: { ...contextSummary },
      },
    });

    await this.persistEvent(event);
    const span = this.spanManager?.getActiveSpan();
    if (span) {
      this.spanManager?.setAttributes(span, {
        "authorization.decision_id": input.decision.decisionId,
        "authorization.principal_id": opaquePrincipalId,
        "authorization.scope_id": input.request.scope.scopeId,
        "authorization.effect": input.decision.effect,
        "authorization.reason_code": input.decision.reasonCode,
      });
    }
  }

  async getEvents(filters: AuditEventFilters = {}): Promise<AuditEvent[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (filters.taskId !== undefined) {
      values.push(filters.taskId);
      conditions.push(`task_id = $${values.length}`);
    }
    if (filters.runId !== undefined) {
      values.push(filters.runId);
      conditions.push(`run_id = $${values.length}`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const queryResult = await this.db.query<AuditEventRow>(
      `SELECT
         event_id, request_id, thread_id, run_id,
         task_id, step_id, tool_execution_id,
         actor_type, actor_id, action, resource_type, resource_id,
         decision, reason_code, payload, before_state_ref, after_state_ref,
         created_at
       FROM audit_events
       ${whereClause}
       ORDER BY created_at ASC`,
      values
    );

    return queryResult.rows.map(mapAuditEvent);
  }
}
