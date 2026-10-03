import {
  consentRecordSchema,
  validateConsentRecord,
  type ConsentRecord,
} from "./contracts.js";
import type { Queryable } from "../persistence/rows.js";

export interface ConsentRecordStore {
  append(record: ConsentRecord): Promise<void>;
  findById(consentId: string): Promise<ConsentRecord | undefined>;
  listByAccount(accountId: string): Promise<ConsentRecord[]>;
}

function copyRecord(record: ConsentRecord): ConsentRecord {
  return { ...record };
}

export class InMemoryConsentRecordStore implements ConsentRecordStore {
  private readonly records = new Map<string, ConsentRecord>();

  async append(record: ConsentRecord): Promise<void> {
    if (this.records.has(record.consentId)) {
      throw new Error("CONSENT_ID_ALREADY_EXISTS");
    }
    this.records.set(record.consentId, copyRecord(record));
  }

  async findById(consentId: string): Promise<ConsentRecord | undefined> {
    const record = this.records.get(consentId);
    return record ? copyRecord(record) : undefined;
  }

  async listByAccount(accountId: string): Promise<ConsentRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId)
      .map(copyRecord);
  }
}

type ConsentRow = Record<string, unknown> & {
  consent_id: string;
  account_id: string;
  policy_version: number;
  status: string;
  scope: string;
  recorded_at: string | Date;
};

function consentFromRow(row: ConsentRow): ConsentRecord {
  return consentRecordSchema.parse({
    schemaVersion: "1.0.0",
    consentId: row.consent_id,
    accountId: row.account_id,
    policyVersion: row.policy_version,
    status: row.status,
    scope: row.scope,
    recordedAt: new Date(row.recorded_at).toISOString(),
  });
}

export class PgConsentRecordStore implements ConsentRecordStore {
  constructor(private readonly database: Queryable) {}

  async append(record: ConsentRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO consent_records
         (consent_id, account_id, policy_version, status, scope, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.consentId, record.accountId, record.policyVersion, record.status,
        record.scope, record.recordedAt],
    );
  }

  async findById(consentId: string): Promise<ConsentRecord | undefined> {
    const result = await this.database.query<ConsentRow>(
      `SELECT consent_id, account_id, policy_version, status, scope, recorded_at
       FROM consent_records WHERE consent_id = $1`,
      [consentId],
    );
    return result.rows[0] ? consentFromRow(result.rows[0]) : undefined;
  }

  async listByAccount(accountId: string): Promise<ConsentRecord[]> {
    const result = await this.database.query<ConsentRow>(
      `SELECT consent_id, account_id, policy_version, status, scope, recorded_at
       FROM consent_records WHERE account_id = $1
       ORDER BY policy_version DESC, recorded_at DESC, consent_id DESC`,
      [accountId],
    );
    return result.rows.map(consentFromRow);
  }
}

export type ConsentBoundaryDecision =
  | {
      allowed: true;
      consentId: string;
      policyVersion: number;
    }
  | {
      allowed: false;
      reasonCode: "CONSENT_NOT_FOUND";
    }
  | {
      allowed: false;
      reasonCode: "CONSENT_WITHDRAWN";
      consentId: string;
      policyVersion: number;
    };

function compareNewest(left: ConsentRecord, right: ConsentRecord): number {
  if (left.policyVersion !== right.policyVersion) {
    return right.policyVersion - left.policyVersion;
  }
  const timestampOrder = right.recordedAt.localeCompare(left.recordedAt);
  return timestampOrder !== 0
    ? timestampOrder
    : right.consentId.localeCompare(left.consentId);
}

export class ConsentService {
  constructor(private readonly store: ConsentRecordStore) {}

  async record(input: unknown): Promise<ConsentRecord> {
    const record = validateConsentRecord(input);
    if (await this.store.findById(record.consentId)) {
      throw new Error("CONSENT_ID_ALREADY_EXISTS");
    }
    await this.store.append(record);
    return copyRecord(record);
  }

  async checkResumeBoundary(
    accountId: string,
    scope: ConsentRecord["scope"],
  ): Promise<ConsentBoundaryDecision> {
    const latest = (await this.store.listByAccount(accountId))
      .filter((record) => record.scope === scope)
      .sort(compareNewest)[0];
    if (!latest) {
      return { allowed: false, reasonCode: "CONSENT_NOT_FOUND" };
    }
    if (latest.status === "withdrawn") {
      return {
        allowed: false,
        reasonCode: "CONSENT_WITHDRAWN",
        consentId: latest.consentId,
        policyVersion: latest.policyVersion,
      };
    }
    return {
      allowed: true,
      consentId: latest.consentId,
      policyVersion: latest.policyVersion,
    };
  }
}
