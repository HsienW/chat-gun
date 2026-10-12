import { z } from "zod";
import { getPool } from "../persistence/connection.js";
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

export class PgGraphTaskAdmission implements GraphTaskAdmission {
  constructor(private readonly database: () => AdmissionDatabase | null = getPool) {}

  async admit(context: ExecutionContext, resumeTaskId?: string): Promise<string> {
    const database = this.database();
    if (!database) throw new Error("Graph task admission database unavailable");
    const binding = bindingSchema.parse({
      initialRunId: context.runId,
      threadId: context.threadId,
      principalId: context.principal.principalId,
      tenantId: context.principal.tenantId,
      scopeId: context.scope.scopeId,
      scopeType: context.scope.scopeType,
    });
    const connection = await database.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`graph-entry:${context.runId}`]);
      const existing = resumeTaskId
        ? await connection.query("SELECT task_id, metadata FROM agent_tasks WHERE task_id = $1", [resumeTaskId])
        : await connection.query("SELECT task_id, metadata FROM agent_tasks WHERE metadata #>> '{graphEntry,initialRunId}' = $1", [context.runId]);
      let taskId = context.taskId;
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw new Error("Ambiguous graph task admission");
        const persisted = taskRowSchema.parse(existing.rows[0]);
        const owner = persisted.metadata.graphEntry;
        if (
          owner.threadId !== binding.threadId || owner.principalId !== binding.principalId ||
          owner.tenantId !== binding.tenantId || owner.scopeId !== binding.scopeId ||
          owner.scopeType !== binding.scopeType ||
          (resumeTaskId !== undefined && persisted.task_id !== resumeTaskId)
        ) throw new Error("Graph task admission binding mismatch");
        taskId = persisted.task_id;
      } else {
        if (resumeTaskId !== undefined) throw new Error("Graph resume task unavailable");
        await connection.query(
          "INSERT INTO agent_tasks (task_id, task_type, status, metadata) VALUES ($1, 'graph_execution', 'created', jsonb_build_object('graphEntry', $2::jsonb))",
          [taskId, binding],
        );
      }
      await connection.query("COMMIT");
      return taskId;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
