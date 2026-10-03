import {
  validateSubjectDataRequest,
  validateSubjectDeletionRequest,
  validateSubjectDeletionVerification,
  type DataInventoryEntry,
  type DeletionPartResult,
  type ExportPartResult,
  type GovernedDataStore,
  type SubjectDeletionRequest,
  type SubjectDeletionVerification,
  type SubjectIdentity,
  type SubjectDataRequest,
  type VerificationResult,
} from "./contracts.js";
import { DataInventoryRegistry } from "./registry.js";

export interface GovernedStoreDriver {
  exportBySubject(
    dataClassId: string,
    subject: SubjectIdentity,
  ): Promise<Array<Record<string, unknown>>>;
  deleteBySubject(
    dataClassId: string,
    subject: SubjectIdentity,
  ): Promise<number>;
  countBySubject(
    dataClassId: string,
    subject: SubjectIdentity,
  ): Promise<number>;
}

export function createUnavailableGovernedStoreDriver(): GovernedStoreDriver {
  const unavailable = async (
    _dataClassId: string,
    _subject: SubjectIdentity,
  ): Promise<never> => {
    throw new Error("GOVERNED_STORE_DRIVER_UNAVAILABLE");
  };
  return {
    exportBySubject: unavailable,
    deleteBySubject: unavailable,
    countBySubject: unavailable,
  };
}

type InMemoryGovernedRecord = {
  dataClassId: string;
  subject: SubjectIdentity;
  recordId: string;
  value: Record<string, unknown>;
};

export type InMemoryGovernedStoreDriver = GovernedStoreDriver & {
  snapshot(): InMemoryGovernedRecord[];
  deleteCount(): number;
};

function sameSubject(left: SubjectIdentity, right: SubjectIdentity): boolean {
  return left.accountId === right.accountId &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId;
}

export function createInMemoryGovernedStoreDriver(
  initialRecords: readonly InMemoryGovernedRecord[] = [],
): InMemoryGovernedStoreDriver {
  let records = initialRecords.map((record) => ({
    ...record,
    subject: { ...record.subject },
    value: { ...record.value },
  }));
  let deletionCalls = 0;
  return {
    async exportBySubject(dataClassId, subject) {
      return records
        .filter(
          (record) =>
            record.dataClassId === dataClassId &&
            sameSubject(record.subject, subject),
        )
        .map((record) => ({ recordId: record.recordId, ...record.value }));
    },
    async deleteBySubject(dataClassId, subject) {
      deletionCalls += 1;
      const retained = records.filter(
        (record) =>
          record.dataClassId !== dataClassId ||
          !sameSubject(record.subject, subject),
      );
      const affectedRecords = records.length - retained.length;
      records = retained;
      return affectedRecords;
    },
    async countBySubject(dataClassId, subject) {
      return records.filter(
        (record) =>
          record.dataClassId === dataClassId &&
          sameSubject(record.subject, subject),
      ).length;
    },
    snapshot() {
      return records.map((record) => ({
        ...record,
        subject: { ...record.subject },
        value: { ...record.value },
      }));
    },
    deleteCount() {
      return deletionCalls;
    },
  };
}

function deletionOperationKey(
  request: SubjectDeletionRequest,
  dataClassId: string,
): string {
  const { accountId, tenantId, principalId } = request.subject;
  return JSON.stringify([
    request.workflowId,
    dataClassId,
    accountId,
    tenantId,
    principalId,
  ]);
}

export class GovernedStoreAdapter implements GovernedDataStore {
  readonly id: string;
  readonly subjectKey: DataInventoryEntry["subjectKey"];
  private readonly completedDeletions = new Map<string, DeletionPartResult>();

  constructor(
    private readonly entry: DataInventoryEntry,
    private readonly driver: GovernedStoreDriver,
  ) {
    this.id = entry.dataClassId;
    this.subjectKey = entry.subjectKey;
  }

  async exportSubjectData(input: SubjectDataRequest): Promise<ExportPartResult> {
    const request = validateSubjectDataRequest(input);
    if (this.entry.exportBehavior === "excluded") {
      return {
        status: "skipped",
        storeId: this.id,
        reasonCode: "EXPORT_EXCLUDED_BY_POLICY",
      };
    }
    try {
      const records = await this.driver.exportBySubject(this.id, request.subject);
      return { status: "completed", storeId: this.id, records };
    } catch {
      return {
        status: "failed",
        storeId: this.id,
        errorCode: "STORE_UNAVAILABLE",
        retryable: true,
      };
    }
  }

  async deleteSubjectData(
    input: SubjectDeletionRequest,
  ): Promise<DeletionPartResult> {
    const request = validateSubjectDeletionRequest(input);
    const operationKey = deletionOperationKey(request, this.id);
    const previous = this.completedDeletions.get(operationKey);
    if (previous) return previous;

    if (this.entry.deletionBehavior === "retain_minimum_audit") {
      const result: DeletionPartResult = {
        status: "retained_by_policy",
        storeId: this.id,
        policyId:
          this.entry.legalAuditException?.policyId ??
          this.entry.retentionPolicy.policyId,
        evidenceRef: `policy:${this.entry.retentionPolicy.policyId}:${this.id}`,
      };
      this.completedDeletions.set(operationKey, result);
      return result;
    }

    try {
      const affectedRecords = await this.driver.deleteBySubject(
        this.id,
        request.subject,
      );
      const result: DeletionPartResult = {
        status: "completed",
        storeId: this.id,
        affectedRecords,
      };
      this.completedDeletions.set(operationKey, result);
      return result;
    } catch {
      return {
        status: "failed",
        storeId: this.id,
        errorCode: "STORE_UNAVAILABLE",
        retryable: true,
      };
    }
  }

  async verifySubjectDeletion(
    input: SubjectDeletionVerification,
  ): Promise<VerificationResult> {
    const request = validateSubjectDeletionVerification(input);
    if (this.entry.deletionBehavior === "retain_minimum_audit") {
      return {
        status: "verified",
        storeId: this.id,
        evidenceRef: `policy:${this.entry.retentionPolicy.policyId}:${this.id}`,
      };
    }
    try {
      const remainingRecords = await this.driver.countBySubject(
        this.id,
        request.subject,
      );
      return remainingRecords === 0
        ? {
            status: "verified",
            storeId: this.id,
            evidenceRef: `verification:${this.id}:${request.receiptId}`,
          }
        : {
            status: "failed",
            storeId: this.id,
            errorCode: "SUBJECT_DATA_REMAINS",
            retryable: true,
          };
    } catch {
      return {
        status: "failed",
        storeId: this.id,
        errorCode: "STORE_UNAVAILABLE",
        retryable: true,
      };
    }
  }
}

export function registerBackendGovernedStores(
  registry: DataInventoryRegistry,
  entries: readonly DataInventoryEntry[],
  driver: GovernedStoreDriver,
): void {
  for (const entry of entries) {
    if (entry.dataClassId.startsWith("identity.")) continue;
    registry.register(entry, new GovernedStoreAdapter(entry, driver));
  }
}
