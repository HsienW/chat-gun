import { describe, expect, it, vi } from "vitest";

import { RETENTION_POLICY_SCHEMA_VERSION } from "./contracts.js";
import {
  RetentionPolicyRegistry,
  RetentionSweep,
  type RetentionCandidate,
  type RetentionSweepDriver,
} from "./retention.js";

const defaultPolicy = {
  schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
  policyId: "default-policy",
  version: 1,
  durationDays: 30,
  expiryAction: "delete" as const,
};

describe("RetentionPolicyRegistry", () => {
  it("validates versioned policies and fails closed for unknown data classes", () => {
    const registry = new RetentionPolicyRegistry(defaultPolicy);
    registry.register("runtime.tasks", {
      ...defaultPolicy,
      policyId: "runtime-task-policy",
      version: 2,
      durationDays: 7,
    });

    expect(registry.resolve("runtime.tasks")).toMatchObject({
      policyId: "runtime-task-policy",
      version: 2,
    });
    expect(() => registry.resolve("unknown.data")).toThrow(
      "RETENTION_POLICY_UNKNOWN_DATA_CLASS",
    );
    expect(() =>
      registry.register("runtime.invalid", {
        ...defaultPolicy,
        schemaVersion: "9.9.9" as typeof defaultPolicy.schemaVersion,
      }),
    ).toThrow("DATA_GOVERNANCE_VALIDATION_FAILED");
  });
});

describe("RetentionSweep", () => {
  it("uses the policy expiry boundary and limits each invocation", async () => {
    const candidates: RetentionCandidate[] = [
      { dataClassId: "runtime.tasks", recordId: "record_01" },
      { dataClassId: "runtime.tasks", recordId: "record_02" },
      { dataClassId: "runtime.tasks", recordId: "record_03" },
    ];
    const driver: RetentionSweepDriver = {
      scanExpired: vi.fn(async ({ limit }) => ({
        candidates: candidates.slice(0, limit),
        nextCursor: "cursor_02",
      })),
      applyExpiry: vi.fn(async () => undefined),
    };
    const policies = new RetentionPolicyRegistry(defaultPolicy);
    policies.register("runtime.tasks", {
      ...defaultPolicy,
      durationDays: 7,
    });
    const sweep = new RetentionSweep(policies, driver, {
      maxRecordsPerRun: 2,
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });

    const state = await sweep.run({
      workflowId: "retention_01",
      dataClassId: "runtime.tasks",
    });

    expect(driver.scanExpired).toHaveBeenCalledWith({
      dataClassId: "runtime.tasks",
      expiresBefore: "2026-09-23T00:00:00.000Z",
      cursor: null,
      limit: 2,
    });
    expect(driver.applyExpiry).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({
      status: "in_progress",
      cursor: "cursor_02",
      completedRecordKeys: [
        "runtime.tasks:record_01",
        "runtime.tasks:record_02",
      ],
      retryableCandidates: [],
    });
  });

  it("is safely re-entrant and retries only failed candidates", async () => {
    let recordTwoAttempts = 0;
    const driver: RetentionSweepDriver = {
      scanExpired: vi.fn(async () => ({ candidates: [], nextCursor: null })),
      applyExpiry: vi.fn(async ({ candidate }) => {
        if (candidate.recordId === "record_02" && recordTwoAttempts++ === 0) {
          throw new Error("temporary unavailable");
        }
      }),
    };
    const policies = new RetentionPolicyRegistry(defaultPolicy);
    policies.register("runtime.tasks", defaultPolicy);
    const sweep = new RetentionSweep(policies, driver, {
      maxRecordsPerRun: 4,
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });
    const initial = {
      schemaVersion: "1.0.0" as const,
      workflowId: "retention_02",
      dataClassId: "runtime.tasks",
      policyId: "default-policy",
      policyVersion: 1,
      status: "in_progress" as const,
      cursor: null,
      completedRecordKeys: ["runtime.tasks:record_01"],
      retryableCandidates: [
        { dataClassId: "runtime.tasks", recordId: "record_02" },
      ],
      processedRecords: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
    };

    const failed = await sweep.run({
      workflowId: "retention_02",
      dataClassId: "runtime.tasks",
      previousState: initial,
    });
    expect(failed.status).toBe("failed");
    expect(failed.retryableCandidates).toHaveLength(1);

    const resumed = await sweep.run({
      workflowId: "retention_02",
      dataClassId: "runtime.tasks",
      previousState: failed,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.retryableCandidates).toEqual([]);
    expect(resumed.completedRecordKeys).toContain("runtime.tasks:record_02");
    expect(driver.applyExpiry).toHaveBeenCalledTimes(2);
  });
});
