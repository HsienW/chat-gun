import assert from "node:assert/strict";
import fsPromises, { access, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";

import {
  captureQwenReviewResult,
  extractJsonObjectFromOutput,
  validateReviewResult,
} from "./qwen-capture-adapter.mjs";

// Independent validator for the repository's canonical contracts.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const Ajv = requireBackend("ajv/dist/2020.js").default;
const ajv = new Ajv({ strict: false, allErrors: true });
requireBackend("ajv-formats")(ajv);
const contractRoot = new URL("../openspec/changes/archive/2026-06-29-add-agent-artifact-shared-state-handoff/specs/", import.meta.url);
const contractValidators = {};
for (const name of ["current-state", "handoff", "agent-result"]) {
  contractValidators[name] = ajv.compile(JSON.parse(await readFile(
    new URL(`${name}-contract/${name}.schema.json`, contractRoot), "utf8",
  )));
}

async function captureFixture(t, stage = "review-plan") {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "qwen-contract-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const review = validReviewResult({ changeId: "contract-test", runId: "run-contract", stage });
  const state = {
    schemaVersion: "1.0.0", changeId: review.changeId, runId: review.runId,
    currentPhase: stage === "review-plan" ? "PLAN_REVIEW" : "REVIEWING", currentOwner: "Qwen",
    attempt: 1, latestArtifactRefs: {},
    latestHandoff: { handoffId: "input", stage, from: "CCR", to: "Qwen", status: "PENDING" },
    gateStatus: { proposalApproved: false, reviewPassed: false, implementationVerified: false, readinessConfirmed: false },
    blockers: [], nextActions: [], updatedAt: review.createdAt, terminalStatus: "NON_TERMINAL",
  };
  const statePath = path.join(workspaceRoot, ".agent-runtime", review.changeId, "current-state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  return { workspaceRoot, state, statePath, review, capture: () => captureQwenReviewResult({
    workspaceRoot, changeId: review.changeId, runId: review.runId, stage,
    processResult: { exitCode: 0, stdout: JSON.stringify(review), stderr: "" },
  }) };
}

for (const stage of ["review-plan", "review-result"]) {
  for (const verdict of ["APPROVE", "COMMENT_ONLY", "REQUEST_CHANGES", "INCOMPLETE"]) {
    test(`${stage}/${verdict} publishes canonical state and a matching physical handoff`, async (t) => {
      const f = await captureFixture(t, stage);
      f.review.payload.verdict = verdict;
      if (verdict === "REQUEST_CHANGES") f.review.payload.findings.major.push({ id: "major-1", description: "Needs correction" });
      await f.capture();
      const state = JSON.parse(await readFile(f.statePath, "utf8"));
      assert.ok(contractValidators["current-state"](state), JSON.stringify(contractValidators["current-state"].errors));
      const ref = state.latestArtifactRefs.handoff;
      assert.ok(ref, "physical handoff must be referenced");
      const handoff = JSON.parse(await readFile(path.join(f.workspaceRoot, ref.relativePath), "utf8"));
      assert.ok(contractValidators.handoff(handoff), JSON.stringify(contractValidators.handoff.errors));
      assert.equal(ref.artifactId, handoff.handoffId);
      assert.equal(handoff.changeId, state.changeId);
      assert.equal(handoff.runId, state.runId);
      for (const key of ["handoffId", "stage", "from", "to", "status"]) assert.equal(state.latestHandoff[key], handoff[key]);
      assert.ok(handoff.requiredInputRefs.some(r => r.artifactId === f.review.artifactId));
      for (const input of handoff.requiredInputRefs) await access(path.join(f.workspaceRoot, input.relativePath));
      assert.equal(state.gateStatus.proposalApproved, false, "capture must not grant coordinator approval");
    });
  }
}

for (const mutation of [
  state => { state.latestHandoff.reason = "not allowed in reference"; },
  state => { state.gateStatus.reviewPassed = "yes"; },
  state => { state.attempt = 1.5; },
]) {
  test("malformed nested state is rejected without writing artifacts", async (t) => {
    const f = await captureFixture(t);
    mutation(f.state);
    const before = JSON.stringify(f.state);
    await writeFile(f.statePath, before);
    await assert.rejects(f.capture);
    assert.equal(await readFile(f.statePath, "utf8"), before);
    await assert.rejects(access(path.join(path.dirname(f.statePath), "artifacts")), /ENOENT/);
  });
}

test("invalid review envelope is rejected before overwriting existing artifacts", async (t) => {
  const f = await captureFixture(t);
  f.review.verification.passed.push({ invalid: "not a string" });
  const artifact = path.join(path.dirname(f.statePath), "artifacts", "review-result.json");
  await mkdir(path.dirname(artifact));
  await writeFile(artifact, "original");
  await assert.rejects(f.capture);
  assert.equal(await readFile(artifact, "utf8"), "original");
});

test("missing or unsafe handoff inputs do not publish state", async (t) => {
  const f = await captureFixture(t);
  for (const relativePath of [".agent-runtime/contract-test/artifacts/missing.json", "../outside.json"]) {
    f.review.inputRefs = [{ artifactId: "missing", changeId: f.review.changeId, runId: f.review.runId, kind: "evidence", relativePath }];
    await assert.rejects(f.capture);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  }
});

test("unapproved owner or phase cannot be advanced by capture", async (t) => {
  const f = await captureFixture(t);
  for (const patch of [{ currentOwner: "CCR" }, { currentPhase: "INCOMPLETE" }]) {
    const before = JSON.stringify({ ...f.state, ...patch });
    await writeFile(f.statePath, before);
    await assert.rejects(f.capture, /review owner\/phase/);
    assert.equal(await readFile(f.statePath, "utf8"), before);
  }
});

test("state publication failure restores both prior artifacts and removes staging files", async (t) => {
  const f = await captureFixture(t);
  const artifactsDir = path.join(path.dirname(f.statePath), "artifacts");
  await mkdir(artifactsDir);
  const reviewPath = path.join(artifactsDir, "review-result.json");
  const handoffPath = path.join(artifactsDir, "review-handoff.json");
  await writeFile(reviewPath, "previous review");
  await writeFile(handoffPath, "previous handoff");
  const rename = fsPromises.rename;
  let injected = false;
  const mocked = t.mock.method(fsPromises, "rename", async (source, destination) => {
    if (destination === f.statePath && !injected) {
      injected = true;
      throw new Error("injected publication failure");
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.capture, /injected publication failure/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  assert.equal(await readFile(reviewPath, "utf8"), "previous review");
  assert.equal(await readFile(handoffPath, "utf8"), "previous handoff");
  assert.deepEqual((await readdir(artifactsDir)).sort(), ["review-handoff.json", "review-result.json"]);
  assert.ok(!(await readdir(path.dirname(f.statePath))).some(file => file.endsWith(".tmp")));
});

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
    assert.ok(updatedState.blockers.every((b) => b.severity === "Blocker"));
    assert.ok(updatedState.blockers.some((b) => b.source.includes(":major:")));
    const preservedReview = JSON.parse(await readFile(path.join(path.dirname(currentStatePath), "artifacts", "review-result.json"), "utf8"));
    assert.equal(preservedReview.payload.findings.major[0].severity, "Major");
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
    assert.equal(updatedState.blockers[0].severity, "Blocker");
    assert.ok(updatedState.blockers[0].source.includes(":major:"));
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
