import { z } from "zod";
import { getPool } from "../persistence/connection.js";
import { FrameworkAdapterError } from "../framework-adapters/bounded-operation.js";
import { executionIdSchema, type ExecutionContext } from "./execution-context.js";
import type { GraphTaskAdmission } from "./graph-entry.js";

interface AdmissionConnection {
  query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

interface AdmissionDatabase {
  connect(): Promise<AdmissionConnection>;
}

const bindingSchema = z.object({
  correlationVersion: z.literal("1.0.0"),
  initialRunId: executionIdSchema,
  threadId: executionIdSchema,
  principalId: executionIdSchema,
  tenantId: executionIdSchema,
  scopeId: executionIdSchema,
  scopeType: z.string(),
}).strict();

const taskRowSchema = z.object({
  task_id: executionIdSchema,
  metadata: z.object({ graphEntry: bindingSchema }),
});

function assertAdmissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FrameworkAdapterError("ADAPTER_OPERATION_CANCELLED");
}

export class PgGraphTaskAdmission implements GraphTaskAdmission {
  constructor(private readonly database: () => AdmissionDatabase | null = getPool) {}

  async admit(context: ExecutionContext, resumeTaskId?: string, signal?: AbortSignal): Promise<{ taskId: string; runId: string }> {
    assertAdmissionActive(signal);
    const database = this.database();
    if (!database) throw new Error("Graph task admission database unavailable");
    const binding = bindingSchema.parse({
      correlationVersion: "1.0.0",
      initialRunId: context.runId,
      threadId: context.threadId,
      principalId: context.principal.principalId,
      tenantId: context.principal.tenantId,
      scopeId: context.scope.scopeId,
      scopeType: context.scope.scopeType,
    });
    const connection = await database.connect();
    try {
      assertAdmissionActive(signal);
      await connection.query("BEGIN");
      assertAdmissionActive(signal);
      await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`graph-entry:${resumeTaskId ?? context.runId}`]);
      assertAdmissionActive(signal);
      const existing = resumeTaskId
        ? await connection.query("SELECT task_id, metadata FROM agent_tasks WHERE task_id = $1", [resumeTaskId])
        : await connection.query("SELECT task_id, metadata FROM agent_tasks WHERE metadata #>> '{graphEntry,initialRunId}' = $1", [context.runId]);
      assertAdmissionActive(signal);
      let taskId = context.taskId;
      let runId = context.runId;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
        const parsed = taskRowSchema.safeParse(existing.rows[0]);
        if (!parsed.success) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
        const persisted = parsed.data;
        const owner = persisted.metadata.graphEntry;
        if (
          owner.threadId !== binding.threadId || owner.principalId !== binding.principalId ||
          owner.tenantId !== binding.tenantId || owner.scopeId !== binding.scopeId ||
          owner.scopeType !== binding.scopeType ||
          (resumeTaskId === undefined && owner.initialRunId !== binding.initialRunId) ||
          (resumeTaskId !== undefined && persisted.task_id !== resumeTaskId)
        ) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
        taskId = persisted.task_id;
        runId = owner.initialRunId;
      } else {
        if (resumeTaskId !== undefined) throw new FrameworkAdapterError("CHECKPOINT_PARKED");
        assertAdmissionActive(signal);
        await connection.query(
          "INSERT INTO agent_tasks (task_id, task_type, status, metadata) VALUES ($1, 'graph_execution', 'created', jsonb_build_object('graphEntry', $2::jsonb))",
          [taskId, binding],
        );
      }
      assertAdmissionActive(signal);
      await connection.query("COMMIT");
      return { taskId, runId };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
