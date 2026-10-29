import { randomUUID } from "node:crypto";

import type { Queryable } from "../persistence/rows.js";

/** Identifiers and a reason code only; no tool input, note or result (design §6.6, §10). */
export interface OpenReconciliationTaskInput {
  tenantId: string;
  scopeId: string;
  businessEffectId: string;
  toolExecutionId: string;
  externalOperationId?: string;
  reasonCode: string;
}

export interface OpenReconciliationTaskResult {
  reconciliationTaskId: string;
  /** False when the business effect already had a task. */
  created: boolean;
}

/** At most one task per business effect; opening it again is a no-op. */
export interface ReconciliationTaskStore {
  open(input: OpenReconciliationTaskInput): Promise<OpenReconciliationTaskResult>;
}

interface TaskIdRow extends Record<string, unknown> {
  reconciliation_task_id: unknown;
}

function readTaskId(row: TaskIdRow | undefined): string | undefined {
  return typeof row?.reconciliation_task_id === "string" ? row.reconciliation_task_id : undefined;
}

export class PgReconciliationTaskStore implements ReconciliationTaskStore {
  constructor(
    private readonly db: Queryable,
    private readonly createId: () => string = randomUUID
  ) {}

  async open(input: OpenReconciliationTaskInput): Promise<OpenReconciliationTaskResult> {
    const inserted = await this.db.query<TaskIdRow>(
      `INSERT INTO reconciliation_tasks (
         reconciliation_task_id, tenant_id, scope_id, business_effect_id,
         tool_execution_id, external_operation_id, reason_code, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       ON CONFLICT (business_effect_id) DO NOTHING
       RETURNING reconciliation_task_id`,
      [
        this.createId(),
        input.tenantId,
        input.scopeId,
        input.businessEffectId,
        input.toolExecutionId,
        input.externalOperationId ?? null,
        input.reasonCode,
      ]
    );
    const createdId = readTaskId(inserted.rows[0]);
    if (createdId !== undefined) return { reconciliationTaskId: createdId, created: true };
    const existing = await this.db.query<TaskIdRow>(
      `SELECT reconciliation_task_id
         FROM reconciliation_tasks
        WHERE business_effect_id = $1 AND tenant_id = $2 AND scope_id = $3`,
      [input.businessEffectId, input.tenantId, input.scopeId]
    );
    const existingId = readTaskId(existing.rows[0]);
    if (existingId === undefined) throw new Error("Reconciliation task binding conflict");
    return { reconciliationTaskId: existingId, created: false };
  }
}
