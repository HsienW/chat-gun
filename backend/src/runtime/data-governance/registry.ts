import {
  DATA_INVENTORY_SCHEMA_VERSION,
  RETENTION_POLICY_SCHEMA_VERSION,
  validateDataInventoryEntry,
  type DataInventoryEntry,
  type GovernedDataStore,
} from "./contracts.js";

export type InventoryCompletenessReport = {
  complete: boolean;
  missingAuthoritativeStores: string[];
  unreachableDataClassIds: string[];
};

export class DataInventoryRegistry {
  private readonly registrations = new Map<
    string,
    { entry: DataInventoryEntry; store: GovernedDataStore }
  >();

  register(entryInput: unknown, store: GovernedDataStore): void {
    const entry = validateDataInventoryEntry(entryInput);
    if (entry.dataClassId !== store.id) {
      throw new Error("GOVERNED_STORE_ID_MISMATCH");
    }
    if (
      entry.subjectKey.tier !== store.subjectKey.tier ||
      entry.subjectKey.key !== store.subjectKey.key
    ) {
      throw new Error("GOVERNED_STORE_SUBJECT_KEY_MISMATCH");
    }
    if (this.registrations.has(entry.dataClassId)) {
      throw new Error("DATA_CLASS_ALREADY_REGISTERED");
    }
    this.registrations.set(entry.dataClassId, { entry, store });
  }

  getEntry(dataClassId: string): DataInventoryEntry | undefined {
    return this.registrations.get(dataClassId)?.entry;
  }

  listEntries(): DataInventoryEntry[] {
    return [...this.registrations.values()].map(({ entry }) => entry);
  }

  listStores(): GovernedDataStore[] {
    return [...this.registrations.values()].map(({ store }) => store);
  }
}

const DEFAULT_RETENTION_POLICY = {
  schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
  policyId: "default-subject-data",
  version: 1,
  durationDays: 30,
  expiryAction: "delete" as const,
};

const MINIMUM_AUDIT_RETENTION_POLICY = {
  schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
  policyId: "minimum-audit-evidence",
  version: 1,
  durationDays: 3650,
  expiryAction: "retain_by_policy" as const,
};

const MINIMUM_AUDIT_EXCEPTION = {
  policyId: "minimum-audit-evidence",
  reasonCode: "LEGAL_AUDIT_MINIMUM",
  identifierMinimized: true as const,
};

type EntryOptions = {
  dataClassId: string;
  authoritativeStore: string;
  purpose: string;
  tier: DataInventoryEntry["subjectKey"]["tier"];
  key: DataInventoryEntry["subjectKey"]["key"];
  sensitivity?: DataInventoryEntry["sensitivity"];
  deletionBehavior?: DataInventoryEntry["deletionBehavior"];
  exportBehavior?: DataInventoryEntry["exportBehavior"];
  retainMinimumAudit?: boolean;
  derivedCopiesCaches?: DataInventoryEntry["derivedCopiesCaches"];
};

function createInventoryEntry(options: EntryOptions): DataInventoryEntry {
  const retainMinimumAudit = options.retainMinimumAudit ?? false;
  return validateDataInventoryEntry({
    schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
    dataClassId: options.dataClassId,
    authoritativeStore: options.authoritativeStore,
    ownerSubject: ["accountId", "tenantId", "principalId"],
    subjectKey: { tier: options.tier, key: options.key },
    purpose: options.purpose,
    sensitivity: options.sensitivity ?? "confidential",
    retentionPolicy: retainMinimumAudit
      ? MINIMUM_AUDIT_RETENTION_POLICY
      : DEFAULT_RETENTION_POLICY,
    exportBehavior: options.exportBehavior ?? "subject_only",
    deletionBehavior:
      options.deletionBehavior ??
      (retainMinimumAudit ? "retain_minimum_audit" : "delete"),
    legalAuditException: retainMinimumAudit
      ? MINIMUM_AUDIT_EXCEPTION
      : null,
    derivedCopiesCaches: options.derivedCopiesCaches ?? [],
  });
}

const MIGRATION_ENTRIES: readonly EntryOptions[] = [
  { dataClassId: "runtime.tasks", authoritativeStore: "postgres.agent_tasks", purpose: "durable runtime task state", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.steps", authoritativeStore: "postgres.task_steps", purpose: "durable runtime step state", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.events", authoritativeStore: "postgres.task_events", purpose: "durable runtime event history", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.idempotency", authoritativeStore: "postgres.idempotency_records", purpose: "side-effect idempotency", tier: "correlation", key: "correlationKey" },
  { dataClassId: "runtime.audit", authoritativeStore: "postgres.audit_events", purpose: "minimum immutable audit evidence", tier: "correlation", key: "taskId", sensitivity: "restricted", exportBehavior: "excluded", retainMinimumAudit: true },
  { dataClassId: "runtime.business-effects", authoritativeStore: "postgres.business_effects", purpose: "minimum side-effect commitment evidence", tier: "direct", key: "tenantId", exportBehavior: "excluded", retainMinimumAudit: true },
  { dataClassId: "runtime.tool-executions", authoritativeStore: "postgres.tool_executions", purpose: "tool execution ledger", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.tool-execution-attempts", authoritativeStore: "postgres.tool_execution_attempts", purpose: "tool attempt ledger", tier: "correlation", key: "toolExecutionId" },
  { dataClassId: "runtime.compensation", authoritativeStore: "postgres.compensation_executions", purpose: "compensation execution ledger", tier: "correlation", key: "toolExecutionId" },
  { dataClassId: "runtime.result-references", authoritativeStore: "postgres.result_references", purpose: "tool result references", tier: "direct", key: "principalId", derivedCopiesCaches: [{ id: "result-reference-cache", kind: "cache", rebuildable: true, clearable: true, authoritative: false }] },
  { dataClassId: "runtime.permission-grants", authoritativeStore: "postgres.permission_grants", purpose: "authorization grants", tier: "direct", key: "principalId" },
  { dataClassId: "runtime.permission-decisions", authoritativeStore: "postgres.permission_decisions", purpose: "authorization decisions", tier: "direct", key: "principalId" },
  { dataClassId: "runtime.active-run-ownership", authoritativeStore: "postgres.active_run_ownership", purpose: "active run ownership", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.decisions", authoritativeStore: "postgres.decision_records", purpose: "provenance decision records", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.decision-evidence", authoritativeStore: "postgres.decision_evidence_refs", purpose: "minimum provenance evidence references", tier: "direct", key: "tenantId", exportBehavior: "excluded", retainMinimumAudit: true },
  { dataClassId: "runtime.context-references", authoritativeStore: "postgres.context_refs", purpose: "minimum provenance context references", tier: "direct", key: "tenantId", exportBehavior: "excluded", retainMinimumAudit: true },
  { dataClassId: "runtime.confirmations", authoritativeStore: "postgres.authorization_confirmations", purpose: "minimum authorization confirmation evidence", tier: "direct", key: "tenantId", exportBehavior: "excluded", retainMinimumAudit: true },
  { dataClassId: "runtime.interrupt-manifests", authoritativeStore: "postgres.interrupt_manifests", purpose: "durable interrupt manifests", tier: "correlation", key: "taskId" },
  { dataClassId: "runtime.recovery-records", authoritativeStore: "postgres.recovery_records", purpose: "durable recovery records", tier: "correlation", key: "taskId" },
  { dataClassId: "governance.subject-correlations", authoritativeStore: "postgres.subject_correlation_index", purpose: "authoritative subject ownership correlations", tier: "direct", key: "accountId", sensitivity: "restricted" },
  { dataClassId: "governance.workflows", authoritativeStore: "postgres.subject_right_workflows", purpose: "durable subject-right workflow state", tier: "direct", key: "accountId", sensitivity: "restricted" },
  { dataClassId: "governance.deletion-receipts", authoritativeStore: "postgres.deletion_receipts", purpose: "non-sensitive deletion evidence", tier: "correlation", key: "workflowId", sensitivity: "internal" },
  { dataClassId: "governance.consent-records", authoritativeStore: "postgres.consent_records", purpose: "versioned append-only consent facts", tier: "direct", key: "accountId", sensitivity: "restricted" },
  { dataClassId: "governance.tombstones", authoritativeStore: "postgres.data_tombstones", purpose: "prevent deleted subject or object recreation", tier: "exception", key: "subjectIdHash", sensitivity: "restricted", exportBehavior: "excluded", deletionBehavior: "retain_minimum_audit", retainMinimumAudit: true },
  { dataClassId: "identity.accounts", authoritativeStore: "postgres.identity_accounts", purpose: "consumer account identity", tier: "direct", key: "accountId", sensitivity: "restricted", deletionBehavior: "tombstone" },
  { dataClassId: "identity.users", authoritativeStore: "postgres.identity_users", purpose: "consumer user mapping", tier: "direct", key: "accountId", sensitivity: "restricted" },
  { dataClassId: "identity.tenants", authoritativeStore: "postgres.identity_tenants", purpose: "personal tenant mapping", tier: "direct", key: "accountId", sensitivity: "restricted" },
  { dataClassId: "identity.credentials", authoritativeStore: "postgres.identity_credentials", purpose: "consumer credentials", tier: "direct", key: "accountId", sensitivity: "restricted", exportBehavior: "excluded" },
  { dataClassId: "identity.sessions", authoritativeStore: "postgres.identity_sessions", purpose: "consumer sessions", tier: "direct", key: "accountId", sensitivity: "restricted", exportBehavior: "excluded" },
  { dataClassId: "identity.account-tombstones", authoritativeStore: "postgres.identity_account_tombstones", purpose: "prevent deleted account recreation", tier: "exception", key: "accountId", sensitivity: "restricted", exportBehavior: "excluded", deletionBehavior: "retain_minimum_audit", retainMinimumAudit: true },
  { dataClassId: "identity.anonymous-migrations", authoritativeStore: "postgres.identity_anonymous_migrations", purpose: "anonymous-to-account migration ledger", tier: "direct", key: "accountId", sensitivity: "restricted" },
];

const NON_MIGRATION_ENTRIES: readonly EntryOptions[] = [
  { dataClassId: "memory.long-term", authoritativeStore: "langgraph.memory_store", purpose: "governed long-term memory", tier: "direct", key: "principalId" },
  { dataClassId: "runtime.checkpoints", authoritativeStore: "langgraph.checkpoint_store", purpose: "durable graph checkpoints", tier: "correlation", key: "threadId" },
  { dataClassId: "runtime.cache", authoritativeStore: "redis.runtime_cache", purpose: "rebuildable runtime cache", tier: "correlation", key: "correlationKey", deletionBehavior: "clear_projection", derivedCopiesCaches: [{ id: "redis-runtime-cache", kind: "cache", rebuildable: true, clearable: true, authoritative: false }] },
  { dataClassId: "runtime.observability-projection", authoritativeStore: "opik.trace_projection", purpose: "identifier-minimized observability projection", tier: "correlation", key: "runId", sensitivity: "internal", exportBehavior: "excluded", deletionBehavior: "clear_projection", derivedCopiesCaches: [{ id: "opik-trace-projection", kind: "projection", rebuildable: true, clearable: true, authoritative: false }] },
];

export function createDefaultInventoryEntries(): DataInventoryEntry[] {
  return [...MIGRATION_ENTRIES, ...NON_MIGRATION_ENTRIES].map(createInventoryEntry);
}

export function assertInventoryCompleteness(
  registry: DataInventoryRegistry,
  authoritativeStores: readonly string[],
): InventoryCompletenessReport {
  const entries = registry.listEntries();
  const registeredStores = new Set(
    entries.map((entry) => entry.authoritativeStore),
  );
  const missingAuthoritativeStores = authoritativeStores.filter(
    (store) => !registeredStores.has(store),
  );
  const unreachableDataClassIds = entries
    .filter(
      (entry) =>
        entry.subjectKey.tier === "exception" &&
        entry.legalAuditException === null,
    )
    .map((entry) => entry.dataClassId);

  return {
    complete:
      missingAuthoritativeStores.length === 0 &&
      unreachableDataClassIds.length === 0,
    missingAuthoritativeStores,
    unreachableDataClassIds,
  };
}
