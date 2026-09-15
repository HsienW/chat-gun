import { describe, expect, it } from "vitest";

import {
  attachExecutionManifest,
  compareExecutionManifests,
  createManifestResumeDecision,
  readExecutionManifest,
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
