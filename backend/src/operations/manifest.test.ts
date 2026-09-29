import { describe, expect, it } from "vitest";

import {
  attachExecutionManifest,
  compareExecutionManifests,
  createManifestResumeDecision,
  evaluateDurableManifestState,
  readExecutionManifest,
  runExecutionManifestDeploymentHook,
} from "./manifest.js";
import type { ExecutionManifest } from "./types.js";

const BASE_MANIFEST: ExecutionManifest = {
  runtimeBuildId: "build-1",
  graphVersion: "graph-1",
  promptVersion: "prompt-1",
  modelRouteVersion: "route-1",
  toolSchemaVersion: "tool-1",
  policyVersion: "policy-1",
};
const POLICY = {
  policyVersion: "manifest-compatibility-v1",
  migratableFields: ["promptVersion", "domainSchemaVersion"],
};

describe("ExecutionManifest resume policy", () => {
  it("fails closed when a durable entity has no manifest", () => {
    expect(
      evaluateDurableManifestState({
        metadata: {},
        migrationStatus: "not_started",
        runtimeManifest: BASE_MANIFEST,
        policy: POLICY,
      })
    ).toEqual({
      status: "invalid_policy",
      reasonCode: "EXECUTION_MANIFEST_REQUIRED",
      canDispatch: false,
      canResume: false,
    });
  });

  it("blocks migration_pending and parks incompatible durable entities", () => {
    expect(
      evaluateDurableManifestState({
        metadata: { executionManifest: BASE_MANIFEST },
        migrationStatus: "migration_pending",
        runtimeManifest: BASE_MANIFEST,
        policy: POLICY,
      })
    ).toMatchObject({
      status: "migration_pending",
      canDispatch: false,
      canResume: false,
    });
    expect(
      evaluateDurableManifestState({
        metadata: { executionManifest: BASE_MANIFEST },
        migrationStatus: "completed",
        runtimeManifest: { ...BASE_MANIFEST, toolSchemaVersion: "tool-2" },
        policy: POLICY,
      })
    ).toMatchObject({
      status: "parked",
      compatibility: "incompatible",
      canDispatch: false,
      canResume: false,
    });
  });

  it("resumes compatible manifests", () => {
    expect(
      compareExecutionManifests(BASE_MANIFEST, BASE_MANIFEST, POLICY)
    ).toMatchObject({
      compatibility: "compatible",
      action: "resume",
      changedFields: [],
    });
  });

  it("requires migration for policy-approved version differences", () => {
    const current = { ...BASE_MANIFEST, promptVersion: "prompt-2" };

    expect(
      compareExecutionManifests(BASE_MANIFEST, current, POLICY)
    ).toMatchObject({
      compatibility: "migratable",
      action: "migrate_then_resume",
      changedFields: ["promptVersion"],
    });
  });

  it("parks or pins the old environment for incompatible differences", () => {
    const current = { ...BASE_MANIFEST, toolSchemaVersion: "tool-2" };

    expect(
      compareExecutionManifests(BASE_MANIFEST, current, POLICY)
    ).toMatchObject({
      compatibility: "incompatible",
      action: "pin_old_environment_or_park",
      changedFields: ["toolSchemaVersion"],
    });
  });

  it("treats an omitted optional field as not applicable for that run", () => {
    const current = {
      ...BASE_MANIFEST,
      domainSchemaVersion: "domain-2",
    };

    expect(
      compareExecutionManifests(BASE_MANIFEST, current, POLICY)
    ).toMatchObject({
      compatibility: "compatible",
      changedFields: [],
      notApplicableFields: ["domainSchemaVersion"],
    });
  });

  it("records and runtime-validates the manifest in durable metadata", () => {
    const metadata = attachExecutionManifest(
      { tenantId: "tenant-1" },
      BASE_MANIFEST
    );

    expect(metadata).toEqual({
      tenantId: "tenant-1",
      executionManifest: BASE_MANIFEST,
    });
    expect(readExecutionManifest(metadata)).toEqual(BASE_MANIFEST);
    expect(() =>
      readExecutionManifest({ executionManifest: { graphVersion: "only" } })
    ).toThrow();
  });

  it("never authorizes blind replay of a write after migration or unknown effect", () => {
    const migratable = compareExecutionManifests(
      BASE_MANIFEST,
      { ...BASE_MANIFEST, promptVersion: "prompt-2" },
      POLICY
    );
    expect(
      createManifestResumeDecision(migratable, {
        isSideEffecting: true,
        sideEffectState: "not_started",
      })
    ).toMatchObject({
      action: "migrate_then_resume",
      authorizesReplay: false,
    });
    expect(
      createManifestResumeDecision(
        compareExecutionManifests(BASE_MANIFEST, BASE_MANIFEST, POLICY),
        { isSideEffecting: true, sideEffectState: "unknown" }
      )
    ).toMatchObject({
      action: "reconciliation_required",
      authorizesReplay: false,
    });
  });
});

describe("ExecutionManifest deployment migration hook", () => {
  it("rebuilds a missing manifest from trusted ledger evidence", async () => {
    const attached: string[] = [];
    const result = await runExecutionManifestDeploymentHook(
      {
        policyVersion: "manifest-backfill/v1",
        maxDurationMs: 1_000,
        now: () => 0,
      },
      {
        async listMissingManifestEntities() {
          return [
            {
              entityType: "run",
              entityId: "run-1",
              trustedLedger: BASE_MANIFEST,
            },
          ];
        },
        async markMigrationPending() {},
        async attachManifest(entity, manifest) {
          attached.push(`${entity.entityType}:${entity.entityId}:${manifest.runtimeBuildId}`);
        },
        async parkIncompatible() {
          throw new Error("unexpected park");
        },
      }
    );

    expect(result).toEqual({
      status: "completed",
      policyVersion: "manifest-backfill/v1",
      migrated: 1,
      parked: 0,
    });
    expect(attached).toEqual(["run:run-1:build-1"]);
  });

  it("parks insufficient ledger evidence instead of resuming with empty values", async () => {
    const parked: string[] = [];
    const result = await runExecutionManifestDeploymentHook(
      {
        policyVersion: "manifest-backfill/v1",
        maxDurationMs: 1_000,
        now: () => 0,
      },
      {
        async listMissingManifestEntities() {
          return [
            { entityType: "task", entityId: "task-1", trustedLedger: {} },
          ];
        },
        async markMigrationPending() {},
        async attachManifest() {
          throw new Error("unexpected attach");
        },
        async parkIncompatible(entity) {
          parked.push(entity.entityId);
        },
      }
    );

    expect(result).toMatchObject({ status: "completed", migrated: 0, parked: 1 });
    expect(parked).toEqual(["task-1"]);
  });

  it("stops when the versioned backfill deadline is exceeded", async () => {
    let currentTime = 0;
    const result = await runExecutionManifestDeploymentHook(
      {
        policyVersion: "manifest-backfill/v1",
        maxDurationMs: 10,
        now: () => currentTime,
      },
      {
        async listMissingManifestEntities() {
          return [
            { entityType: "run", entityId: "run-1", trustedLedger: BASE_MANIFEST },
            { entityType: "run", entityId: "run-2", trustedLedger: BASE_MANIFEST },
          ];
        },
        async markMigrationPending() {},
        async attachManifest() {
          currentTime = 11;
        },
        async parkIncompatible() {},
      }
    );

    expect(result).toEqual({
      status: "timed_out",
      policyVersion: "manifest-backfill/v1",
      migrated: 1,
      parked: 0,
      remaining: 1,
    });
  });
});
