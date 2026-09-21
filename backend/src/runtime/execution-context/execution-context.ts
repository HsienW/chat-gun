import { z } from "zod";

import { AUTH_SOURCES, PRINCIPAL_TYPES } from "../authorization/principal.js";
import type { PrincipalContext } from "../authorization/principal.js";
import { SCOPE_TYPES } from "../authorization/scope.js";
import type { RuntimeScope } from "../authorization/scope.js";

export interface ExecutionContext {
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
  principal: PrincipalContext;
  scope: RuntimeScope;
}

export const executionIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_\-:.]+$/);

const principalContextSchema = z.object({
  principalId: z.string().min(1),
  principalType: z.enum(PRINCIPAL_TYPES),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)),
  scopes: z.array(z.string().min(1)),
  authSource: z.enum(AUTH_SOURCES),
  authenticatedAt: z.string().datetime(),
}).strict();

const runtimeScopeSchema = z.object({
  scopeId: z.string().min(1),
  scopeType: z.enum(SCOPE_TYPES),
  tenantId: z.string().min(1),
  ownerPrincipalId: z.string().min(1).optional(),
}).strict();

export const executionContextSchema: z.ZodType<ExecutionContext> = z.object({
  requestId: executionIdSchema,
  threadId: executionIdSchema,
  runId: executionIdSchema,
  taskId: executionIdSchema,
  stepId: executionIdSchema.optional(),
  toolCallId: executionIdSchema.optional(),
  toolExecutionId: executionIdSchema.optional(),
  parentRunId: executionIdSchema.optional(),
  agentId: executionIdSchema.optional(),
  attempt: z.number().int().positive(),
  principal: principalContextSchema,
  scope: runtimeScopeSchema,
}).strict().refine(
  (context) => context.principal.tenantId === context.scope.tenantId,
  { message: "Principal and scope tenant identities must match", path: ["scope", "tenantId"] }
);
