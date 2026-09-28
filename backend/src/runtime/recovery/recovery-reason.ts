import { z } from "zod";

import type { Queryable } from "../persistence/rows.js";
import { LAST_EXECUTION_POINTS } from "./last-execution-point.js";

export const CANCELLATION_REASONS = [
  "user_cancel",
  "timeout",
  "supersede",
  "crash",
] as const;

export const RECOVERY_REASON_CATEGORIES = [
  "user_cancelled",
  "timed_out",
  "superseded",
  "crashed",
  "transport_disconnected",
] as const;

export const recoveryReasonSchema = z
  .object({
    cancellationReason: z.enum(CANCELLATION_REASONS).optional(),
    transportDisconnect: z.boolean().optional(),
    crash: z
      .object({
        fatal: z.boolean(),
        phase: z.enum(LAST_EXECUTION_POINTS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((reason, context) => {
    if (
      reason.cancellationReason === undefined &&
      reason.transportDisconnect !== true &&
      reason.crash === undefined
    ) {
      context.addIssue({ code: "custom", message: "Recovery reason is required" });
    }
    if (
      (reason.cancellationReason === "crash") !==
      (reason.crash !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Crash details and crash cancellation reason must agree",
      });
    }
  });

export type RecoveryReason = z.infer<typeof recoveryReasonSchema>;
export type RecoveryReasonCategory =
  (typeof RECOVERY_REASON_CATEGORIES)[number];

export interface RecoveryReasonClassification {
  category: RecoveryReasonCategory;
  shouldResume: boolean;
  transportDisconnected: boolean;
}

export function parseRecoveryReason(value: unknown): RecoveryReason {
  return recoveryReasonSchema.parse(value);
}

export function classifyRecoveryReason(
  reasonValue: unknown
): RecoveryReasonClassification {
  const reason = parseRecoveryReason(reasonValue);
  const transportDisconnected = reason.transportDisconnect === true;
  switch (reason.cancellationReason) {
    case "user_cancel":
      return { category: "user_cancelled", shouldResume: false, transportDisconnected };
    case "timeout":
      return { category: "timed_out", shouldResume: false, transportDisconnected };
    case "supersede":
      return { category: "superseded", shouldResume: false, transportDisconnected };
    case "crash":
      return {
        category: "crashed",
        shouldResume: reason.crash?.fatal === false,
        transportDisconnected,
      };
    case undefined:
      return {
        category: "transport_disconnected",
        shouldResume: true,
        transportDisconnected,
      };
  }
}

export const recoveryRecordSchema = z
  .object({
    recordId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(256),
    reason: recoveryReasonSchema,
    classification: z.enum(RECOVERY_REASON_CATEGORIES),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (classifyRecoveryReason(record.reason).category !== record.classification) {
      context.addIssue({
        code: "custom",
        message: "Recovery record classification does not match its reason",
      });
    }
  });

export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;

interface RecoveryRecordRow extends Record<string, unknown> {
  recovery_record: unknown;
}

export interface RecoveryRecordRepository {
  create(record: RecoveryRecord): Promise<RecoveryRecord>;
  findLatestByTaskId(taskId: string): Promise<RecoveryRecord | null>;
}

function mapRecoveryRecordRow(
  row: RecoveryRecordRow | undefined
): RecoveryRecord | null {
  return row ? recoveryRecordSchema.parse(row.recovery_record) : null;
}

export class PgRecoveryRecordRepository implements RecoveryRecordRepository {
  constructor(private readonly db: Queryable) {}

  async create(recordValue: RecoveryRecord): Promise<RecoveryRecord> {
    const record = recoveryRecordSchema.parse(recordValue);
    const result = await this.db.query<RecoveryRecordRow>(
      `INSERT INTO recovery_records (
         record_id, run_id, task_id, classification, reason,
         cancellation_reason, transport_disconnect, crash_fatal, crash_phase,
         recovery_record, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING recovery_record`,
      [
        record.recordId,
        record.runId,
        record.taskId,
        record.classification,
        record.reason,
        record.reason.cancellationReason ?? null,
        record.reason.transportDisconnect ?? false,
        record.reason.crash?.fatal ?? null,
        record.reason.crash?.phase ?? null,
        record,
        record.recordedAt,
      ]
    );
    const persisted = mapRecoveryRecordRow(result.rows[0]);
    if (!persisted) throw new Error("Recovery record was not persisted");
    return persisted;
  }

  async findLatestByTaskId(taskId: string): Promise<RecoveryRecord | null> {
    const result = await this.db.query<RecoveryRecordRow>(
      `SELECT recovery_record
       FROM recovery_records
       WHERE task_id = $1
       ORDER BY recorded_at DESC, record_id DESC
       LIMIT 1`,
      [taskId]
    );
    return mapRecoveryRecordRow(result.rows[0]);
  }
}
