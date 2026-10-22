import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024;
const CURRENT_STATE_REQUIRED_FIELDS = [
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
const CCR_RUNTIME_ARTIFACT_PATTERN = /^(?:coordinator-result(?:-[\w.-]+)?|readiness-result|handoff(?:-[\w.-]+)?)\.json$/u;
const MASTER_AUTHORIZATION_PATH = ".agent-runtime/master-authorization.json";
const ACTIVE_HANDOFF_STATUSES = new Set(["PENDING", "ACCEPTED", "IN_PROGRESS"]);
const CCR_GUARD_PROTECTED_PATHS = [
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  MASTER_AUTHORIZATION_PATH,
];

function isProtectedGuardPath(relativeTarget) {
  return CCR_GUARD_PROTECTED_PATHS.some((entry) =>
      entry.endsWith("/") ? relativeTarget.startsWith(entry) : relativeTarget === entry,
  );
}

function isSafeScopeEntry(entry) {
  return typeof entry === "string" && entry !== "" && !entry.includes("..") &&
      !entry.startsWith("/") && !/^[A-Za-z]:/u.test(entry);
}

function isWithinWriteScope(relativeTarget, writeScope) {
  return writeScope.every(isSafeScopeEntry) && writeScope.some((entry) =>
      entry.endsWith("/") ? relativeTarget.startsWith(entry) : relativeTarget === entry,
  );
}

async function resolveCcrImplementerGrant(workspaceRoot, now = Date.now()) {
  let authorization;
  try {
    authorization = parseJsonObject(
        await readFile(path.join(workspaceRoot, ...MASTER_AUTHORIZATION_PATH.split("/")), "utf8"),
    );
  } catch {
    return null;
  }
  const expiresAt = Date.parse(authorization?.expiresAt);
  if (
      !authorization ||
      authorization.rolePolicyVersion !== "2" ||
      authorization.grantedBy !== "Master" ||
      authorization.grantee !== "CCR" ||
      authorization.actingRole !== "implementation_secondary" ||
      !Array.isArray(authorization.grants) ||
      !authorization.grants.includes("secondary_takeover") ||
      typeof authorization.changeId !== "string" ||
      !/^[\w.-]+$/u.test(authorization.changeId) ||
      authorization.changeId.includes("..") ||
      !Array.isArray(authorization.writeScope) ||
      authorization.writeScope.length === 0 ||
      Number.isNaN(expiresAt) ||
      expiresAt <= now
  ) {
    return null;
  }

  const stateResult = await readCurrentState(workspaceRoot, authorization.changeId);
  if (stateResult.status !== "valid") {
    return null;
  }
  const state = stateResult.value;
  const handoff = isRecord(state.latestHandoff) ? state.latestHandoff : {};
  if (
      state.runId !== authorization.runId ||
      state.currentOwner !== "CCR" ||
      state.terminalStatus !== "NON_TERMINAL" ||
      handoff.handoffId !== authorization.handoffId ||
      handoff.to !== "CCR" ||
      !ACTIVE_HANDOFF_STATUSES.has(handoff.status)
  ) {
    return null;
  }
  return authorization;
}

function allow(reason) {
  return { decision: "allow", reason };
}

function deny(reason) {
  return {
    decision: "deny",
    reason: `${reason} CCR 只能產出 Handoff，不得修改任何字。`,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspacePath(workspaceRoot, candidatePath) {
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    return null;
  }

  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  const absoluteTarget = path.resolve(absoluteWorkspaceRoot, candidatePath);
  const relativeTarget = path.relative(absoluteWorkspaceRoot, absoluteTarget);

  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    return null;
  }

  return {
    absoluteTarget,
    relativeTarget: relativeTarget.split(path.sep).join("/"),
  };
}

function parseJsonObject(rawValue) {
  if (typeof rawValue !== "string" || Buffer.byteLength(rawValue, "utf8") > MAX_HOOK_INPUT_BYTES) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateInitialCurrentState(candidateState, changeId) {
  if (!candidateState) {
    return false;
  }

  if (CURRENT_STATE_REQUIRED_FIELDS.some((field) => !(field in candidateState))) {
    return false;
  }

  return (
    candidateState.changeId === changeId &&
    candidateState.currentPhase === "PLAN_DRAFT" &&
    candidateState.currentOwner === "CCR" &&
    candidateState.terminalStatus === "NON_TERMINAL"
  );
}

async function readCurrentState(workspaceRoot, changeId) {
  const currentStatePath = path.join(
    workspaceRoot,
    ".agent-runtime",
    changeId,
    "current-state.json",
  );

  try {
    const rawState = await readFile(currentStatePath, "utf8");
    const currentState = parseJsonObject(rawState);
    if (
      !currentState ||
      currentState.changeId !== changeId ||
      typeof currentState.currentPhase !== "string" ||
      typeof currentState.currentOwner !== "string" ||
      typeof currentState.terminalStatus !== "string"
    ) {
      return { status: "invalid" };
    }
    return { status: "valid", value: currentState };
  } catch (error) {
    return error && typeof error === "object" && error.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
}

function getOpenSpecChangeTarget(relativeTarget) {
  const match = relativeTarget.match(
    /^openspec\/changes\/([^/]+)\/(proposal\.md|design\.md|tasks\.md|specs\/.+)$/u,
  );
  if (!match || match[1] === "archive" || match[1].includes("..")) {
    return null;
  }
  return { changeId: match[1], artifactPath: match[2] };
}

function getRuntimeTarget(relativeTarget) {
  const match = relativeTarget.match(/^\.agent-runtime\/([^/]+)\/(.+)$/u);
  if (!match || match[1].includes("..")) {
    return null;
  }
  return { changeId: match[1], artifactPath: match[2] };
}

async function evaluateFileWrite(toolName, toolInput, workspaceRoot) {
  const rawTarget = toolInput.file_path ?? toolInput.path;
  const target = resolveWorkspacePath(workspaceRoot, rawTarget);
  if (!target) {
    return deny("寫入路徑缺失、越界或無法驗證。");
  }

  if (isProtectedGuardPath(target.relativeTarget)) {
    return deny("CCR 不得修改自身寫入守門、宿主設定或 Master 授權。");
  }

  const implementerGrant = await resolveCcrImplementerGrant(workspaceRoot);
  if (implementerGrant && isWithinWriteScope(target.relativeTarget, implementerGrant.writeScope)) {
    return allow(`CCR 以 implementation_secondary 執行 ${implementerGrant.handoffId}（Master 授權 ${implementerGrant.authorizationId}）。`);
  }

  const openSpecTarget = getOpenSpecChangeTarget(target.relativeTarget);
  if (openSpecTarget) {
    const currentStateResult = await readCurrentState(workspaceRoot, openSpecTarget.changeId);
    if (currentStateResult.status === "missing") {
      return deny("缺少合法 CurrentState，寫入權必須 fail-closed。");
    }
    if (currentStateResult.status === "invalid") {
      return deny("CurrentState 無效或損壞，寫入權必須 fail-closed。");
    }
    const currentState = currentStateResult.value;
    if (currentState.currentOwner !== "CCR") {
      return deny(`currentOwner 為 ${String(currentState.currentOwner)}，不是 CCR。`);
    }
    if (currentState.currentPhase !== "PLAN_DRAFT") {
      return deny(`只有 PLAN_DRAFT 可由 CCR 修改 OpenSpec delta，目前為 ${String(currentState.currentPhase)}。`);
    }
    if (currentState.terminalStatus !== "NON_TERMINAL") {
      return deny("Change 已進入 terminal state。");
    }
    return allow("CCR 正在合法的 PLAN_DRAFT 階段維護該 Change artifacts。");
  }

  const runtimeTarget = getRuntimeTarget(target.relativeTarget);
  if (runtimeTarget?.artifactPath === "current-state.json") {
    const currentStateResult = await readCurrentState(workspaceRoot, runtimeTarget.changeId);
    if (currentStateResult.status === "missing") {
      const candidateState = parseJsonObject(toolInput.content);
      if (toolName !== "Write" || !validateInitialCurrentState(candidateState, runtimeTarget.changeId)) {
        return deny("CurrentState 只能由 CCR 以 canonical PLAN_DRAFT 內容初始化。");
      }
      return allow("CCR 正在初始化 canonical PLAN_DRAFT CurrentState。");
    }
    if (currentStateResult.status === "invalid") {
      return deny("既有 CurrentState 無效或損壞，不得視為首次初始化覆寫。");
    }
    const currentState = currentStateResult.value;
    if (currentState.currentOwner !== "CCR" || currentState.terminalStatus !== "NON_TERMINAL") {
      return deny("CCR 目前不持有 CurrentState 寫入權，或 Change 已終止。");
    }
    return allow("CCR 正在更新自己持有的 CurrentState。");
  }

  if (runtimeTarget?.artifactPath.startsWith("artifacts/")) {
    const artifactName = path.posix.basename(runtimeTarget.artifactPath);
    const currentStateResult = await readCurrentState(workspaceRoot, runtimeTarget.changeId);
    if (currentStateResult.status === "missing") {
      return deny("缺少合法 CurrentState，Runtime Artifact 寫入必須 fail-closed。");
    }
    if (currentStateResult.status === "invalid") {
      return deny("CurrentState 無效或損壞，Runtime Artifact 寫入必須 fail-closed。");
    }
    const currentState = currentStateResult.value;
    if (
      currentState.currentOwner !== "CCR" ||
      currentState.terminalStatus !== "NON_TERMINAL" ||
      !CCR_RUNTIME_ARTIFACT_PATTERN.test(artifactName)
    ) {
      return deny("目標不是 CCR 在目前 owner/phase 可產生的 Runtime Artifact。");
    }
    return allow("CCR 正在寫入 coordinator-owned Runtime Artifact。");
  }

  return deny(`目標 ${target.relativeTarget} 不屬於 CCR 的角色寫入範圍。`);
}

export async function evaluateCcrToolUse(event, { workspaceRoot } = {}) {
  if (!isRecord(event) || typeof event.tool_name !== "string" || !isRecord(event.tool_input)) {
    return deny("Hook input 格式不合法。");
  }

  const resolvedWorkspaceRoot = path.resolve(
    workspaceRoot ?? process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd(),
  );
  const toolName = event.tool_name;

  if (toolName === "Bash") {
    const implementerGrant = await resolveCcrImplementerGrant(resolvedWorkspaceRoot);
    return implementerGrant
        ? allow(`CCR 以 implementation_secondary 執行 ${implementerGrant.handoffId}；Shell 交由一般權限確認。`)
        : deny("Bash 無法可靠證明不會繞過角色寫入邊界。");
  }

  if (toolName === "NotebookEdit") {
    return deny("NotebookEdit 無法可靠證明不會繞過角色寫入邊界。");
  }

  if (toolName.startsWith("mcp__")) {
    return deny(`MCP tool ${toolName} 無法由名稱可靠證明沒有外部副作用。`);
  }

  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write") {
    return evaluateFileWrite(toolName, event.tool_input, resolvedWorkspaceRoot);
  }

  return allow("此工具不屬於 CCR 寫入守門範圍。");
}

async function readHookInput() {
  process.stdin.setEncoding("utf8");
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
    if (Buffer.byteLength(rawInput, "utf8") > MAX_HOOK_INPUT_BYTES) {
      throw new Error("Hook input exceeds the size limit.");
    }
  }
  const parsedInput = JSON.parse(rawInput);
  if (!isRecord(parsedInput)) {
    throw new Error("Hook input must be a JSON object.");
  }
  return parsedInput;
}

async function main() {
  let result;
  try {
    const event = await readHookInput();
    result = await evaluateCcrToolUse(event);
  } catch (error) {
    result = deny(`CCR 寫入守門發生錯誤：${error instanceof Error ? error.message : "unknown error"}。`);
  }

  if (result.decision !== "deny") {
    return;
  }

  process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
