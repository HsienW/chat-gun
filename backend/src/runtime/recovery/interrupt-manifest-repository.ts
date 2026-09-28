import type { Queryable } from "../persistence/rows.js";
import {
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
  type InterruptManifestStatus,
} from "./interrupt-manifest.js";

interface InterruptManifestRow extends Record<string, unknown> {
  manifest: unknown;
}

export interface ConsumeInterruptManifestInput {
  interruptId: string;
  runId: string;
  taskId: string;
  scopeId: string;
  now?: Date;
}

export interface TransitionInterruptManifestInput {
  interruptId: string;
  expectedStatus: InterruptManifestStatus;
  nextStatus: InterruptManifestStatus;
  now?: Date;
}

export interface InterruptManifestRepository {
  create(
    manifest: DurableInterruptManifest
  ): Promise<DurableInterruptManifest>;
  findByInterruptId(
    interruptId: string
  ): Promise<DurableInterruptManifest | null>;
  consume(
    input: ConsumeInterruptManifestInput
  ): Promise<DurableInterruptManifest | null>;
  transitionStatus(
    input: TransitionInterruptManifestInput
  ): Promise<DurableInterruptManifest | null>;
}

function mapManifestRow(
  row: InterruptManifestRow | undefined
): DurableInterruptManifest | null {
  return row ? parseDurableInterruptManifest(row.manifest) : null;
}

export class PgInterruptManifestRepository
  implements InterruptManifestRepository
{
  constructor(private readonly db: Queryable) {}

  async create(
    manifestValue: DurableInterruptManifest
  ): Promise<DurableInterruptManifest> {
    const manifest = parseDurableInterruptManifest(manifestValue);
    const decisionRef =
      manifest.kind === "confirmation" ? manifest.decisionRef : undefined;
    const result = await this.db.query<InterruptManifestRow>(
      `INSERT INTO interrupt_manifests (
         interrupt_id, kind, run_id, thread_id, task_id, step_id, scope_id,
         expected_response_schema_ref, expiry_at, execution_manifest, status,
         decision_id, approval_id, manifest, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )
       ON CONFLICT (interrupt_id) DO UPDATE SET
         manifest = interrupt_manifests.manifest
       WHERE interrupt_manifests.kind = EXCLUDED.kind
         AND interrupt_manifests.run_id = EXCLUDED.run_id
         AND interrupt_manifests.thread_id = EXCLUDED.thread_id
         AND interrupt_manifests.task_id = EXCLUDED.task_id
         AND interrupt_manifests.step_id IS NOT DISTINCT FROM EXCLUDED.step_id
         AND interrupt_manifests.scope_id = EXCLUDED.scope_id
         AND interrupt_manifests.expected_response_schema_ref = EXCLUDED.expected_response_schema_ref
         AND interrupt_manifests.expiry_at = EXCLUDED.expiry_at
         AND interrupt_manifests.execution_manifest = EXCLUDED.execution_manifest
         AND interrupt_manifests.status = EXCLUDED.status
         AND interrupt_manifests.decision_id IS NOT DISTINCT FROM EXCLUDED.decision_id
         AND interrupt_manifests.approval_id IS NOT DISTINCT FROM EXCLUDED.approval_id
       RETURNING manifest`,
      [
        manifest.interruptId,
        manifest.kind,
        manifest.runId,
        manifest.threadId,
        manifest.taskId,
        manifest.stepId ?? null,
        manifest.scopeId,
        manifest.expectedResponseSchemaRef,
        manifest.expiryAt,
        manifest.executionManifest,
        manifest.status,
        decisionRef?.decisionId ?? null,
        decisionRef?.approvalId ?? null,
        manifest,
        manifest.createdAt,
        manifest.updatedAt,
      ]
    );
    const persisted = mapManifestRow(result.rows[0]);
    if (!persisted) {
      throw new Error("Interrupt manifest binding conflict");
    }
    return persisted;
  }

  async findByInterruptId(
    interruptId: string
  ): Promise<DurableInterruptManifest | null> {
    const result = await this.db.query<InterruptManifestRow>(
      `SELECT manifest
       FROM interrupt_manifests
       WHERE interrupt_id = $1`,
      [interruptId]
    );
    return mapManifestRow(result.rows[0]);
  }

  async consume(
    input: ConsumeInterruptManifestInput
  ): Promise<DurableInterruptManifest | null> {
    const consumedAt = (input.now ?? new Date()).toISOString();
    const result = await this.db.query<InterruptManifestRow>(
      `UPDATE interrupt_manifests
       SET status = 'resumed',
           manifest = jsonb_set(
             jsonb_set(manifest, '{status}', to_jsonb('resumed'::text)),
             '{updatedAt}', to_jsonb($5::text)
           ),
           updated_at = $5
       WHERE interrupt_id = $1
         AND run_id = $2
         AND task_id = $3
         AND scope_id = $4
         AND status = 'waiting'
         AND expiry_at > $5
       RETURNING manifest`,
      [input.interruptId, input.runId, input.taskId, input.scopeId, consumedAt]
    );
    return mapManifestRow(result.rows[0]);
  }

  async transitionStatus(
    input: TransitionInterruptManifestInput
  ): Promise<DurableInterruptManifest | null> {
    const updatedAt = (input.now ?? new Date()).toISOString();
    const result = await this.db.query<InterruptManifestRow>(
      `UPDATE interrupt_manifests
       SET status = $3,
           manifest = jsonb_set(
             jsonb_set(manifest, '{status}', to_jsonb($3::text)),
             '{updatedAt}', to_jsonb($4::text)
           ),
           updated_at = $4
       WHERE interrupt_id = $1 AND status = $2
       RETURNING manifest`,
      [
        input.interruptId,
        input.expectedStatus,
        input.nextStatus,
        updatedAt,
      ]
    );
    return mapManifestRow(result.rows[0]);
  }
}

export class UnavailableInterruptManifestRepository
  implements InterruptManifestRepository
{
  private unavailable(): never {
    throw new Error("Interrupt manifest persistence is unavailable");
  }

  async create(): Promise<DurableInterruptManifest> {
    return this.unavailable();
  }

  async findByInterruptId(): Promise<DurableInterruptManifest | null> {
    return this.unavailable();
  }

  async consume(): Promise<DurableInterruptManifest | null> {
    return this.unavailable();
  }

  async transitionStatus(): Promise<DurableInterruptManifest | null> {
    return this.unavailable();
  }
}
