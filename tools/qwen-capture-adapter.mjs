#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

const DEFAULT_STAGE = "review-result";
const EXPECTED_KIND = "review_result";
const EXPECTED_PRODUCER = "Qwen";
const SUPPORTED_SCHEMA_MAJOR_VERSION = 1;
const VALID_RESULT_STATUSES = new Set(["success", "failure", "partial"]);
const VALID_REVIEW_VERDICTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT_ONLY", "INCOMPLETE"]);

const VALID_CURRENT_STATE_PHASES = new Set([
  "PLAN_DRAFT",
  "PLAN_REVIEW",
  "PLAN_APPROVED",
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "READY_FOR_REVIEW",
  "REVIEWING",
  "REVIEW_RESULT",
  "CHANGES_REQUESTED",
  "NEEDS_COORDINATOR_ARBITRATION",
  "READY_FOR_READINESS_CHECK",
  "READY_FOR_ARCHIVE",
  "ARCHIVED_AWAITING_HUMAN_COMMIT",
  "COMPLETED",
  "FAILED",
  "INCOMPLETE",
]);

const VALID_CURRENT_STATE_OWNERS = new Set(["CCR", "Codex", "Qwen", "Human"]);

const REQUIRED_CURRENT_STATE_FIELDS = [
  "schemaVersion",
  "changeId",
  "runId",
  "currentPhase",
  "currentOwner",
  "attempt",
  "latestArtifactRefs",
  "latestHandoff",
  "gateStatus",
  "blockers",
  "nextActions",
  "updatedAt",
  "terminalStatus",
];

const VERDICT_TRANSITIONS = {
  APPROVE: {
    currentPhase: "READY_FOR_READINESS_CHECK",
    currentOwner: "CCR",
    reviewPassed: true,
    handoffStatus: "COMPLETED",
  },
  COMMENT_ONLY: {
    currentPhase: "READY_FOR_READINESS_CHECK",
    currentOwner: "CCR",
    reviewPassed: true,
    handoffStatus: "COMPLETED",
  },
  REQUEST_CHANGES: {
    currentPhase: "CHANGES_REQUESTED",
    currentOwner: "Codex",
    reviewPassed: false,
    handoffStatus: "COMPLETED",
  },
  INCOMPLETE: {
    currentPhase: "INCOMPLETE",
    currentOwner: "CCR",
    reviewPassed: false,
    handoffStatus: "FAILED",
  },
};

const STAGE_VERDICT_TRANSITIONS = {
  "review-plan": {
    APPROVE: {
      currentPhase: "PLAN_APPROVED",
      currentOwner: "CCR",
      reviewPassed: true,
      handoffStatus: "COMPLETED",
    },
    COMMENT_ONLY: {
      currentPhase: "PLAN_APPROVED",
      currentOwner: "CCR",
      reviewPassed: true,
      handoffStatus: "COMPLETED",
    },
    REQUEST_CHANGES: {
      currentPhase: "PLAN_DRAFT",
      currentOwner: "CCR",
      reviewPassed: false,
      handoffStatus: "COMPLETED",
    },
    INCOMPLETE: {
      currentPhase: "INCOMPLETE",
      currentOwner: "CCR",
      reviewPassed: false,
      handoffStatus: "FAILED",
    },
  },
  "review-result": {
    REQUEST_CHANGES: {
      currentPhase: "CHANGES_REQUESTED",
      currentOwner: "Codex",
      reviewPassed: false,
      handoffStatus: "COMPLETED",
    },
  },
};

function resolveTransition(verdict, stage) {
  const stageOverride = STAGE_VERDICT_TRANSITIONS[stage]?.[verdict];
  if (stageOverride) return stageOverride;
  const fallback = VERDICT_TRANSITIONS[verdict];
  if (!fallback) throw new Error(`Unknown verdict: ${verdict}`);
  return fallback;
}

function buildStageHandoff(verdict, stage) {
  if (stage === "review-plan") {
    if (verdict === "REQUEST_CHANGES") {
      return { stage: "plan-draft", from: "Qwen", to: "CCR", status: "PENDING" };
    }
    if (verdict === "APPROVE" || verdict === "COMMENT_ONLY") {
      return { stage: "apply-change", from: "CCR", to: "Codex", status: "PENDING" };
    }
  }
  if (stage === "review-result") {
    if (verdict === "REQUEST_CHANGES") {
      return { stage: "fix-from-review", from: "Qwen", to: "Codex", status: "PENDING" };
    }
  }
  return null;
}

export function extractJsonObjectFromOutput(output) {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error("Qwen stdout is empty; no review_result JSON found.");
  }

  const fencedJson = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedJson) {
    return parseJsonObject(fencedJson[1].trim());
  }

  const trimmed = output.trim();
  try {
    return parseJsonObject(trimmed);
  } catch {
    const objectText = findFirstJsonObjectText(trimmed);
    if (!objectText) {
      throw new Error("Qwen stdout does not contain a JSON object.");
    }

    return parseJsonObject(objectText);
  }
}

export function validateReviewResult(
  value,
  { expectedChangeId, expectedRunId, expectedStage = DEFAULT_STAGE, expectedKind = EXPECTED_KIND },
) {
  if (!isPlainObject(value)) {
    throw new Error("review_result must be a JSON object.");
  }

  requireStringField(value, "schemaVersion");
  requireStringField(value, "artifactId");
  requireStringField(value, "changeId");
  requireStringField(value, "runId");
  requireStringField(value, "producer");
  requireStringField(value, "stage");
  requireStringField(value, "kind");
  requireStringField(value, "status");
  requireStringField(value, "createdAt");
  requireStringField(value, "summary");

  validateCompatibleSchemaVersion(value.schemaVersion);

  if (value.changeId !== expectedChangeId) {
    throw new Error(`Unexpected changeId: ${value.changeId}`);
  }

  if (value.runId !== expectedRunId) {
    throw new Error(`Unexpected runId: ${value.runId}`);
  }

  if (value.stage !== expectedStage) {
    throw new Error(`Unexpected stage: ${value.stage}`);
  }

  if (value.kind !== expectedKind) {
    throw new Error(`Unexpected kind: ${value.kind}`);
  }

  if (value.producer !== EXPECTED_PRODUCER) {
    throw new Error(`Unexpected producer: ${value.producer}`);
  }

  if (!VALID_RESULT_STATUSES.has(value.status)) {
    throw new Error(`Unexpected status: ${value.status}`);
  }

  requireArrayField(value, "inputRefs");
  requireArrayField(value, "outputRefs");
  requireArrayField(value, "risks");

  validateVerification(value.verification);
  validateReviewPayload(value.payload);

  return value;
}

export async function captureQwenReviewResult({
  workspaceRoot = process.cwd(),
  changeId,
  runId,
  stage = DEFAULT_STAGE,
  command,
  commandArgs = [],
  processResult,
  now = () => new Date(),
}) {
  validatePathSegment("changeId", changeId);
  requireNonEmptyString("runId", runId);
  requireNonEmptyString("stage", stage);

  const root = path.resolve(workspaceRoot);
  const runtimeDir = path.join(root, ".agent-runtime", changeId);
  const artifactsDir = path.join(runtimeDir, "artifacts");
  const currentStatePath = path.join(runtimeDir, "current-state.json");
  const artifactPath = path.join(artifactsDir, "review-result.json");
  const artifactTempPath = `${artifactPath}.${process.pid}.${Date.now()}.tmp`;
  const currentStateTempPath = `${currentStatePath}.${process.pid}.${Date.now()}.tmp`;

  ensureInside(root, runtimeDir);
  ensureInside(root, artifactsDir);
  ensureInside(root, currentStatePath);
  ensureInside(root, artifactPath);

  const result = processResult ?? (await runCommand(command, commandArgs, { cwd: root }));

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `Qwen CLI exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  const parsed = extractJsonObjectFromOutput(result.stdout);
  const reviewResult = validateReviewResult(parsed, {
    expectedChangeId: changeId,
    expectedRunId: runId,
    expectedStage: stage,
    expectedKind: EXPECTED_KIND,
  });

  const currentState = await readCurrentState(currentStatePath, { expectedChangeId: changeId, expectedRunId: runId });
  const updatedState = applyVerdictTransition(currentState, reviewResult, {
    changeId,
    runId,
    relativePath: toPosixPath(path.relative(root, artifactPath)),
    now,
  });

  await mkdir(artifactsDir, { recursive: true });
  await writeJsonAtomic(artifactPath, artifactTempPath, reviewResult);
  await writeJsonAtomic(currentStatePath, currentStateTempPath, updatedState);

  return {
    artifactPath,
    currentStatePath,
    artifactReference: updatedState.latestArtifactRefs.reviewResult,
  };
}

function applyVerdictTransition(currentState, reviewResult, { changeId, runId, relativePath, now }) {
  const verdict = reviewResult.payload.verdict;
  const stage = reviewResult.stage;
  const transition = resolveTransition(verdict, stage);
  const stageHandoff = buildStageHandoff(verdict, stage);

  return {
    ...currentState,
    currentPhase: transition.currentPhase,
    currentOwner: transition.currentOwner,
    attempt: currentState.attempt,
    latestArtifactRefs: {
      ...currentState.latestArtifactRefs,
      reviewResult: {
        artifactId: reviewResult.artifactId,
        changeId,
        runId,
        kind: EXPECTED_KIND,
        relativePath,
      },
    },
    latestHandoff: stageHandoff
      ? {
          handoffId: `handoff-${changeId}-${stageHandoff.from.toLowerCase()}-to-${stageHandoff.to.toLowerCase()}-${stageHandoff.stage}-${Date.now()}`,
          stage: stageHandoff.stage,
          from: stageHandoff.from,
          to: stageHandoff.to,
          reason: `Qwen ${stage} verdict=${verdict}; ${verdict === "REQUEST_CHANGES" ? "退回修訂" : "推進下一阶段"}`,
          status: stageHandoff.status,
        }
      : {
          ...currentState.latestHandoff,
          status: transition.handoffStatus,
        },
    gateStatus: {
      ...currentState.gateStatus,
      reviewPassed: transition.reviewPassed,
    },
    blockers: buildBlockerEntries(reviewResult, changeId, runId, currentState.blockers ?? []),
    nextActions: buildNextActions(verdict, reviewResult),
    updatedAt: now().toISOString(),
  };
}

function buildBlockerEntries(reviewResult, changeId, runId, existingBlockers) {
  const reviewPrefix = `${reviewResult.artifactId}:`;
  const entries = [];

  for (const blocker of existingBlockers ?? []) {
    if (typeof blocker?.source === "string" && !blocker.source.startsWith(reviewPrefix)) {
      entries.push({ ...blocker });
    }
  }

  for (const finding of reviewResult.payload.findings.blocker) {
    entries.push({
      severity: "Blocker",
      description: finding.description ?? finding.summary ?? JSON.stringify(finding),
      source: `${reviewResult.artifactId}:blocker:${finding.id ?? finding.title ?? ""}`,
      status: "unresolved",
    });
  }

  for (const finding of reviewResult.payload.findings.major) {
    entries.push({
      severity: "Major",
      description: finding.description ?? finding.summary ?? JSON.stringify(finding),
      source: `${reviewResult.artifactId}:major:${finding.id ?? finding.title ?? ""}`,
      status: "unresolved",
    });
  }

  return entries;
}

function buildNextActions(verdict, reviewResult) {
  const stage = reviewResult.stage;
  const actions = [];

  if (verdict === "APPROVE" || verdict === "COMMENT_ONLY") {
    if (stage === "review-plan") {
      actions.push("CCR 推進 PLAN_APPROVED 並準備 apply-change 交接 Codex");
    } else {
      actions.push("CCR 執行 readiness check");
    }
  } else if (verdict === "REQUEST_CHANGES") {
    if (stage === "review-plan") {
      actions.push("CCR 依 Qwen review-plan REQUEST_CHANGES 退回 PLAN_DRAFT，修訂 design 以解決 Major finding。");
      for (const finding of reviewResult.payload.findings.blocker) {
        actions.push(`修訂 Blocker: ${finding.description ?? finding.summary ?? finding.title ?? "unnamed"}`);
      }
      for (const finding of reviewResult.payload.findings.major) {
        actions.push(`修訂 Major: ${finding.description ?? finding.summary ?? finding.title ?? "unnamed"}`);
      }
      actions.push("修訂完成後由 CCR 重新提交 plan，觸發下一輪 review-plan。");
    } else {
      actions.push("Codex 修正 Blocker 和 Major findings 後重新提交");
      for (const finding of reviewResult.payload.findings.blocker) {
        actions.push(`修正 Blocker: ${finding.description ?? finding.summary ?? finding.title ?? "unnamed"}`);
      }
      for (const finding of reviewResult.payload.findings.major) {
        actions.push(`修正 Major: ${finding.description ?? finding.summary ?? finding.title ?? "unnamed"}`);
      }
    }
  } else if (verdict === "INCOMPLETE") {
    actions.push("CCR 檢查 INCOMPLETE 原因並決定下一步");
  }

  return actions;
}

function validateCanonicalCurrentState(currentState, { expectedChangeId, expectedRunId }) {
  for (const field of REQUIRED_CURRENT_STATE_FIELDS) {
    if (!(field in currentState)) {
      throw new Error(`current-state.json missing required field: ${field}`);
    }
  }

  if (currentState.changeId !== expectedChangeId) {
    throw new Error(`current-state.json changeId mismatch: ${currentState.changeId}`);
  }

  if (currentState.runId !== expectedRunId) {
    throw new Error(`current-state.json runId mismatch: ${currentState.runId}`);
  }

  if (!isPlainObject(currentState.latestArtifactRefs)) {
    throw new Error("current-state.json latestArtifactRefs must be an object.");
  }

  if (!VALID_CURRENT_STATE_PHASES.has(currentState.currentPhase)) {
    throw new Error(`current-state.json invalid currentPhase: ${currentState.currentPhase}`);
  }

  if (!VALID_CURRENT_STATE_OWNERS.has(currentState.currentOwner)) {
    throw new Error(`current-state.json invalid currentOwner: ${currentState.currentOwner}`);
  }

  if (!isPlainObject(currentState.gateStatus)) {
    throw new Error("current-state.json gateStatus must be an object.");
  }

  if (!isPlainObject(currentState.latestHandoff)) {
    throw new Error("current-state.json latestHandoff must be an object.");
  }

  if (!Array.isArray(currentState.blockers)) {
    throw new Error("current-state.json blockers must be an array.");
  }

  if (typeof currentState.attempt !== "number" || currentState.attempt < 1) {
    throw new Error("current-state.json attempt must be a positive integer.");
  }

  return currentState;
}

async function readCurrentState(currentStatePath, { expectedChangeId, expectedRunId }) {
  let raw;

  try {
    raw = await readFile(currentStatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`current-state.json not found: ${currentStatePath}`);
    }
    throw error;
  }

  const currentState = parseJsonObject(raw);

  return validateCanonicalCurrentState(currentState, { expectedChangeId, expectedRunId });
}

async function writeJsonAtomic(finalPath, tempPath, value) {
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function runCommand(command, commandArgs, { cwd }) {
  requireNonEmptyString("command", command);

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonObject(text) {
  let parsed;

  try {
    parsed = JSON.parse(stripByteOrderMark(text));
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Parsed JSON must be an object.");
  }

  return parsed;
}

function stripByteOrderMark(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function findFirstJsonObjectText(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function validateVerification(value) {
  if (!isPlainObject(value)) {
    throw new Error("verification must be an object.");
  }

  requireArrayField(value, "executed");
  requireArrayField(value, "passed");
  requireArrayField(value, "failed");
  requireArrayField(value, "notExecuted");
}

function validateReviewPayload(value) {
  if (!isPlainObject(value)) {
    throw new Error("payload must be an object.");
  }

  if (!VALID_REVIEW_VERDICTS.has(value.verdict)) {
    throw new Error(`Unexpected payload.verdict: ${value.verdict}`);
  }

  if (!isPlainObject(value.findings)) {
    throw new Error("payload.findings must be an object.");
  }

  requireArrayField(value.findings, "blocker");
  requireArrayField(value.findings, "major");
  requireArrayField(value.findings, "minor");
  requireArrayField(value, "residualRisks");
  requireArrayField(value, "positiveNotes");

  if (!isPlainObject(value.crossLayerContractCheck)) {
    throw new Error("payload.crossLayerContractCheck must be an object.");
  }
}

function requireStringField(value, fieldName) {
  if (typeof value[fieldName] !== "string" || value[fieldName].length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function requireArrayField(value, fieldName) {
  if (!Array.isArray(value[fieldName])) {
    throw new Error(`${fieldName} must be an array.`);
  }
}

function validateCompatibleSchemaVersion(schemaVersion) {
  const majorVersion = parseSchemaMajorVersion(schemaVersion);

  if (majorVersion !== SUPPORTED_SCHEMA_MAJOR_VERSION) {
    throw new Error(
      `Unsupported schemaVersion major: ${schemaVersion}; expected ${SUPPORTED_SCHEMA_MAJOR_VERSION}.x.x`,
    );
  }
}

function parseSchemaMajorVersion(schemaVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(schemaVersion);

  if (!match) {
    throw new Error(`Invalid schemaVersion: ${schemaVersion}`);
  }

  return Number.parseInt(match[1], 10);
}

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function validatePathSegment(name, value) {
  requireNonEmptyString(name, value);

  if (value.includes("..") || value.includes("/") || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function ensureInside(root, targetPath) {
  const relativePath = path.relative(root, path.resolve(targetPath));

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Resolved path escapes workspace root: ${targetPath}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const adapterArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const commandParts = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const parsed = {
    workspaceRoot: process.cwd(),
    stage: DEFAULT_STAGE,
    command: commandParts[0],
    commandArgs: commandParts.slice(1),
    fromFile: null,
  };

  for (let index = 0; index < adapterArgs.length; index += 1) {
    const arg = adapterArgs[index];
    const value = adapterArgs[index + 1];

    if (arg === "--workspace-root") {
      parsed.workspaceRoot = value;
      index += 1;
    } else if (arg === "--change-id") {
      parsed.changeId = value;
      index += 1;
    } else if (arg === "--run-id") {
      parsed.runId = value;
      index += 1;
    } else if (arg === "--stage") {
      parsed.stage = value;
      index += 1;
    } else if (arg === "--from-file") {
      parsed.fromFile = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node tools/qwen-capture-adapter.mjs --change-id <change-id> --run-id <run-id> [--stage review-result] -- qwen <args...>",
    "  node tools/qwen-capture-adapter.mjs --change-id <change-id> --run-id <run-id> [--stage review-plan] --from-file <path-to-review-result.json>",
    "",
    "The adapter captures stdout from the command (or reads --from-file), extracts a review_result",
    "JSON object, validates changeId/runId/stage/kind/producer, then atomically writes:",
    "  .agent-runtime/<change-id>/artifacts/review-result.json",
    "",
    "Options:",
    "  --from-file <path>  Read review_result from an existing JSON file instead of spawning a command.",
  ].join("\n");
}

async function assertCurrentStateExists(workspaceRoot, changeId) {
  const currentStatePath = path.join(path.resolve(workspaceRoot), ".agent-runtime", changeId, "current-state.json");
  await access(currentStatePath, fsConstants.R_OK);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      console.log(usage());
      process.exit(0);
    }

    requireNonEmptyString("changeId", args.changeId);
    requireNonEmptyString("runId", args.runId);
    validatePathSegment("changeId", args.changeId);
    await assertCurrentStateExists(args.workspaceRoot, args.changeId);

    if (args.fromFile) {
      const fileContent = await readFile(args.fromFile, "utf8");
      const parsed = extractJsonObjectFromOutput(fileContent);
      args.processResult = { exitCode: 0, stdout: JSON.stringify(parsed), stderr: "" };
      args.command = "node";
      args.commandArgs = ["-e", ""];
    } else {
      requireNonEmptyString("command", args.command);
    }

    const result = await captureQwenReviewResult(args);
    console.log(
      JSON.stringify(
        {
          ok: true,
          artifactPath: result.artifactPath,
          artifactReference: result.artifactReference,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
