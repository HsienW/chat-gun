import { createHash } from "node:crypto";

import {
  TOMBSTONE_SCHEMA_VERSION,
  validateTombstone,
  type Tombstone,
} from "./contracts.js";
import type { Queryable } from "../persistence/rows.js";

const SUBJECT_ONLY_OBJECT_HASH = "0".repeat(64);

export function hashGovernedIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tombstoneKey(
  subjectIdHash: string,
  objectIdHash: string | undefined,
): string {
  return JSON.stringify([subjectIdHash, objectIdHash ?? null]);
}

export interface TombstoneRepository {
  find(
    subjectIdHash: string,
    objectIdHash: string | undefined,
  ): Promise<Tombstone | undefined>;
  save(tombstone: Tombstone): Promise<void>;
}

export interface TombstoneCache {
  get(key: string): Promise<Tombstone | undefined>;
  set(key: string, tombstone: Tombstone, ttlSeconds: number): Promise<void>;
}

function copyTombstone(tombstone: Tombstone): Tombstone {
  return { ...tombstone };
}

export class InMemoryTombstoneRepository implements TombstoneRepository {
  private readonly tombstones = new Map<string, Tombstone>();

  async find(
    subjectIdHash: string,
    objectIdHash: string | undefined,
  ): Promise<Tombstone | undefined> {
    const found = this.tombstones.get(
      tombstoneKey(subjectIdHash, objectIdHash),
    );
    return found ? copyTombstone(found) : undefined;
  }

  async save(tombstone: Tombstone): Promise<void> {
    this.tombstones.set(
      tombstoneKey(tombstone.subjectIdHash, tombstone.objectIdHash),
      copyTombstone(tombstone),
    );
  }
}

type TombstoneRow = Record<string, unknown> & {
  subject_id_hash: string;
  object_id_hash: string;
  deleted_at: string | Date;
  tombstone_version: number;
  deletion_reason: string;
};

export class PgTombstoneRepository implements TombstoneRepository {
  constructor(private readonly database: Queryable) {}

  async find(subjectIdHash: string, objectIdHash: string | undefined) {
    const result = await this.database.query<TombstoneRow>(
      `SELECT subject_id_hash, object_id_hash, deleted_at, tombstone_version, deletion_reason
       FROM data_tombstones
       WHERE subject_id_hash = $1 AND object_id_hash = $2`,
      [subjectIdHash, objectIdHash ?? SUBJECT_ONLY_OBJECT_HASH],
    );
    const row = result.rows[0];
    return row
      ? validateTombstone({
          schemaVersion: TOMBSTONE_SCHEMA_VERSION,
          subjectIdHash: row.subject_id_hash,
          ...(row.object_id_hash === SUBJECT_ONLY_OBJECT_HASH
            ? {}
            : { objectIdHash: row.object_id_hash }),
          deletedAt: new Date(row.deleted_at).toISOString(),
          tombstoneVersion: row.tombstone_version,
          deletionReason: row.deletion_reason,
        })
      : undefined;
  }

  async save(tombstone: Tombstone): Promise<void> {
    await this.database.query(
      `INSERT INTO data_tombstones
         (subject_id_hash, object_id_hash, deleted_at, tombstone_version, deletion_reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (subject_id_hash, object_id_hash) DO UPDATE SET
         deleted_at = EXCLUDED.deleted_at,
         tombstone_version = GREATEST(data_tombstones.tombstone_version, EXCLUDED.tombstone_version),
         deletion_reason = EXCLUDED.deletion_reason`,
      [tombstone.subjectIdHash, tombstone.objectIdHash ?? SUBJECT_ONLY_OBJECT_HASH,
        tombstone.deletedAt, tombstone.tombstoneVersion, tombstone.deletionReason],
    );
  }
}

export class InMemoryTombstoneCache implements TombstoneCache {
  private readonly entries = new Map<
    string,
    { tombstone: Tombstone; expiresAt: number }
  >();

  async get(key: string): Promise<Tombstone | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return copyTombstone(entry.tombstone);
  }

  async set(
    key: string,
    tombstone: Tombstone,
    ttlSeconds: number,
  ): Promise<void> {
    this.entries.set(key, {
      tombstone: copyTombstone(tombstone),
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
  }
}

type TombstoneServiceOptions = {
  activeRecordTtlSeconds: number;
  tombstoneTtlSeconds: number;
  now?: () => Date;
};

type TombstoneIdentity = {
  subjectId: string;
  objectId?: string;
};

export class TombstoneService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: TombstoneRepository,
    private readonly cache: TombstoneCache,
    private readonly options: TombstoneServiceOptions,
  ) {
    if (
      options.activeRecordTtlSeconds < 1 ||
      options.tombstoneTtlSeconds < options.activeRecordTtlSeconds
    ) {
      throw new Error("TOMBSTONE_TTL_TOO_SHORT");
    }
    this.now = options.now ?? (() => new Date());
  }

  async recordDeletion(
    input: TombstoneIdentity & { deletionReason: string },
  ): Promise<Tombstone> {
    const subjectIdHash = hashGovernedIdentifier(input.subjectId);
    const objectIdHash = input.objectId
      ? hashGovernedIdentifier(input.objectId)
      : undefined;
    const previous = await this.repository.find(subjectIdHash, objectIdHash);
    const tombstone = validateTombstone({
      schemaVersion: TOMBSTONE_SCHEMA_VERSION,
      subjectIdHash,
      ...(objectIdHash ? { objectIdHash } : {}),
      deletedAt: this.now().toISOString(),
      tombstoneVersion: (previous?.tombstoneVersion ?? 0) + 1,
      deletionReason: input.deletionReason,
    });
    await this.repository.save(tombstone);
    await this.cache.set(
      tombstoneKey(subjectIdHash, objectIdHash),
      tombstone,
      this.options.tombstoneTtlSeconds,
    );
    return tombstone;
  }

  async lookup(
    input: TombstoneIdentity,
  ): Promise<
    | { status: "deleted"; tombstoneVersion: number; deletedAt: string }
    | { status: "not_found" }
  > {
    const subjectIdHash = hashGovernedIdentifier(input.subjectId);
    const objectIdHash = input.objectId
      ? hashGovernedIdentifier(input.objectId)
      : undefined;
    const key = tombstoneKey(subjectIdHash, objectIdHash);
    const cached = await this.cache.get(key);
    const tombstone =
      cached ?? (await this.repository.find(subjectIdHash, objectIdHash));
    if (!tombstone) return { status: "not_found" };
    if (!cached) {
      await this.cache.set(key, tombstone, this.options.tombstoneTtlSeconds);
    }
    return {
      status: "deleted",
      tombstoneVersion: tombstone.tombstoneVersion,
      deletedAt: tombstone.deletedAt,
    };
  }
}

export type LateEventPolicy = "reject" | "quarantine" | "redact";

type LateEvent = TombstoneIdentity & {
  eventId: string;
  payload: Record<string, unknown>;
};

export class LateEventGuard {
  constructor(private readonly tombstones: TombstoneService) {}

  async evaluate(
    event: LateEvent,
    policy: LateEventPolicy,
  ): Promise<
    | { action: "allow"; allowWrite: true; event: LateEvent }
    | {
        action: LateEventPolicy;
        allowWrite: false;
        eventId: string;
        reasonCode: "SUBJECT_TOMBSTONED";
      }
  > {
    const result = await this.tombstones.lookup(event);
    if (result.status === "not_found") {
      return { action: "allow", allowWrite: true, event };
    }
    return {
      action: policy,
      allowWrite: false,
      eventId: event.eventId,
      reasonCode: "SUBJECT_TOMBSTONED",
    };
  }
}

type AuditEvidenceInput = {
  subjectId: string;
  eventId: string;
  reasonCode: string;
  evidenceRef: string;
  legalBasis: string;
  recordedAt: string;
};

export type MinimizedAuditEvidence = {
  subjectIdHash: string;
  eventId: string;
  reasonCode: string;
  evidenceRef: string;
  legalBasis: string;
  recordedAt: string;
  identifierMinimized: true;
};

export function minimizeAuditEvidence(
  input: AuditEvidenceInput,
): MinimizedAuditEvidence {
  return {
    subjectIdHash: hashGovernedIdentifier(input.subjectId),
    eventId: input.eventId,
    reasonCode: input.reasonCode,
    evidenceRef: input.evidenceRef,
    legalBasis: input.legalBasis,
    recordedAt: input.recordedAt,
    identifierMinimized: true,
  };
}
