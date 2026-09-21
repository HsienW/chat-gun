import { randomUUID } from "node:crypto";

export type AuditActorType = "system" | "user" | "agent";

export type AuditDecision = "allow" | "deny" | "pending_confirmation" | "neutral";

export interface AuditEvent {
  eventId: string;
  requestId?: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolExecutionId?: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: AuditDecision;
  reasonCode?: string;
  payload?: unknown;
  beforeStateRef?: string;
  afterStateRef?: string;
  createdAt: string;
}

export type AuditEventInput = Omit<AuditEvent, "eventId" | "createdAt">;

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  return {
    eventId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
  };
}
