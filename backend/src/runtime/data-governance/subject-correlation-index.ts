import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { Queryable } from "../persistence/rows.js";
import {
  DATA_INVENTORY_SCHEMA_VERSION,
  subjectCorrelationRecordSchema,
  type SubjectCorrelationRecord,
  type SubjectIdentity,
} from "./contracts.js";

const CORRELATION_DIMENSIONS = [
  "requestId",
  "threadId",
  "runId",
  "taskId",
  "stepId",
  "toolCallId",
  "toolExecutionId",
] as const;

type CorrelationDimension = (typeof CORRELATION_DIMENSIONS)[number];

export interface SubjectCorrelationIndexPort {
  record(record: SubjectCorrelationRecord): Promise<void>;
  resolve(correlationKey: string): Promise<SubjectIdentity | undefined>;
}

export function createCorrelationKey(
  dimension: CorrelationDimension,
  value: string,
): string {
  if (!CORRELATION_DIMENSIONS.some((candidate) => candidate === dimension)) {
    throw new Error("UNKNOWN_CORRELATION_DIMENSION");
  }
  if (value.length === 0 || value.length > 256) {
    throw new Error("INVALID_CORRELATION_VALUE");
  }
  return `${dimension}:${value}`;
}

function identityFromRecord(record: SubjectCorrelationRecord): SubjectIdentity {
  return {
    accountId: record.accountId,
    tenantId: record.tenantId,
    principalId: record.principalId,
  };
}

function sameIdentity(left: SubjectIdentity, right: SubjectIdentity): boolean {
  return left.accountId === right.accountId &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId;
}

export function createInMemorySubjectCorrelationIndex(): SubjectCorrelationIndexPort {
  const records = new Map<string, SubjectCorrelationRecord>();
  return {
    async record(input) {
      const record = subjectCorrelationRecordSchema.parse(input);
      const existing = records.get(record.correlationKey);
      if (
        existing &&
        !sameIdentity(identityFromRecord(existing), identityFromRecord(record))
      ) {
        throw new Error("SUBJECT_CORRELATION_CONFLICT");
      }
      records.set(record.correlationKey, record);
    },
    async resolve(correlationKey) {
      const record = records.get(correlationKey);
      return record ? identityFromRecord(record) : undefined;
    },
  };
}

type SubjectCorrelationRow = Record<string, unknown> & {
  account_id: string;
  tenant_id: string;
  principal_id: string;
};

export class PgSubjectCorrelationIndex implements SubjectCorrelationIndexPort {
  constructor(private readonly database: Queryable) {}

  async record(input: SubjectCorrelationRecord): Promise<void> {
    const record = subjectCorrelationRecordSchema.parse(input);
    const result = await this.database.query(
      `INSERT INTO subject_correlation_index
         (correlation_key, account_id, tenant_id, principal_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (correlation_key) DO UPDATE
       SET recorded_at = GREATEST(subject_correlation_index.recorded_at, EXCLUDED.recorded_at)
       WHERE subject_correlation_index.account_id = EXCLUDED.account_id
         AND subject_correlation_index.tenant_id = EXCLUDED.tenant_id
         AND subject_correlation_index.principal_id = EXCLUDED.principal_id`,
      [
        record.correlationKey,
        record.accountId,
        record.tenantId,
        record.principalId,
        record.recordedAt,
      ],
    );
    if (result.rowCount === 0) {
      throw new Error("SUBJECT_CORRELATION_CONFLICT");
    }
  }

  async resolve(correlationKey: string): Promise<SubjectIdentity | undefined> {
    const result = await this.database.query<SubjectCorrelationRow>(
      `SELECT account_id, tenant_id, principal_id
       FROM subject_correlation_index
       WHERE correlation_key = $1`,
      [correlationKey],
    );
    const row = result.rows[0];
    return row
      ? {
          accountId: row.account_id,
          tenantId: row.tenant_id,
          principalId: row.principal_id,
        }
      : undefined;
  }
}

export async function recordExecutionContextCorrelations(
  index: SubjectCorrelationIndexPort,
  context: ExecutionContext,
  now: () => Date = () => new Date(),
): Promise<void> {
  const accountId = context.accountId ?? context.principal.accountId;
  if (!accountId) return;
  const identity: SubjectIdentity = {
    accountId,
    tenantId: context.principal.tenantId,
    principalId: context.principal.principalId,
  };
  const values: ReadonlyArray<[CorrelationDimension, string | undefined]> = [
    ["requestId", context.requestId],
    ["threadId", context.threadId],
    ["runId", context.runId],
    ["taskId", context.taskId],
    ["stepId", context.stepId],
    ["toolCallId", context.toolCallId],
    ["toolExecutionId", context.toolExecutionId],
  ];
  const recordedAt = now().toISOString();
  await Promise.all(
    values.flatMap(([dimension, value]) =>
      value
        ? [index.record({
            schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
            correlationKey: createCorrelationKey(dimension, value),
            ...identity,
            recordedAt,
          })]
        : [],
    ),
  );
}
