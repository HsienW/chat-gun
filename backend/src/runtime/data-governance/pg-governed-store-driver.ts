import type { Queryable } from "../persistence/rows.js";
import type { DataInventoryEntry, SubjectIdentity } from "./contracts.js";
import type { GovernedStoreDriver } from "./governed-store.js";

export type PgGovernedStorePlan =
  | {
      dataClassId: string;
      table: string;
      resolution: "direct";
      subjectColumns: Partial<Record<keyof SubjectIdentity, string>>;
    }
  | {
      dataClassId: string;
      table: string;
      resolution: "correlation";
      correlationColumn: string;
      correlationDimension: string;
    };

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertIdentifier(value: string): string {
  if (!SQL_IDENTIFIER.test(value)) throw new Error("INVALID_GOVERNED_SQL_IDENTIFIER");
  return value;
}

function predicateForPlan(plan: PgGovernedStorePlan) {
  if (plan.resolution === "correlation") {
    const column = assertIdentifier(plan.correlationColumn);
    return {
      join: `JOIN subject_correlation_index sci ON sci.correlation_key = $4 || t.${column}`,
      where: "sci.account_id = $1 AND sci.tenant_id = $2 AND sci.principal_id = $3",
      values: (subject: SubjectIdentity) => [
        subject.accountId,
        subject.tenantId,
        subject.principalId,
        `${plan.correlationDimension}:`,
      ],
    };
  }
  const fields = Object.entries(plan.subjectColumns) as Array<
    [keyof SubjectIdentity, string]
  >;
  if (fields.length === 0) throw new Error("GOVERNED_STORE_SUBJECT_COLUMNS_REQUIRED");
  const values = (subject: SubjectIdentity) =>
    fields.map(([field]) => subject[field]);
  return {
    join: "",
    where: fields
      .map(([, column], index) => `t.${assertIdentifier(column)} = $${index + 1}`)
      .join(" AND "),
    values,
  };
}

export class PgGovernedStoreDriver implements GovernedStoreDriver {
  private readonly plans: Map<string, PgGovernedStorePlan>;

  constructor(
    private readonly database: Queryable,
    plans: readonly PgGovernedStorePlan[],
  ) {
    this.plans = new Map();
    for (const plan of plans) {
      assertIdentifier(plan.table);
      if (this.plans.has(plan.dataClassId)) {
        throw new Error("DUPLICATE_GOVERNED_STORE_PLAN");
      }
      predicateForPlan(plan);
      this.plans.set(plan.dataClassId, plan);
    }
  }

  private requirePlan(dataClassId: string) {
    const plan = this.plans.get(dataClassId);
    if (!plan) throw new Error("GOVERNED_STORE_PLAN_NOT_FOUND");
    return plan;
  }

  async exportBySubject(dataClassId: string, subject: SubjectIdentity) {
    const plan = this.requirePlan(dataClassId);
    const predicate = predicateForPlan(plan);
    const result = await this.database.query<{ record: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS record FROM ${plan.table} t ${predicate.join}
       WHERE ${predicate.where}`,
      predicate.values(subject),
    );
    return result.rows.map((row) => row.record);
  }

  async deleteBySubject(dataClassId: string, subject: SubjectIdentity) {
    const plan = this.requirePlan(dataClassId);
    const predicate = predicateForPlan(plan);
    const result = await this.database.query(
      plan.resolution === "correlation"
        ? `DELETE FROM ${plan.table} t USING subject_correlation_index sci
           WHERE ${predicate.where}
             AND sci.correlation_key = $4 || t.${assertIdentifier(plan.correlationColumn)}`
        : `DELETE FROM ${plan.table} t WHERE ${predicate.where}`,
      predicate.values(subject),
    );
    return result.rowCount ?? 0;
  }

  async countBySubject(dataClassId: string, subject: SubjectIdentity) {
    const plan = this.requirePlan(dataClassId);
    const predicate = predicateForPlan(plan);
    const result = await this.database.query<{ record_count: number }>(
      `SELECT COUNT(*)::int AS record_count FROM ${plan.table} t ${predicate.join}
       WHERE ${predicate.where}`,
      predicate.values(subject),
    );
    return result.rows[0]?.record_count ?? 0;
  }
}

const COLUMN_OVERRIDES: Readonly<Record<string, string>> = {
  correlationKey: "key",
  tenantId: "tenant_id",
  principalId: "principal_id",
  accountId: "account_id",
  taskId: "task_id",
  runId: "run_id",
  threadId: "thread_id",
  stepId: "step_id",
  toolExecutionId: "tool_execution_id",
  workflowId: "workflow_id",
  subjectIdHash: "subject_id_hash",
  memoryNamespace: "namespace",
};

const DATA_CLASS_COLUMN_OVERRIDES: Readonly<Record<string, string>> = {
  "runtime.permission-grants": "granted_by_principal_id",
};

export function createDefaultPgGovernedPlans(
  entries: readonly DataInventoryEntry[],
): PgGovernedStorePlan[] {
  const plans: PgGovernedStorePlan[] = [];
  for (const entry of entries) {
    if (!entry.authoritativeStore.startsWith("postgres.") ||
        entry.dataClassId.startsWith("identity.")) continue;
    const table = entry.authoritativeStore.slice("postgres.".length);
    const column = DATA_CLASS_COLUMN_OVERRIDES[entry.dataClassId] ??
      COLUMN_OVERRIDES[entry.subjectKey.key];
    if (!column) throw new Error("GOVERNED_STORE_SUBJECT_COLUMN_NOT_FOUND");
    if (entry.subjectKey.tier === "correlation") {
      plans.push({
        dataClassId: entry.dataClassId,
        table,
        resolution: "correlation",
        correlationColumn: column,
        correlationDimension: entry.subjectKey.key,
      });
    } else if (entry.subjectKey.tier === "direct") {
      plans.push({
        dataClassId: entry.dataClassId,
        table,
        resolution: "direct",
        subjectColumns: { [entry.subjectKey.key]: column },
      });
    }
  }
  return plans;
}
