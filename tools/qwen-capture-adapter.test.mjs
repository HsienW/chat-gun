import assert from "node:assert/strict";
import fsPromises, { access, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import * as adapter from "./qwen-capture-adapter.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";

import {
  captureQwenReviewResult,
  extractJsonObjectFromOutput,
  resolveQwenCommand,
  secretCategories,
  validateReviewResult,
} from "./qwen-capture-adapter.mjs";

// Independent validator for the repository's canonical contracts.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const Ajv = requireBackend("ajv/dist/2020.js").default;
const ajv = new Ajv({ strict: false, allErrors: true });
requireBackend("ajv-formats")(ajv);
const contractRoot = new URL("../openspec/specs/", import.meta.url);
const contractValidators = {};
for (const name of ["current-state", "handoff", "agent-result"]) {
  contractValidators[name] = ajv.compile(JSON.parse(await readFile(
    new URL(`${name}-contract/${name}.schema.json`, contractRoot), "utf8",
  )));
}

// Captures pin the provider on the qwen argv; settings paths point into the temp workspace so the
// developer's real ~/.qwen and system settings never influence a test.
const PINNED_PROVIDER = Object.freeze({ authType: "openai", model: "fixture-model", baseUrl: "https://provider.fixture.test/v1" });
const PINNED_ARGS = ["--auth-type", PINNED_PROVIDER.authType, "--model", PINNED_PROVIDER.model,
  "--openai-base-url", PINNED_PROVIDER.baseUrl];
function isolatedSettings(workspaceRoot) {
  return { env: { QWEN_HOME: path.join(workspaceRoot, "qwen-home"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(workspaceRoot, "qwen-system", "settings.json") },
  homedir: path.join(workspaceRoot, "home") };
}
function pinnedLaunch(workspaceRoot, commandArgs = []) {
  return { expectedProvider: PINNED_PROVIDER, commandArgs: [...commandArgs, ...PINNED_ARGS],
    settingsEnvironment: isolatedSettings(workspaceRoot) };
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
  return { workspaceRoot, state, statePath, review, capture: (overrides = {}) => captureQwenReviewResult({
    workspaceRoot, changeId: review.changeId, runId: review.runId, stage, artifactId: review.artifactId,
    outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
    processResult: { exitCode: 0, stdout: stream(review), stderr: "", signal: null }, ...overrides,
  }) };
}

test("capture requires an explicit artifactId instead of a fixed overwrite path", async (t) => {
  const f = await captureFixture(t);
  await assert.rejects(() => f.capture({ artifactId: undefined }), /artifact.?id/i);
});

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

test("state publication failure removes every newly published artifact and staging file", async (t) => {
  const f = await captureFixture(t);
  const artifactsDir = path.join(path.dirname(f.statePath), "artifacts");
  await mkdir(artifactsDir);
  await writeFile(path.join(artifactsDir, "review-result.json"), "preserved old review");
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
  try { await assert.rejects(f.capture, /injected publication failure/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  assert.deepEqual(await readdir(artifactsDir), ["review-result.json"]);
  assert.equal(await readFile(path.join(artifactsDir, "review-result.json"), "utf8"), "preserved old review");
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

// Synthetic fixtures shaped after the Qwen 0.25.3 stream-json source (buildSystemMessage, buildMessage,
// emitToolResult, buildResultMessage). They are not a live Qwen isolation attestation.
const REVIEWER_CALL = "agent-call-1";
function reviewerMessage(type, content) {
  return { type, session_id: "parent", parent_tool_use_id: REVIEWER_CALL, message: { content } };
}
function parentMessage(type, content) {
  return { type, session_id: "parent", parent_tool_use_id: null, message: { content } };
}
function reviewerCall(id = REVIEWER_CALL, subagentType = "secondary-architecture-reviewer") {
  return parentMessage("assistant", [{ type: "tool_use", id, name: "agent", input: { subagent_type: subagentType, prompt: "review" } }]);
}
function reviewerReturn(review, id = REVIEWER_CALL) {
  return parentMessage("user", [{ type: "tool_result", tool_use_id: id, is_error: false, content: JSON.stringify(review) }]);
}
function events(review) {
  return [
    { type: "system", subtype: "init", uuid: "parent", session_id: "parent", model: "fixture-model", permission_mode: "plan",
      qwen_code_version: "0.25.3", tools: ["read_file", "grep_search", "glob", "list_directory", "skill", "agent"],
      agents: ["secondary-architecture-reviewer"] },
    reviewerCall(),
    reviewerReturn(review),
    { type: "result", subtype: "success", session_id: "parent", is_error: false, result: JSON.stringify(review) },
  ];
}
function stream(review, mutate = () => {}) {
  const rows = events(review);
  mutate(rows);
  return rows.map(row => JSON.stringify(row)).join("\n") + "\n";
}
function artifactPath(f, suffix = ".json") {
  return path.join(path.dirname(f.statePath), "artifacts", `${f.review.artifactId}${suffix}`);
}
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
async function assertEvidence(f, stdout, stderr, savedResult) {
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(evidence.kind, "evidence");
  assert.equal(evidence.hashes.stdout, sha(stdout));
  assert.equal(evidence.hashes.stderr, sha(stderr));
  assert.equal(evidence.hashes.savedResult, savedResult === null ? null : sha(savedResult));
  assert.equal(await readFile(artifactPath(f, ".stdout.ndjson"), "utf8"), stdout);
  assert.equal(await readFile(artifactPath(f, ".stderr.log"), "utf8"), stderr);
  return evidence;
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

test("extractJsonObjectFromOutput finds the review_result among quoted code blocks", () => {
  const result = validReviewResult();
  const output = [
    "# Review Result", "```js", "const a = { kind: 1 };", "```",
    "```", "not json at all", "```",
    "```json", JSON.stringify({ sample: true }), "```",
    "```json", JSON.stringify(result, null, 2), "```",
  ].join("\n");

  assert.deepEqual(extractJsonObjectFromOutput(output), result);
});

test("extractJsonObjectFromOutput refuses ambiguous or absent candidates", () => {
  const block = value => ["```json", JSON.stringify(value), "```"].join("\n");
  const twoReviews = [block(validReviewResult()), block(validReviewResult({ summary: "other" }))].join("\n");

  assert.throws(() => extractJsonObjectFromOutput(twoReviews), /Multiple JSON candidates/);
  assert.throws(() => extractJsonObjectFromOutput([block({ a: 1 }), block({ b: 2 })].join("\n")), /Multiple JSON candidates/);
  assert.throws(() => extractJsonObjectFromOutput(["```js", "const a = 1;", "```"].join("\n")), /No JSON candidate/);
  assert.throws(() => extractJsonObjectFromOutput(["```json", "{broken", "```"].join("\n")), /Invalid JSON/);
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

test("captureQwenReviewResult rejects non-zero process exit and preserves evidence", async (t) => {
  const f = await captureFixture(t);
  const stdout = stream(f.review);
  await assert.rejects(() => f.capture({ processResult: { exitCode: 2, stdout, stderr: "qwen failed", signal: null } }), /process_nonzero_exit/);
  const evidence = await assertEvidence(f, stdout, "qwen failed", null);
  assert.equal(evidence.exitCode, 2);
  await assert.rejects(access(artifactPath(f)), /ENOENT/);
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
        stderr: "",
      },
      now: () => new Date("2026-06-29T13:00:00.000Z"),
    });

    assert.equal(
      captured.artifactPath,
      path.join(workspaceRoot, ".agent-runtime", changeId, "artifacts", "rr-a.json"),
    );

    const writtenArtifact = JSON.parse(await readFile(captured.artifactPath, "utf8"));
    assert.deepEqual(writtenArtifact, result);

    const updatedState = JSON.parse(await readFile(currentStatePath, "utf8"));
    assert.deepEqual(updatedState.latestArtifactRefs.reviewResult, {
      artifactId: "rr-a",
      changeId,
      runId,
      kind: "review_result",
      relativePath: ".agent-runtime/change-a/artifacts/rr-a.json",
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

test("captureQwenReviewResult captures stdout from a local deterministic child process", async () => {
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      command: process.execPath,
      // `--` keeps node from parsing the pinned qwen flags as its own options.
      ...pinnedLaunch(workspaceRoot, ["-e", `console.log(${JSON.stringify(stream(result))})`, "--"]),
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
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
      relativePath: ".agent-runtime/change-approve/artifacts/rr-approve.json",
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
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
    const preservedReview = JSON.parse(await readFile(path.join(path.dirname(currentStatePath), "artifacts", "rr-rc.json"), "utf8"));
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
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
      artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
        exitCode: 0,
        stdout: stream(result),
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
          artifactId: result.artifactId, outputFormat: "stream-json", qwenVersion: "0.25.3-fixture", ...pinnedLaunch(workspaceRoot),
      processResult: {
            exitCode: 0,
            stdout: stream(result),
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
        artifactId: "rr-traversal",
        runId: "run-a",
        stage: "review-result",
        outputFormat: "text", qwenVersion: "0.25.3-fixture",
      processResult: {
          exitCode: 0,
          stdout: JSON.stringify(validReviewResult({ changeId: "../escape", runId: "run-a" })),
          stderr: "",
        },
      }),
    /Invalid changeId/,
  );
});

for (const artifactId of ["", "../escape", "Uppercase", "a/b", "a\\b", "C:\\absolute", "/absolute", "a..b", "has space"]) {
  test(`rejects unsafe artifact ID ${JSON.stringify(artifactId)}`, async (t) => {
    const f = await captureFixture(t);
    await assert.rejects(() => f.capture({ artifactId }), /artifact.?id/i);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  });
}

test("rejects mismatched requested and review artifact IDs", async (t) => {
  const f = await captureFixture(t);
  await assert.rejects(() => f.capture({ artifactId: "different-id" }), /artifact.?id/i);
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
});

for (const collision of ["file", "reference"]) {
  test(`existing ${collision} refuses a fresh capture and preserves review022`, async (t) => {
    const f = await captureFixture(t);
    const artifacts = path.join(path.dirname(f.statePath), "artifacts");
    await mkdir(artifacts);
    const old = path.join(artifacts, "review-result.json");
    await writeFile(old, "immutable review022");
    const before = sha(await readFile(old));
    if (collision === "file") await writeFile(artifactPath(f), "already exists");
    else {
      f.review.artifactId = "review-plan-022-qwen-20261022";
      f.state.latestArtifactRefs.reviewResult = { artifactId: f.review.artifactId, changeId: f.review.changeId,
        runId: f.review.runId, kind: "review_result", relativePath: `.agent-runtime/${f.review.changeId}/artifacts/review-result.json` };
      await writeFile(f.statePath, JSON.stringify(f.state));
    }
    await assert.rejects(f.capture, /exist|collision|referenc|already/i);
    assert.equal(sha(await readFile(old)), before);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  });
}

test("stream-json extracts the sole final result and counts unknown events", () => {
  const review = validReviewResult();
  const parsed = adapter.parseCaptureOutput(stream(review, rows => rows.splice(1, 0, { type: "future_event" })), "stream-json");
  assert.deepEqual(parsed.reviewResult, review);
  assert.equal(parsed.observed.unknownEventCount, 1);
  assert.equal(parsed.observed.parentSessionId, "parent");
  assert.equal(parsed.observed.model, "fixture-model");
  assert.equal(parsed.observed.approvalMode, "plan");
  assert.equal(parsed.observed.provider, null);
  assert.ok(parsed.observed.notObserved.includes("provider"));
});

test("the reviewer agent tool_result is the authoritative review and init metadata is captured", () => {
  const review = validReviewResult();
  const parsed = adapter.parseCaptureOutput(stream(review), "stream-json");
  assert.deepEqual(parsed.reviewResult, review);
  assert.deepEqual(parsed.reviewSource, { toolUseId: REVIEWER_CALL, owner: "subagent" });
  assert.deepEqual(parsed.observed.subagents, [{ name: "secondary-architecture-reviewer", toolUseId: REVIEWER_CALL }]);
  assert.equal(parsed.observed.qwenCodeVersion, "0.25.3");
  assert.ok(parsed.observed.effectiveTools.includes("read_file"));
});

test("a reviewer tool_result given as text blocks is accepted", () => {
  const review = validReviewResult();
  const parsed = adapter.parseCaptureOutput(stream(review, rows => {
    rows[2].message.content[0].content = [{ type: "text", text: JSON.stringify(review) }];
  }), "stream-json");
  assert.equal(parsed.reviewSource.owner, "subagent");
});

test("the superseded synthetic subagent_start format cannot establish reviewer provenance", async (t) => {
  const f = await captureFixture(t);
  const legacy = [
    { type: "system", subtype: "init", session_id: "parent", model: "fixture-model", permission_mode: "plan" },
    { type: "system", subtype: "subagent_start", agent_id: "reviewer-1", agent_name: "secondary-architecture-reviewer", parent_session_id: "parent", session_id: "child" },
    { type: "result", agent_id: "reviewer-1", session_id: "child", result: JSON.stringify(f.review) },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await f.capture({ processResult: { exitCode: 0, stdout: legacy, stderr: "" } });
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(state.currentPhase, "INCOMPLETE");
  assert.ok(evidence.evidenceGate.reasons.includes("reviewer_provenance_not_observed"));
});

for (const [name, makeOutput] of [
  ["a parent copy differs from the reviewer tool_result", review => stream(review, rows => {
    rows.at(-1).result = JSON.stringify({ ...review, summary: "Parent rewrote the review." });
  })],
  ["two reviewer tool_results carry reviews", review => stream(review, rows => {
    rows.splice(3, 0, reviewerCall("agent-call-2"), reviewerReturn(review, "agent-call-2"));
  })],
]) {
  test(`capture fails closed when ${name}`, async (t) => {
    const f = await captureFixture(t);
    const stdout = makeOutput(f.review);
    await assert.rejects(() => f.capture({ processResult: { exitCode: 0, stdout, stderr: "" } }));
    const evidence = await assertEvidence(f, stdout, "", null);
    assert.equal(evidence.evidenceGate.passed, false);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
    await assert.rejects(access(artifactPath(f)), /ENOENT/);
  });
}

for (const [name, makeOutput] of [
  ["zero candidates", () => JSON.stringify({ type: "system", subtype: "init" })],
  ["multiple candidates", review => stream(review, rows => rows.push(rows.at(-1)))],
  ["malformed line", review => stream(review) + "{broken\n"],
  ["non-result embedded review", review => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(review) }] } })],
]) {
  test(`stream-json fails closed for ${name} and retains raw evidence`, async (t) => {
    const f = await captureFixture(t);
    const stdout = makeOutput(f.review);
    await assert.rejects(() => f.capture({ processResult: { exitCode: 0, stdout, stderr: "" } }));
    const evidence = await assertEvidence(f, stdout, "", null);
    assert.equal(evidence.evidenceGate.passed, false);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
    await assert.rejects(access(artifactPath(f)), /ENOENT/);
  });
}

test("json event arrays and final result structured_result are supported", () => {
  const review = validReviewResult();
  const rows = events(review);
  rows.at(-1).structured_result = review;
  assert.deepEqual(adapter.parseCaptureOutput(JSON.stringify(rows), "json").reviewResult, review);
});

test("structured_output tool call is a review candidate", () => {
  const review = validReviewResult();
  const rows = events(review).slice(0, 2);
  rows.push(parentMessage("assistant", [{ type: "tool_use", id: "structured-1", name: "structured_output", input: review }]));
  assert.deepEqual(adapter.parseCaptureOutput(rows.map(row => JSON.stringify(row)).join("\n"), "stream-json").reviewResult, review);
});

test("tool observations contain ownership and status but never tool input content", () => {
  const review = validReviewResult();
  const stdout = stream(review, rows => rows.splice(2, 0,
    reviewerMessage("assistant", [{ type: "tool_use", id: "read-1", name: "read_file", input: { file: "do-not-copy-tool-input" } }]),
    reviewerMessage("user", [{ type: "tool_result", tool_use_id: "read-1", content: "do-not-copy-tool-result" }]),
  ));
  const { observed } = adapter.parseCaptureOutput(stdout, "stream-json");
  const tool = observed.tools.find(item => item.id === "read-1");
  assert.equal(tool.name, "read_file");
  assert.equal(tool.owner, "subagent");
  assert.equal(tool.status, "completed");
  assert.ok(!JSON.stringify(observed).includes("do-not-copy"));
});

test("successful capture publishes raw hashes and canonical evidence references", async (t) => {
  const f = await captureFixture(t);
  const captured = await f.capture();
  const evidence = await assertEvidence(f, stream(f.review), "", await readFile(artifactPath(f)));
  assert.equal(captured.capturePath, artifactPath(f, ".capture.json"));
  assert.equal(evidence.evidenceGate.passed, true);
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.signal, null);
  assert.ok(evidence.startedAt);
  assert.ok(evidence.endedAt);
  assert.ok(!path.isAbsolute(evidence.cwd));
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  for (const name of ["reviewCapture", "reviewRawStdout", "reviewRawStderr"]) {
    assert.equal(state.latestArtifactRefs[name].kind, "evidence");
    await access(path.join(f.workspaceRoot, state.latestArtifactRefs[name].relativePath));
  }
});

test("capture metadata redacts secret flag values in split and equals argv", async (t) => {
  const f = await captureFixture(t);
  await f.capture({ commandArgs: ["--openai-api-key", "dummy-sensitive-value", "--token=another-sensitive-value", "--password", "third-sensitive-value", "--approval-mode", "plan"] });
  const text = await readFile(artifactPath(f, ".capture.json"), "utf8");
  for (const value of ["dummy-sensitive-value", "another-sensitive-value", "third-sensitive-value"]) assert.ok(!text.includes(value));
  assert.ok(text.includes("--approval-mode"));
});

for (const [name, mutate] of [
  ["parent not in plan", rows => { rows[0].permission_mode = "default"; }],
  ["no subagent", rows => { rows.splice(1, 2); }],
  ["model absent", rows => { delete rows[0].model; }],
  ["wrong reviewer", rows => { rows[1].message.content[0].input.subagent_type = "different-reviewer"; }],
  ["a second reviewer call is made", rows => { rows.splice(2, 0, reviewerCall("agent-call-2")); }],
  ["another subagent runs", rows => { rows.splice(2, 0, reviewerCall("agent-call-2", "general-purpose")); }],
  ["the reviewer call fails", rows => { rows[2].message.content[0].is_error = true; }],
  ["the reviewer tool_result is missing", rows => { rows.splice(2, 1); }],
  ...["write_file", "edit", "run_shell_command", "Bash"].flatMap(name => ["parent", "subagent"].map(owner => [
    `${owner} invokes ${name}`, rows => { rows.splice(2, 0, (owner === "parent" ? parentMessage : reviewerMessage)(
      "assistant", [{ type: "tool_use", id: "unsafe-tool", name, input: {} }])); },
  ])),
]) {
  test(`evidence gate prevents verdict advancement when ${name}`, async (t) => {
    const f = await captureFixture(t);
    await f.capture({ processResult: { exitCode: 0, stdout: stream(f.review, mutate), stderr: "" } });
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
    assert.equal(state.currentPhase, "INCOMPLETE");
    assert.equal(state.currentOwner, "CCR");
    assert.equal(state.gateStatus.reviewPassed, false);
    assert.equal(evidence.evidenceGate.passed, false);
    assert.ok(evidence.evidenceGate.reasons.length > 0);
    assert.equal(JSON.parse(await readFile(artifactPath(f), "utf8")).payload.verdict, "APPROVE");
    assert.ok(contractValidators["current-state"](state));
  });
}

function skillLoad(id, skill, result = { type: "tool_result", tool_use_id: id, content: "loaded" }) {
  return [
    reviewerMessage("assistant", [{ type: "tool_use", id, name: "skill", input: { skill } }]),
    ...(result ? [reviewerMessage("user", [result])] : []),
  ];
}

test("loading the reviewer contract skills keeps the evidence gate open", async (t) => {
  const f = await captureFixture(t);
  await f.capture({ processResult: { exitCode: 0, stdout: stream(f.review, rows => rows.splice(2, 0,
    ...skillLoad("skill-1", "openspec-workflow-router"),
    ...skillLoad("skill-2", "secondary-architecture-reviewer"),
  )), stderr: "" } });
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(evidence.evidenceGate.passed, true);
  const skills = evidence.observed.tools.filter(tool => tool.name === "skill");
  assert.deepEqual(skills.map(tool => tool.skillName), ["openspec-workflow-router", "secondary-architecture-reviewer"]);
  assert.ok(skills.every(tool => tool.owner === "subagent" && tool.status === "completed"));
});

for (const [name, rows] of [
  ["an unlisted skill is loaded", skillLoad("skill-x", "deploy-to-production")],
  ["a skill load has no tool_result", skillLoad("skill-1", "openspec-workflow-router", null)],
  ["a skill load fails", skillLoad("skill-1", "openspec-workflow-router", { type: "tool_result", tool_use_id: "skill-1", is_error: true, content: "x" })],
  ["a skill call omits its name", skillLoad("skill-1", undefined)],
]) {
  test(`evidence gate stays closed when ${name}`, async (t) => {
    const f = await captureFixture(t);
    await f.capture({ processResult: { exitCode: 0, stdout: stream(f.review, items => items.splice(2, 0, ...rows)), stderr: "" } });
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
    assert.equal(state.currentPhase, "INCOMPLETE");
    assert.equal(evidence.evidenceGate.passed, false);
    assert.ok(evidence.evidenceGate.reasons.includes("tool_readonly_not_proven"));
  });
}

test("reviewer skill allowlist matches the reviewer agent contract", async () => {
  const contract = await readFile(new URL("../.qwen/agents/secondary-architecture-reviewer.md", import.meta.url), "utf8");
  for (const skill of adapter.REVIEWER_SKILL_NAMES) assert.ok(contract.includes(`\`${skill}\``), skill);
});

test("text output cannot infer isolation or model evidence from CLI flags", async (t) => {
  const f = await captureFixture(t);
  await f.capture({ outputFormat: "text", commandArgs: ["--approval-mode", "plan", "--model", "claimed-model"],
    processResult: { exitCode: 0, stdout: JSON.stringify(f.review), stderr: "" } });
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(state.currentPhase, "INCOMPLETE");
  assert.equal(evidence.observed.model, null);
  assert.equal(evidence.observed.approvalMode, null);
});

test("secret-bearing stderr is suppressed, hashed, and blocks advancement", async (t) => {
  const f = await captureFixture(t);
  const stderr = "Authorization: Bearer synthetic-secret-for-test-only";
  await f.capture({ processResult: { exitCode: 0, stdout: stream(f.review), stderr } });
  const evidenceText = await readFile(artifactPath(f, ".capture.json"), "utf8");
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.hashes.stderr, sha(stderr));
  assert.ok(evidenceText.includes("redactedForSecret"));
  assert.ok(!evidenceText.includes("synthetic-secret-for-test-only"));
  await assert.rejects(access(artifactPath(f, ".stderr.log")), /ENOENT/);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.currentPhase, "INCOMPLETE");
  assert.equal(state.latestArtifactRefs.reviewRawStderr, undefined);
});

test("secret-bearing review content is never persisted as result or raw stdout", async (t) => {
  const f = await captureFixture(t);
  f.review.summary = "Authorization: Bearer synthetic-secret-for-test-only";
  const stdout = stream(f.review);
  await assert.rejects(() => f.capture({ processResult: { exitCode: 0, stdout, stderr: "" } }));
  await assert.rejects(access(artifactPath(f)), /ENOENT/);
  await assert.rejects(access(artifactPath(f, ".stdout.ndjson")), /ENOENT/);
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(evidence.hashes.stdout, sha(stdout));
  assert.equal(evidence.hashes.savedResult, null);
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
});

test("from-file CLI requires fresh matching artifact ID and preserves original review", async (t) => {
  const f = await captureFixture(t);
  const input = path.join(f.workspaceRoot, "input.json");
  await writeFile(input, JSON.stringify(f.review));
  const base = [path.resolve("tools/qwen-capture-adapter.mjs"), "--workspace-root", f.workspaceRoot,
    "--change-id", f.review.changeId, "--run-id", f.review.runId, "--stage", f.review.stage, "--from-file", input];
  for (const args of [[], ["--artifact-id", "../unsafe"], ["--artifact-id", "mismatched"]]) {
    const result = spawnSync(process.execPath, [...base, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifact.?id/i);
    assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  }
  const accepted = spawnSync(process.execPath, [...base, "--artifact-id", f.review.artifactId], { encoding: "utf8", windowsHide: true });
  assert.equal(accepted.status, 0, accepted.stderr);
  const before = sha(await readFile(artifactPath(f)));
  const duplicate = spawnSync(process.execPath, [...base, "--artifact-id", f.review.artifactId], { encoding: "utf8", windowsHide: true });
  assert.equal(duplicate.status, 1);
  assert.equal(sha(await readFile(artifactPath(f))), before);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.currentPhase, "INCOMPLETE");
});

test("an artifact write failure rolls back all prior new artifacts", async (t) => {
  const f = await captureFixture(t);
  const originalWriteFile = fsPromises.writeFile;
  let writes = 0;
  const mocked = t.mock.method(fsPromises, "writeFile", async (...args) => {
    if (String(args[0]).includes(`${path.sep}artifacts${path.sep}`) && ++writes === 3) throw new Error("injected artifact write failure");
    return originalWriteFile(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.capture, /injected artifact write failure/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  const dir = path.join(path.dirname(f.statePath), "artifacts");
  assert.deepEqual(await readdir(dir), []);
});

async function writeSettings(workspaceRoot, scope, text) {
  const file = {
    workspace: path.join(workspaceRoot, ".qwen", "settings.json"),
    user: path.join(workspaceRoot, "qwen-home", "settings.json"),
    system: path.join(workspaceRoot, "qwen-system", "settings.json"),
    "system-defaults": path.join(workspaceRoot, "qwen-system", "system-defaults.json"),
  }[scope];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function captureEvidence(f, overrides = {}) {
  await f.capture(overrides);
  return JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
}

test("a pinned launch with clean settings verifies the provider and records only the host", async (t) => {
  const f = await captureFixture(t);
  await writeSettings(f.workspaceRoot, "workspace", `{
    // comments are allowed, and "//" inside strings must survive
    "tools": { "approvalMode": "plan" },
    "modelProviders": { "openai": [{ "id": "other-model", "baseUrl": "https://other.example.test/v1" }] }
  }`);
  const evidence = await captureEvidence(f);
  assert.equal(evidence.evidenceGate.passed, true);
  assert.equal(evidence.observed.provider.verified, true);
  assert.equal(evidence.observed.provider.baseUrlHost, "provider.fixture.test");
  assert.equal(evidence.observed.provider.wireObserved, false);
  assert.ok(!evidence.observed.notObserved.includes("provider"));
  const text = JSON.stringify(evidence);
  assert.ok(!text.includes(PINNED_PROVIDER.baseUrl), "the full base URL must not be recorded");
  assert.ok(!text.includes(f.workspaceRoot.replaceAll("\\", "\\\\")), "settings paths must not be recorded");
});

for (const [name, overrides] of [
  ["no expected provider is supplied", { expectedProvider: null }],
  ["the auth type flag is missing", t => ({ commandArgs: PINNED_ARGS.slice(2) })],
  ["the base URL flag differs", { commandArgs: [...PINNED_ARGS.slice(0, 5), "https://elsewhere.test/v1"] }],
  ["a pinned flag is repeated", { commandArgs: [...PINNED_ARGS, "--model", PINNED_PROVIDER.model] }],
  ["qwen-oauth is expected", { expectedProvider: { ...PINNED_PROVIDER, authType: "qwen-oauth" },
    commandArgs: ["--auth-type", "qwen-oauth", ...PINNED_ARGS.slice(2)] }],
  ["the expected base URL is not a URL", { expectedProvider: { ...PINNED_PROVIDER, baseUrl: "not a url" },
    commandArgs: [...PINNED_ARGS.slice(0, 5), "not a url"] }],
]) {
  test(`provider is unverified when ${name}`, async (t) => {
    const f = await captureFixture(t);
    const evidence = await captureEvidence(f, typeof overrides === "function" ? overrides(t) : overrides);
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(evidence.observed.provider.verified, false);
    assert.ok(evidence.evidenceGate.reasons.includes("provider_not_verified"));
    assert.equal(state.currentPhase, "INCOMPLETE");
  });
}

test("equals-form flags pin the provider", async (t) => {
  const f = await captureFixture(t);
  const evidence = await captureEvidence(f, { commandArgs: [`--auth-type=${PINNED_PROVIDER.authType}`,
    `--model=${PINNED_PROVIDER.model}`, `--openai-base-url=${PINNED_PROVIDER.baseUrl}`] });
  assert.equal(evidence.observed.provider.verified, true);
  assert.ok(evidence.argv.includes("--openai-base-url=[host:provider.fixture.test]"));
});

for (const [scope, text, conflict] of [
  ["workspace", JSON.stringify({ modelProviders: { openai: [{ id: "fixture-model", baseUrl: "https://override.test/v1" }] } }), "workspace_model_provider_override"],
  ["user", JSON.stringify({ modelProviders: { "custom-provider": [{ id: "fixture-model" }] } }), "user_model_provider_override"],
  ["system", JSON.stringify({ modelProviders: { openai: [{ id: "$MODEL_FROM_ENV" }] } }), "system_model_provider_override"],
  ["system-defaults", JSON.stringify({ modelProviders: { openai: [{ name: "no id" }] } }), "system-defaults_model_provider_override"],
  ["user", JSON.stringify({ modelProviders: ["not", "an", "object"] }), "user_model_providers_unrecognized"],
  ["workspace", JSON.stringify({ security: { auth: { enforcedType: "anthropic" } } }), "workspace_enforced_type_conflict"],
  ["user", "{ \"broken\": ", "user_settings_unverifiable"],
]) {
  test(`provider is unverified when ${scope} settings could override the launch (${conflict})`, async (t) => {
    const f = await captureFixture(t);
    await writeSettings(f.workspaceRoot, scope, text);
    const evidence = await captureEvidence(f);
    assert.equal(evidence.observed.provider.verified, false);
    assert.ok(evidence.observed.provider.conflicts.includes(conflict), JSON.stringify(evidence.observed.provider.conflicts));
    assert.ok(evidence.evidenceGate.reasons.includes("provider_not_verified"));
  });
}

test("a modelProviders entry for the model is accepted only with the identical base URL", async (t) => {
  const f = await captureFixture(t);
  await writeSettings(f.workspaceRoot, "user", JSON.stringify({ modelProviders: { openai: [
    { id: PINNED_PROVIDER.model, baseUrl: PINNED_PROVIDER.baseUrl, envKey: "FIXTURE_KEY" }] } }));
  assert.equal((await captureEvidence(f)).observed.provider.verified, true);

  const g = await captureFixture(t);
  await writeSettings(g.workspaceRoot, "user", JSON.stringify({ modelProviders: { openai: [
    { id: PINNED_PROVIDER.model, baseUrl: `${PINNED_PROVIDER.baseUrl}/` }] } }));
  assert.ok((await captureEvidence(g)).observed.provider.conflicts.includes("user_model_provider_override"));
});

test("a matching enforcedType does not block a pinned launch", async (t) => {
  const f = await captureFixture(t);
  await writeSettings(f.workspaceRoot, "user", JSON.stringify({ security: { auth: { enforcedType: "openai" } } }));
  assert.equal((await captureEvidence(f)).observed.provider.verified, true);
});

test("the init model must match the pinned model", async (t) => {
  const f = await captureFixture(t);
  const evidence = await captureEvidence(f, { processResult: { exitCode: 0,
    stdout: stream(f.review, rows => { rows[0].model = "substituted-model"; }), stderr: "" } });
  assert.ok(evidence.evidenceGate.reasons.includes("model_differs_from_pinned_launch"));
});

test("from-file captures cannot verify the provider", async (t) => {
  const f = await captureFixture(t);
  const file = path.join(f.workspaceRoot, "capture.ndjson");
  await writeFile(file, stream(f.review));
  const evidence = await captureEvidence(f, { processResult: undefined, fromFile: file });
  assert.ok(evidence.observed.provider.conflicts.some(conflict => conflict.startsWith("argv_")));
  assert.equal(evidence.evidenceGate.passed, false);
});

test("settings paths follow Qwen 0.25.3", () => {
  const root = path.resolve("workspace-root");
  const home = path.resolve("home-dir");
  const defaults = adapter.qwenSettingsPaths({ workspaceRoot: root, env: {}, platform: "win32", homedir: home });
  assert.deepEqual(Object.fromEntries(defaults), {
    system: "C:\\ProgramData\\qwen-code\\settings.json",
    "system-defaults": path.join(path.dirname("C:\\ProgramData\\qwen-code\\settings.json"), "system-defaults.json"),
    user: path.join(home, ".qwen", "settings.json"),
    workspace: path.join(root, ".qwen", "settings.json"),
  });
  const overridden = Object.fromEntries(adapter.qwenSettingsPaths({ workspaceRoot: root, platform: "linux", homedir: home,
    env: { QWEN_HOME: "~/custom-qwen", QWEN_CODE_SYSTEM_SETTINGS_PATH: "/opt/qwen/settings.json",
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: "/opt/qwen/defaults.json" } }));
  assert.equal(overridden.user, path.join(home, "custom-qwen", "settings.json"));
  assert.equal(overridden.system, "/opt/qwen/settings.json");
  assert.equal(overridden["system-defaults"], "/opt/qwen/defaults.json");
  assert.equal(Object.fromEntries(adapter.qwenSettingsPaths({ workspaceRoot: root, env: {}, platform: "linux", homedir: home })).system,
    "/etc/qwen-code/settings.json");
});

test("existing review lock rejects without publishing or removing another lock", async (t) => {
  const f = await captureFixture(t);
  const lock = path.join(path.dirname(f.statePath), "review.lock");
  await writeFile(lock, "other-review");
  await assert.rejects(f.capture, /review_lock_held/);
  assert.equal(await readFile(lock, "utf8"), "other-review");
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  await assert.rejects(access(artifactPath(f)), /ENOENT/);
});

test("review lock is released on success and invalid state", async (t) => {
  for (const invalid of [false, true]) {
    const f = await captureFixture(t);
    if (invalid) await writeFile(f.statePath, "{}");
    if (invalid) await assert.rejects(f.capture); else await f.capture();
    await assert.rejects(access(path.join(path.dirname(f.statePath), "review.lock")), /ENOENT/);
  }
});

for (const [name, input, reason] of [
  ["read_file", { file_path: ".env.local" }, "read_scope_violation"],
  ["READ_FILE", { file_path: ".env.local" }, "read_scope_violation"],
  ["read_file", { file_path: "node_modules/package/index.js" }, "read_scope_violation"],
  ["read_file", { file_path: "dist/bundle.js" }, "read_scope_violation"],
  ["read_file", { file_path: "build/output.js" }, "read_scope_violation"],
  ["read_file", { file_path: "coverage/report.html" }, "read_scope_violation"],
  ["read_file", { file_path: ".agent-runtime/master-authorization.json" }, "read_scope_violation"],
  ["read_file", { file_path: ".agent-runtime/other/current-state.json" }, "read_scope_violation"],
  ["read_file", { file_path: "../outside" }, "read_scope_violation"],
  ["read_file", { unexpected: "README.md" }, "read_scope_not_proven"],
  ["web_search", { query: "test" }, "tool_readonly_not_proven"],
]) {
  test(`read scope rejects ${name} ${JSON.stringify(input)}`, async (t) => {
    const f = await captureFixture(t);
    const evidence = await captureEvidence(f, { processResult: { exitCode: 0, stderr: "",
      stdout: stream(f.review, rows => rows.splice(2, 0, reviewerMessage("assistant", [
        { type: "tool_use", id: "scope-test", name, input },
      ]))) } });
    assert.ok(evidence.evidenceGate.reasons.includes(reason), JSON.stringify(evidence.evidenceGate));
    assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).currentPhase, "INCOMPLETE");
  });
}

test("concurrent captures allow exactly one writer", async (t) => {
  const f = await captureFixture(t);
  const results = await Promise.allSettled([f.capture(), f.capture()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /review_lock_held/);
});

test("explicit read_file paths pass and ignored files fail", async (t) => {
  for (const ignored of [false, true]) {
    const f = await captureFixture(t);
    execFileSync("git", ["init", "--quiet"], { cwd: f.workspaceRoot, windowsHide: true });
    await writeFile(path.join(f.workspaceRoot, "review.md"), "fixture");
    if (ignored) await writeFile(path.join(f.workspaceRoot, ".gitignore"), "review.md\n");
    const evidence = await captureEvidence(f, { processResult: { exitCode: 0, stderr: "",
      stdout: stream(f.review, rows => rows.splice(2, 0, reviewerMessage("assistant", [
        { type: "tool_use", id: "read-one", name: "read_file", input: { file_path: "review.md" } },
      ]))) } });
    assert.equal(evidence.evidenceGate.passed, !ignored, JSON.stringify(evidence.evidenceGate));
    assert.deepEqual(evidence.observed.readPaths, ["review.md"]);
    assert.ok(!JSON.stringify(evidence.observed).includes("readRequest"));
  }
});

test("a referenced runtime file is allowed and an unreferenced file is refused", async (t) => {
  for (const referenced of [true, false]) {
    const f = await captureFixture(t);
    const relativePath = `.agent-runtime/${f.review.changeId}/input.md`;
    await writeFile(path.join(f.workspaceRoot, relativePath), "fixture");
    if (referenced) {
      f.state.latestArtifactRefs.input = { artifactId: "input", changeId: f.review.changeId, runId: f.review.runId, kind: "evidence", relativePath };
      await writeFile(f.statePath, JSON.stringify(f.state));
    }
    const evidence = await captureEvidence(f, { processResult: { exitCode: 0, stderr: "",
      stdout: stream(f.review, rows => rows.splice(2, 0, reviewerMessage("assistant", [
        { type: "tool_use", id: "runtime-read", name: "read_file", input: { file_path: relativePath } },
      ]))) } });
    assert.equal(evidence.evidenceGate.passed, referenced, JSON.stringify(evidence.evidenceGate));
  }
});

test("state symlink outside workspace is rejected and lock is released", async (t) => {
  const f = await captureFixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), "outside-state-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const external = path.join(outside, "state.json");
  await writeFile(external, JSON.stringify(f.state));
  await fsPromises.unlink(f.statePath);
  try { await fsPromises.symlink(external, f.statePath, "file"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Windows does not permit file symlinks"); return; } throw error; }
  await assert.rejects(f.capture, /outside|escape/i);
  await assert.rejects(access(path.join(path.dirname(f.statePath), "review.lock")), /ENOENT/);
  assert.equal(await readFile(external, "utf8"), JSON.stringify(f.state));
});

test("resolved state outside root fails before reading state or publishing artifacts", async (t) => {
  const f = await captureFixture(t);
  const original = fsPromises.realpath;
  const mocked = t.mock.method(fsPromises, "realpath", async value => value === f.statePath
    ? path.resolve(f.workspaceRoot, "../escaped-current-state.json") : original(value));
  syncBuiltinESMExports();
  try { await assert.rejects(f.capture, /outside|escape/i); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.statePath, "utf8"), JSON.stringify(f.state));
  await assert.rejects(access(artifactPath(f)), /ENOENT/);
  await assert.rejects(access(path.join(path.dirname(f.statePath), "review.lock")), /ENOENT/);
});

test("canonical state accepts authorization reference and required input refs", async (t) => {
  const f = await captureFixture(t);
  f.state.rolePolicyVersion = "2";
  f.state.latestHandoff.authorizationRef = "master-authorization.json#test-auth";
  f.state.latestHandoff.requiredInputRefs = [];
  await writeFile(f.statePath, JSON.stringify(f.state));
  await f.capture();
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).gateStatus.reviewPassed, true);
});

async function initGitRepo(f) {
  execFileSync("git", ["init", "--quiet"], { cwd: f.workspaceRoot, windowsHide: true });
}
function withReviewerTool(f, name, input) {
  return { processResult: { exitCode: 0, stderr: "", stdout: stream(f.review, rows => rows.splice(2, 0, reviewerMessage("assistant", [
    { type: "tool_use", id: "search-test", name, input },
  ]))) } };
}

for (const [name, input] of [
  ["grep_search", { pattern: "needle" }],
  ["grep_search", { pattern: "needle", path: ".", glob: "*.ts" }],
  ["glob", { pattern: "**/*.mjs" }],
]) {
  test(`directory search passes while gitignore filtering is active: ${name} ${JSON.stringify(input)}`, async (t) => {
    const f = await captureFixture(t);
    await initGitRepo(f);
    const evidence = await captureEvidence(f, withReviewerTool(f, name, input));
    assert.equal(evidence.evidenceGate.passed, true, JSON.stringify(evidence.evidenceGate));
    assert.deepEqual(evidence.observed.readPaths, ["."]);
  });
}

test("the workspace root stays searchable when git check-ignore matches it", async (t) => {
  const f = await captureFixture(t);
  await initGitRepo(f);
  await writeFile(path.join(f.workspaceRoot, ".gitignore"), "first\n\nsecond\n");
  const evidence = await captureEvidence(f, withReviewerTool(f, "grep_search", { pattern: "needle", path: "." }));
  assert.equal(evidence.evidenceGate.passed, true, JSON.stringify(evidence.evidenceGate));
});

for (const settings of [
  `{ "context": { "fileFiltering": { "respectGitIgnore": false } } }`,
  `{ "tools": { "useRipgrep": false } }`,
  `{ not json`,
]) {
  test(`directory search is not proven with settings ${settings}`, async (t) => {
    const f = await captureFixture(t);
    await initGitRepo(f);
    await writeSettings(f.workspaceRoot, "workspace", settings);
    const evidence = await captureEvidence(f, withReviewerTool(f, "grep_search", { pattern: "needle" }));
    assert.ok(evidence.evidenceGate.reasons.includes("read_scope_not_proven"), JSON.stringify(evidence.evidenceGate));
  });
}

for (const [name, input] of [
  ["glob", { pattern: ".agent-runtime/**" }],
  ["glob", { pattern: "../**" }],
  ["glob", { pattern: "C:/secrets/**" }],
  ["grep_search", { pattern: "needle", glob: "{.env,other}" }],
  ["grep_search", { pattern: "needle", glob: "**/node_modules/**" }],
  ["grep_search", { pattern: "needle", path: ".agent-runtime" }],
]) {
  test(`search into a refused location is a violation: ${name} ${JSON.stringify(input)}`, async (t) => {
    const f = await captureFixture(t);
    await initGitRepo(f);
    const evidence = await captureEvidence(f, withReviewerTool(f, name, input));
    assert.ok(evidence.evidenceGate.reasons.includes("read_scope_violation"), JSON.stringify(evidence.evidenceGate));
  });
}

test("suppressed output records the rule category and position without the content", async (t) => {
  const f = await captureFixture(t);
  await initGitRepo(f);
  const secret = `sk-${"a".repeat(20)}`;
  const evidence = await captureEvidence(f, { processResult: { exitCode: 0, stderr: "", stdout: stream(f.review, rows => rows.splice(2, 0,
    reviewerMessage("assistant", [{ type: "tool_use", id: "leaky-read", name: "grep_search", input: { pattern: "needle" } }]),
    reviewerMessage("user", [{ type: "tool_result", tool_use_id: "leaky-read", content: secret }]),
  )) } });
  assert.ok(evidence.evidenceGate.reasons.includes("raw_output_contains_secret"));
  const hit = evidence.secretHits.stdout.hits.find(item => item.toolUseIds.includes("leaky-read"));
  assert.deepEqual(hit.categories, ["provider_key"]);
  assert.equal(hit.eventType, "user");
  assert.equal(evidence.secretHits.stderr, null);
  assert.ok(!JSON.stringify(evidence).includes(secret));
});

test("a rejected review_result records why without echoing a secret", async (t) => {
  const f = await captureFixture(t);
  const mismatched = { ...f.review, artifactId: "other-id" };
  await assert.rejects(f.capture({ processResult: { exitCode: 0, stderr: "", stdout: stream(mismatched) } }), /schema or artifactId/);
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.match(evidence.validationIssue.message, /artifactId/);
  assert.equal(evidence.validationIssue.candidateFound, true);
  assert.equal(evidence.validationIssue.candidateOwner, "subagent");
  assert.ok(evidence.validationIssue.candidateKeys.includes("payload"));
});

test("a tool Qwen 0.25.3 does not have is not certified as read-only", async (t) => {
  const f = await captureFixture(t);
  await initGitRepo(f);
  const evidence = await captureEvidence(f, withReviewerTool(f, "read_many_files", { paths: ["review.md"] }));
  assert.ok(evidence.evidenceGate.reasons.includes("tool_readonly_not_proven"), JSON.stringify(evidence.evidenceGate));
});

test("a review from an unverified Qwen version routes to INCOMPLETE", async (t) => {
  const f = await captureFixture(t);
  const evidence = await captureEvidence(f, { processResult: { exitCode: 0, stderr: "", stdout: stream(f.review, rows => {
    rows.find(row => row.subtype === "init").qwen_code_version = "0.20.1";
  }) } });
  assert.ok(evidence.evidenceGate.reasons.includes("qwen_version_unverified"), JSON.stringify(evidence.evidenceGate));
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).currentPhase, "INCOMPLETE");
});

test("qwen resolves to node and its cli entry on Windows only", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qwen-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const onPath = path.join(root, "bin", "node_modules", "@qwen-code", "qwen-code", "cli-entry.js");
  const pinned = path.join(root, "pinned", "cli-entry.js");
  await mkdir(path.dirname(onPath), { recursive: true });
  await mkdir(path.dirname(pinned), { recursive: true });
  await writeFile(onPath, "");
  await writeFile(pinned, "");
  const win = env => resolveQwenCommand("qwen", ["-p", "x"], { platform: "win32", env });
  const Path = `${path.join(root, "empty")};${path.join(root, "bin")}`;

  assert.deepEqual(await win({ Path }), { command: process.execPath, commandArgs: [onPath, "-p", "x"] });
  assert.deepEqual(await win({ Path, QWEN_CLI_ENTRY: pinned }), { command: process.execPath, commandArgs: [pinned, "-p", "x"] });
  assert.deepEqual(await win({ Path, QWEN_CLI_ENTRY: path.join(root, "missing.js") }), { command: "qwen", commandArgs: ["-p", "x"] });
  assert.deepEqual(await resolveQwenCommand("qwen", ["-p"], { platform: "linux", env: { PATH: root } }), { command: "qwen", commandArgs: ["-p"] });
  assert.deepEqual(await resolveQwenCommand("node", ["a.js"], { platform: "win32", env: { Path } }), { command: "node", commandArgs: ["a.js"] });
});

test("the current change's own state is readable and recorded as clean", async (t) => {
  const f = await captureFixture(t);
  await initGitRepo(f);
  await writeFile(path.join(f.workspaceRoot, ".gitignore"), ".agent-runtime/\n");
  const relativePath = `.agent-runtime/${f.review.changeId}/current-state.json`;
  const evidence = await captureEvidence(f, withReviewerTool(f, "read_file", { file_path: relativePath }));
  assert.equal(evidence.evidenceGate.passed, true, JSON.stringify(evidence.evidenceGate));
  assert.deepEqual(evidence.observed.readScopeFindings, []);
});

test("read scope findings name the rule and tool without file content", async (t) => {
  for (const [name, input, rule, target] of [
    ["read_file", { file_path: ".agent-runtime/other/current-state.json" }, "forbidden_path", ".agent-runtime/other/current-state.json"],
    ["grep_search", { pattern: "needle", glob: "{.env,other}" }, "unsafe_search_filter", null],
    ["read_file", { file_path: "../outside" }, "outside_workspace", null],
  ]) {
    const f = await captureFixture(t);
    await initGitRepo(f);
    const evidence = await captureEvidence(f, withReviewerTool(f, name, input));
    assert.ok(evidence.evidenceGate.reasons.includes("read_scope_violation"), JSON.stringify(evidence.evidenceGate));
    const finding = evidence.observed.readScopeFindings.find(item => item.rule === rule);
    assert.equal(finding.reason, "read_scope_violation");
    assert.equal(finding.toolUseId, "search-test");
    assert.equal(finding.tool, name);
    assert.equal(finding.target, target);
  }
});

test("a search filter holding a credential is not copied into the findings", async (t) => {
  const f = await captureFixture(t);
  await initGitRepo(f);
  const secret = `sk-${"a1".repeat(10)}`;
  const evidence = await captureEvidence(f, withReviewerTool(f, "glob", { pattern: secret }));
  assert.equal(evidence.observed.readScopeFindings[0].filter, null);
  assert.ok(!JSON.stringify(evidence.observed.readScopeFindings).includes(secret));
});

const AUTH = ["author", "ization"].join("");
const BEARER = "Bea" + "rer";
for (const [label, line, expected] of [
  ["a template header", `headers: { ${AUTH}: \`${BEARER} \${options.credential}\` },`, []],
  ["a double-quoted template", `"${AUTH}": "${BEARER} \${token}"`, []],
  ["a JSON-escaped template", `\\"${AUTH}\\": \\"${BEARER} \${token}\\"`, []],
  ["a bare template", `api_key = \`\${config.apiKey}\`;`, []],
  ["a literal token", `${AUTH}: ${BEARER} abcdef0123456789`, ["bearer_token", "credential_assignment"]],
  ["a literal token in a template", `${AUTH}: \`${BEARER} abcdef0123456789\``, ["bearer_token", "credential_assignment"]],
  ["a literal assignment", `api_key=abcd${"1234"}`, ["credential_assignment"]],
  ["a shell default", `password=\${DB_PASS:-hunter2222}`, ["credential_assignment"]],
  ["a literal after an interpolation", `password: \`\${prefix}hunter2222\``, ["credential_assignment"]],
  ["a real provider key", `sk-${"proj-Ab3dE5gH7jK9"}`, ["provider_key"]],
  ["a hex provider key", `sk-${"0a1b2c3d4e5f6a7b8c9d"}`, ["provider_key"]],
  ["an upper-case prefix", `SK-${"Ab3dE5gH7jK9mN1p"}`, ["provider_key"]],
  ["a random key under the test prefix", `sk-${"test-a8f3k29xQ7mN1p"}`, ["provider_key"]],
  ["a word fixture", `sk-${"test-credential-value-123456"}`, []],
  ["a key embedded after a word fixture", `sk-${"test-credential-value-123456"} sk-${"proj-Ab3dE5gH7jK9"}`, ["provider_key"]],
]) {
  test(`secret rules for ${label}`, () => {
    assert.deepEqual(secretCategories(line), expected);
  });
}

test("a failed spawn records the error code", async (t) => {
  const f = await captureFixture(t);
  await assert.rejects(f.capture({ processResult: undefined, command: path.join(f.workspaceRoot, "no-such-binary"), commandArgs: [] }), /process_nonzero_exit/);
  const evidence = JSON.parse(await readFile(artifactPath(f, ".capture.json"), "utf8"));
  assert.equal(evidence.spawnError, "ENOENT");
});
