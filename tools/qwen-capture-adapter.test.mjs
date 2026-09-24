import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  captureQwenReviewResult,
  extractJsonObjectFromOutput,
  validateReviewResult,
} from "./qwen-capture-adapter.mjs";

function validReviewResult(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    artifactId: "rr-test-001",
    changeId: "add-agent-artifact-shared-state-handoff",
    runId: "run-2026-06-29-001",
    producer: "Qwen",
    stage: "review-result",
    kind: "review_result",
    status: "success",
    createdAt: "2026-06-29T12:00:00.000Z",
    summary: "No confirmed findings.",
    inputRefs: [],
    outputRefs: [],
    verification: {
      executed: [],
      passed: [],
      failed: [],
      notExecuted: ["lint", "test", "build"],
    },
    payload: {
      verdict: "APPROVE",
      findings: {
        blocker: [],
        major: [],
        minor: [],
      },
      crossLayerContractCheck: {},
      residualRisks: [],
      positiveNotes: [],
    },
    risks: [],
    ...overrides,
  };
}

test("extractJsonObjectFromOutput extracts fenced JSON from Qwen markdown", () => {
  const result = validReviewResult();
  const output = [
    "# Review Result",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
  ].join("\n");

  assert.deepEqual(extractJsonObjectFromOutput(output), result);
});

test("extractJsonObjectFromOutput extracts raw JSON stdout", () => {
  const result = validReviewResult();

  assert.deepEqual(extractJsonObjectFromOutput(JSON.stringify(result)), result);
});

test("extractJsonObjectFromOutput tolerates a leading UTF-8 BOM", () => {
  const result = validReviewResult();

  assert.deepEqual(extractJsonObjectFromOutput(`\uFEFF${JSON.stringify(result)}`), result);
});

test("validateReviewResult rejects wrong change, run, stage, and kind", () => {
  const base = validReviewResult();

  assert.throws(
    () =>
      validateReviewResult(
        { ...base, changeId: "other-change" },
        {
          expectedChangeId: base.changeId,
          expectedRunId: base.runId,
          expectedStage: base.stage,
          expectedKind: base.kind,
        },
      ),
    /changeId/,
  );

  assert.throws(
    () =>
      validateReviewResult(
        { ...base, runId: "other-run" },
        {
          expectedChangeId: base.changeId,
          expectedRunId: base.runId,
          expectedStage: base.stage,
          expectedKind: base.kind,
        },
      ),
    /runId/,
  );

  assert.throws(
    () =>
      validateReviewResult(
        { ...base, stage: "review-plan" },
        {
          expectedChangeId: base.changeId,
          expectedRunId: base.runId,
          expectedStage: base.stage,
          expectedKind: base.kind,
        },
      ),
    /stage/,
  );

  assert.throws(
    () =>
      validateReviewResult(
        { ...base, kind: "implementation_result" },
        {
          expectedChangeId: base.changeId,
          expectedRunId: base.runId,
          expectedStage: base.stage,
          expectedKind: base.kind,
        },
      ),
    /kind/,
  );
});

test("validateReviewResult accepts compatible schema minor versions", () => {
  const base = validReviewResult({ schemaVersion: "1.1.0" });

  assert.equal(
    validateReviewResult(base, {
      expectedChangeId: base.changeId,
      expectedRunId: base.runId,
      expectedStage: base.stage,
      expectedKind: base.kind,
    }),
    base,
  );
});

test("validateReviewResult rejects incompatible schema major versions", () => {
  const base = validReviewResult({ schemaVersion: "2.0.0" });

  assert.throws(
    () =>
      validateReviewResult(base, {
        expectedChangeId: base.changeId,
        expectedRunId: base.runId,
        expectedStage: base.stage,
        expectedKind: base.kind,
      }),
    /schemaVersion/,
  );
});

test("captureQwenReviewResult rejects non-zero process exit before writing artifact", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-a";
  const runId = "run-a";
  const runtimeDir = path.join(workspaceRoot, ".agent-runtime", changeId);
  const statePath = path.join(runtimeDir, "current-state.json");
  const artifactPath = path.join(runtimeDir, "artifacts", "review-result.json");

  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        changeId,
        runId,
        currentPhase: "REVIEWING",
        currentOwner: "Qwen",
        latestArtifactRefs: {},
      }),
    );

    await assert.rejects(
      () =>
        captureQwenReviewResult({
          workspaceRoot,
          changeId,
          runId,
          stage: "review-result",
          processResult: {
            exitCode: 2,
            stdout: JSON.stringify(validReviewResult({ changeId, runId })),
            stderr: "qwen failed",
          },
        }),
      /Qwen CLI exited with code 2/,
    );

    await assert.rejects(() => access(artifactPath), /ENOENT/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult writes review-result atomically and updates current-state", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-a";
  const runId = "run-a";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "REVIEWING",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-a",
      stage: "review-result",
      from: "Codex",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: true,
      reviewPassed: false,
      implementationVerified: true,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-06-29T12:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), {
    encoding: "utf8",
  });

  try {
    const result = validReviewResult({
      artifactId: "rr-a",
      changeId,
      runId,
    });

    const captured = await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-result",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-06-29T13:00:00.000Z"),
    });

    assert.equal(
      captured.artifactPath,
      path.join(workspaceRoot, ".agent-runtime", changeId, "artifacts", "review-result.json"),
    );

    const writtenArtifact = JSON.parse(await readFile(captured.artifactPath, "utf8"));
    assert.deepEqual(writtenArtifact, result);

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.deepEqual(updatedState.latestArtifactRefs.reviewResult, {
      artifactId: "rr-a",
      changeId,
      runId,
      kind: "review_result",
      relativePath: ".agent-runtime/change-a/artifacts/review-result.json",
    });
    assert.equal(updatedState.updatedAt, "2026-06-29T13:00:00.000Z");
    // APPROVE verdict transitions
    assert.equal(updatedState.currentPhase, "READY_FOR_READINESS_CHECK");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, true);
    assert.equal(updatedState.latestHandoff.status, "COMPLETED");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult captures stdout from a live child process", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-live";
  const runId = "run-live";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const result = validReviewResult({
    artifactId: "rr-live",
    changeId,
    runId,
  });

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(
    currentStatePath,
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        changeId,
        runId,
        currentPhase: "REVIEWING",
        currentOwner: "Qwen",
        attempt: 1,
        latestArtifactRefs: {},
        latestHandoff: {
          handoffId: "hdo-live",
          stage: "review-result",
          from: "Codex",
          to: "Qwen",
          status: "PENDING",
        },
        gateStatus: {
          proposalApproved: true,
          reviewPassed: false,
          implementationVerified: true,
          readinessConfirmed: false,
        },
        blockers: [],
        nextActions: [],
        updatedAt: "2026-06-29T12:00:00.000Z",
        terminalStatus: "NON_TERMINAL",
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    const captured = await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-result",
      command: process.execPath,
      commandArgs: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`],
      now: () => new Date("2026-06-29T13:00:00.000Z"),
    });

    const writtenArtifact = JSON.parse(await readFile(captured.artifactPath, "utf8"));
    assert.equal(writtenArtifact.artifactId, "rr-live");
    assert.equal(writtenArtifact.producer, "Qwen");

    // Verify state transitions were written to current-state
    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "READY_FOR_READINESS_CHECK");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult transitions to READY_FOR_READINESS_CHECK on APPROVE verdict", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-approve";
  const runId = "run-approve";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "REVIEWING",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-approve",
      stage: "review-result",
      from: "Codex",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: true,
      reviewPassed: false,
      implementationVerified: true,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-07-02T10:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({
      artifactId: "rr-approve",
      changeId,
      runId,
      payload: {
        verdict: "APPROVE",
        findings: { blocker: [], major: [], minor: [] },
        crossLayerContractCheck: {},
        residualRisks: [],
        positiveNotes: [],
      },
    });

    await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-result",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-07-02T11:00:00.000Z"),
    });

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "READY_FOR_READINESS_CHECK");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, true);
    assert.equal(updatedState.latestHandoff.status, "COMPLETED");
    assert.equal(updatedState.updatedAt, "2026-07-02T11:00:00.000Z");
    assert.deepEqual(updatedState.latestArtifactRefs.reviewResult, {
      artifactId: "rr-approve",
      changeId,
      runId,
      kind: "review_result",
      relativePath: ".agent-runtime/change-approve/artifacts/review-result.json",
    });
    assert.ok(updatedState.nextActions.some((a) => a.includes("CCR 執行 readiness check")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult transitions to CHANGES_REQUESTED on REQUEST_CHANGES verdict", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-rc";
  const runId = "run-rc";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "REVIEWING",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-rc",
      stage: "review-result",
      from: "Codex",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: true,
      reviewPassed: false,
      implementationVerified: true,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-07-02T10:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({
      artifactId: "rr-rc",
      changeId,
      runId,
      payload: {
        verdict: "REQUEST_CHANGES",
        findings: {
          blocker: [{ id: "b1", title: "Cross-layer contract broken", description: "Cross-layer contract broken", severity: "Blocker" }],
          major: [{ id: "m1", title: "Missing error handling", description: "Missing error handling", severity: "Major" }],
          minor: [],
        },
        crossLayerContractCheck: {},
        residualRisks: [],
        positiveNotes: [],
      },
    });

    await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-result",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-07-02T11:00:00.000Z"),
    });

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "CHANGES_REQUESTED");
    assert.equal(updatedState.currentOwner, "Codex");
    assert.equal(updatedState.gateStatus.reviewPassed, false);
    assert.equal(updatedState.latestHandoff.stage, "fix-from-review");
    assert.equal(updatedState.latestHandoff.from, "Qwen");
    assert.equal(updatedState.latestHandoff.to, "Codex");
    assert.equal(updatedState.latestHandoff.status, "PENDING");
    assert.equal(updatedState.blockers.length, 2);
    assert.ok(updatedState.blockers.some((b) => b.description === "Cross-layer contract broken"));
    assert.ok(updatedState.blockers.some((b) => b.description === "Missing error handling"));
    assert.ok(updatedState.blockers.every((b) => b.severity !== "Blocker" || b.source.includes(":blocker:")));
    assert.ok(updatedState.nextActions.some((a) => a.includes("Codex 修正")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult transitions to INCOMPLETE on INCOMPLETE verdict", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-inc";
  const runId = "run-inc";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "REVIEWING",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-inc",
      stage: "review-result",
      from: "Codex",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: true,
      reviewPassed: false,
      implementationVerified: true,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-07-02T10:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({
      artifactId: "rr-inc",
      changeId,
      runId,
      payload: {
        verdict: "INCOMPLETE",
        findings: { blocker: [], major: [], minor: [] },
        crossLayerContractCheck: {},
        residualRisks: [],
        positiveNotes: [],
      },
    });

    await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-result",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-07-02T11:00:00.000Z"),
    });

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "INCOMPLETE");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, false);
    assert.equal(updatedState.latestHandoff.status, "FAILED");
    assert.ok(updatedState.nextActions.some((a) => a.includes("INCOMPLETE")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult review-plan REQUEST_CHANGES transitions to PLAN_DRAFT/CCR", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-rp-rc";
  const runId = "run-rp-rc";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "PLAN_REVIEW",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-rp-rc",
      stage: "review-plan",
      from: "CCR",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: false,
      reviewPassed: false,
      implementationVerified: false,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-09-24T05:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({
      artifactId: "rr-rp-rc",
      changeId,
      runId,
      stage: "review-plan",
      payload: {
        verdict: "REQUEST_CHANGES",
        findings: {
          blocker: [],
          major: [{ id: "m1", title: "Fallback mechanism missing", description: "Fallback mechanism missing", severity: "Major" }],
          minor: [],
        },
        crossLayerContractCheck: {},
        residualRisks: [],
        positiveNotes: [],
      },
    });

    await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-plan",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-09-24T06:00:00.000Z"),
    });

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "PLAN_DRAFT");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, false);
    assert.equal(updatedState.latestHandoff.stage, "plan-draft");
    assert.equal(updatedState.latestHandoff.from, "Qwen");
    assert.equal(updatedState.latestHandoff.to, "CCR");
    assert.equal(updatedState.latestHandoff.status, "PENDING");
    assert.equal(updatedState.blockers.length, 1);
    assert.equal(updatedState.blockers[0].severity, "Major");
    assert.ok(updatedState.nextActions.some((a) => a.includes("CCR")));
    assert.ok(updatedState.nextActions.some((a) => a.includes("PLAN_DRAFT")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult review-plan APPROVE transitions to PLAN_APPROVED/CCR", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-rp-ap";
  const runId = "run-rp-ap";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");
  const currentState = {
    schemaVersion: "1.0.0",
    changeId,
    runId,
    currentPhase: "PLAN_REVIEW",
    currentOwner: "Qwen",
    attempt: 1,
    latestArtifactRefs: {},
    latestHandoff: {
      handoffId: "hdo-rp-ap",
      stage: "review-plan",
      from: "CCR",
      to: "Qwen",
      status: "PENDING",
    },
    gateStatus: {
      proposalApproved: false,
      reviewPassed: false,
      implementationVerified: false,
      readinessConfirmed: false,
    },
    blockers: [],
    nextActions: [],
    updatedAt: "2026-09-24T05:00:00.000Z",
    terminalStatus: "NON_TERMINAL",
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(currentState, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({
      artifactId: "rr-rp-ap",
      changeId,
      runId,
      stage: "review-plan",
      payload: {
        verdict: "APPROVE",
        findings: { blocker: [], major: [], minor: [] },
        crossLayerContractCheck: {},
        residualRisks: [],
        positiveNotes: [],
      },
    });

    await captureQwenReviewResult({
      workspaceRoot,
      changeId,
      runId,
      stage: "review-plan",
      processResult: {
        exitCode: 0,
        stdout: JSON.stringify(result),
        stderr: "",
      },
      now: () => new Date("2026-09-24T06:00:00.000Z"),
    });

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.equal(updatedState.currentPhase, "PLAN_APPROVED");
    assert.equal(updatedState.currentOwner, "CCR");
    assert.equal(updatedState.gateStatus.reviewPassed, true);
    assert.equal(updatedState.latestHandoff.stage, "apply-change");
    assert.equal(updatedState.latestHandoff.from, "CCR");
    assert.equal(updatedState.latestHandoff.to, "Codex");
    assert.equal(updatedState.latestHandoff.status, "PENDING");
    assert.ok(updatedState.nextActions.some((a) => a.includes("apply-change")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult rejects non-canonical current-state.json", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-capture-"));
  const changeId = "change-bad";
  const runId = "run-bad";
  const currentStatePath = path.join(workspaceRoot, ".agent-runtime", changeId, "current-state.json");

  // Non-canonical: uses old coordinator_result shape (missing required top-level fields)
  const nonCanonical = {
    schemaVersion: "1.0.0",
    artifactId: "coordinator-plan-fix",
    changeId,
    runId,
    producer: "CCR",
    stage: "readiness-check",
    kind: "coordinator_result",
    status: "success",
    payload: {
      currentPhase: "readiness-check",
      currentOwner: "CCR",
      latestArtifactRefs: [],
    },
  };

  await mkdir(path.dirname(currentStatePath), { recursive: true });
  await writeFile(currentStatePath, JSON.stringify(nonCanonical, null, 2), { encoding: "utf8" });

  try {
    const result = validReviewResult({ artifactId: "rr-bad", changeId, runId });

    await assert.rejects(
      () =>
        captureQwenReviewResult({
          workspaceRoot,
          changeId,
          runId,
          stage: "review-result",
          processResult: {
            exitCode: 0,
            stdout: JSON.stringify(result),
            stderr: "",
          },
        }),
      /missing required field/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("captureQwenReviewResult rejects path traversal change ids", async () => {
  await assert.rejects(
    () =>
      captureQwenReviewResult({
        workspaceRoot: process.cwd(),
        changeId: "../escape",
        runId: "run-a",
        stage: "review-result",
        processResult: {
          exitCode: 0,
          stdout: JSON.stringify(validReviewResult({ changeId: "../escape", runId: "run-a" })),
          stderr: "",
        },
      }),
    /Invalid changeId/,
  );
});
