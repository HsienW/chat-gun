import {
  executionContextSchema,
  executionEventContextSchema,
  type ExecutionContext,
  type ExecutionEventContext,
} from "@gun-ai/harness-contracts";

export {
  RUNTIME_EVENT_SCHEMA_VERSION,
  executionEventContextSchema,
  runtimeEventEnvelopeSchema,
} from "@gun-ai/harness-contracts";
export type {
  ExecutionEventContext,
  RuntimeEventEnvelope,
  RuntimeEventSchemaVersion,
} from "@gun-ai/harness-contracts";
export {
  parseRuntimeEventEnvelope,
  parseRuntimeEventSchemaVersion,
} from "@gun-ai/harness-kernel";

export function projectExecutionEventContext(context: ExecutionContext): ExecutionEventContext {
  const validated = executionContextSchema.parse(context);
  return executionEventContextSchema.parse({
    requestId: validated.requestId,
    threadId: validated.threadId,
    runId: validated.runId,
    taskId: validated.taskId,
    ...(validated.stepId ? { stepId: validated.stepId } : {}),
    ...(validated.toolCallId ? { toolCallId: validated.toolCallId } : {}),
    ...(validated.toolExecutionId ? { toolExecutionId: validated.toolExecutionId } : {}),
    ...(validated.parentRunId ? { parentRunId: validated.parentRunId } : {}),
    ...(validated.agentId ? { agentId: validated.agentId } : {}),
    attempt: validated.attempt,
    principalId: validated.principal.principalId,
    tenantId: validated.principal.tenantId,
    scopeId: validated.scope.scopeId,
    scopeType: validated.scope.scopeType,
  });
}
