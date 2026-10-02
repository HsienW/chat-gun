import { z } from "zod";

import {
  DATA_INVENTORY_SCHEMA_VERSION,
  validateRetentionPolicy,
  type RetentionPolicy,
} from "./contracts.js";

const retentionCandidateSchema = z
  .object({
    dataClassId: z.string().min(1).max(128),
    recordId: z.string().min(1).max(512),
  })
  .strict();

export const retentionSweepStateSchema = z
  .object({
    schemaVersion: z.literal(DATA_INVENTORY_SCHEMA_VERSION),
    workflowId: z.string().min(1).max(256),
    dataClassId: z.string().min(1).max(128),
    policyId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive(),
    status: z.enum(["in_progress", "completed", "failed"]),
    cursor: z.string().min(1).nullable(),
    completedRecordKeys: z.array(z.string().min(1)),
    retryableCandidates: z.array(retentionCandidateSchema),
    processedRecords: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type RetentionCandidate = z.infer<typeof retentionCandidateSchema>;
export type RetentionSweepState = z.infer<typeof retentionSweepStateSchema>;

export interface RetentionSweepDriver {
  scanExpired(input: {
    dataClassId: string;
    expiresBefore: string;
    cursor: string | null;
    limit: number;
  }): Promise<{
    candidates: RetentionCandidate[];
    nextCursor: string | null;
  }>;
  applyExpiry(input: {
    candidate: RetentionCandidate;
    action: RetentionPolicy["expiryAction"];
    idempotencyKey: string;
  }): Promise<void>;
}

export class RetentionPolicyRegistry {
  private readonly policies = new Map<string, RetentionPolicy>();
  readonly defaultPolicy: RetentionPolicy;

  constructor(defaultPolicyInput: unknown) {
    this.defaultPolicy = validateRetentionPolicy(defaultPolicyInput);
  }

  register(dataClassId: string, policyInput?: unknown): void {
    if (dataClassId.length === 0 || dataClassId.length > 128) {
      throw new Error("RETENTION_POLICY_INVALID_DATA_CLASS");
    }
    if (this.policies.has(dataClassId)) {
      throw new Error("RETENTION_POLICY_ALREADY_REGISTERED");
    }
    this.policies.set(
      dataClassId,
      validateRetentionPolicy(policyInput ?? this.defaultPolicy),
    );
  }

  resolve(dataClassId: string): RetentionPolicy {
    const policy = this.policies.get(dataClassId);
    if (!policy) throw new Error("RETENTION_POLICY_UNKNOWN_DATA_CLASS");
    return policy;
  }
}

type RetentionSweepOptions = {
  maxRecordsPerRun: number;
  now?: () => Date;
};

type RunRetentionSweepInput = {
  workflowId: string;
  dataClassId: string;
  previousState?: RetentionSweepState;
};

function recordKey(candidate: RetentionCandidate): string {
  return `${candidate.dataClassId}:${candidate.recordId}`;
}

function expiryBoundary(now: Date, durationDays: number): string {
  return new Date(
    now.getTime() - durationDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

export class RetentionSweep {
  private readonly now: () => Date;

  constructor(
    private readonly policies: RetentionPolicyRegistry,
    private readonly driver: RetentionSweepDriver,
    private readonly options: RetentionSweepOptions,
  ) {
    if (
      !Number.isInteger(options.maxRecordsPerRun) ||
      options.maxRecordsPerRun < 1 ||
      options.maxRecordsPerRun > 10_000
    ) {
      throw new Error("RETENTION_SWEEP_INVALID_BOUND");
    }
    this.now = options.now ?? (() => new Date());
  }

  async run(input: RunRetentionSweepInput): Promise<RetentionSweepState> {
    const policy = this.policies.resolve(input.dataClassId);
    const previous = input.previousState
      ? retentionSweepStateSchema.parse(input.previousState)
      : undefined;
    if (
      previous &&
      (previous.workflowId !== input.workflowId ||
        previous.dataClassId !== input.dataClassId)
    ) {
      throw new Error("RETENTION_SWEEP_STATE_MISMATCH");
    }
    if (
      previous &&
      (previous.policyId !== policy.policyId ||
        previous.policyVersion !== policy.version)
    ) {
      throw new Error("RETENTION_SWEEP_POLICY_VERSION_MISMATCH");
    }

    const completedRecordKeys = new Set(previous?.completedRecordKeys ?? []);
    const retryableCandidates = [...(previous?.retryableCandidates ?? [])];
    const capacity = this.options.maxRecordsPerRun - retryableCandidates.length;
    let nextCursor = previous?.cursor ?? null;
    let scannedCandidates: RetentionCandidate[] = [];

    if (capacity > 0) {
      const batch = await this.driver.scanExpired({
        dataClassId: input.dataClassId,
        expiresBefore: expiryBoundary(this.now(), policy.durationDays),
        cursor: nextCursor,
        limit: capacity,
      });
      scannedCandidates = batch.candidates.map((candidate) =>
        retentionCandidateSchema.parse(candidate),
      );
      nextCursor = batch.nextCursor;
    }

    const candidates = [...retryableCandidates, ...scannedCandidates]
      .filter((candidate) => candidate.dataClassId === input.dataClassId)
      .filter((candidate) => !completedRecordKeys.has(recordKey(candidate)))
      .slice(0, this.options.maxRecordsPerRun);
    const failed: RetentionCandidate[] = [];

    for (const candidate of candidates) {
      const key = recordKey(candidate);
      try {
        await this.driver.applyExpiry({
          candidate,
          action: policy.expiryAction,
          idempotencyKey: `${input.workflowId}:${key}:${policy.version}`,
        });
        completedRecordKeys.add(key);
      } catch {
        failed.push(candidate);
      }
    }

    const status =
      failed.length > 0
        ? "failed"
        : nextCursor === null
          ? "completed"
          : "in_progress";
    return retentionSweepStateSchema.parse({
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      workflowId: input.workflowId,
      dataClassId: input.dataClassId,
      policyId: policy.policyId,
      policyVersion: policy.version,
      status,
      cursor: nextCursor,
      completedRecordKeys: [...completedRecordKeys],
      retryableCandidates: failed,
      processedRecords: completedRecordKeys.size,
      updatedAt: this.now().toISOString(),
    });
  }
}
