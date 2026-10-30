import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateCcrToolUse } from "./ccr-role-write-guard.mjs";

const AUTHORIZED_HANDOFF_ID = "handoff-codex-to-ccr-implementation-001";

async function createWorkspaceWithState({
  changeId = "example-change",
  runId = "run-001",
  currentPhase = "PLAN_DRAFT",
  currentOwner = "CCR",
  terminalStatus = "NON_TERMINAL",
  latestHandoff,
} = {}) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ccr-write-guard-"));
  const runtimeDirectory = path.join(workspaceRoot, ".agent-runtime", changeId);
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    path.join(runtimeDirectory, "current-state.json"),
    JSON.stringify({ changeId, runId, currentPhase, currentOwner, terminalStatus, latestHandoff }),
    "utf8",
  );
  return { changeId, workspaceRoot };
}

async function writeMasterAuthorization(workspaceRoot, overrides = {}) {
  const authorization = {
    schemaVersion: "1.0.0",
    rolePolicyVersion: "2",
    authorizationId: "master-auth-example-change-001",
    grantedBy: "Master",
    grantedAt: "2026-10-22T09:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    changeId: "example-change",
    runId: "run-001",
    handoffId: AUTHORIZED_HANDOFF_ID,
    grantee: "CCR",
    actingRole: "implementation_secondary",
    grants: ["secondary_takeover"],
    writeScope: ["tools/qwen-capture-adapter.mjs", "tools/fixtures/"],
    ...overrides,
  };
  await mkdir(path.join(workspaceRoot, ".agent-runtime"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".agent-runtime", "master-authorization.json"),
    typeof overrides === "string" ? overrides : JSON.stringify(authorization),
    "utf8",
  );
}

async function createAuthorizedWorkspace({ state = {}, authorization = {} } = {}) {
  const workspace = await createWorkspaceWithState({
    currentPhase: "IMPLEMENTING",
    latestHandoff: {
      handoffId: AUTHORIZED_HANDOFF_ID,
      stage: "apply-change",
      from: "Codex",
      to: "CCR",
      status: "IN_PROGRESS",
      authorizationRef: "master-authorization.json#master-auth-example-change-001",
    },
    ...state,
  });
  await writeMasterAuthorization(workspace.workspaceRoot, authorization);
  return workspace;
}

function writeEvent(workspaceRoot, ...segments) {
  return {
    tool_name: "Write",
    tool_input: { file_path: path.join(workspaceRoot, ...segments), content: "content" },
  };
}

test("拒絕 CCR 修改 application code，即使只改一行", async () => {
  const { workspaceRoot } = await createWorkspaceWithState({
    currentPhase: "READY_FOR_READINESS_CHECK",
  });

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(workspaceRoot, "backend", "src", "index.ts"),
        old_string: "before",
        new_string: "after",
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /Handoff/);
});

test("拒絕 CCR 在非 PLAN_DRAFT 階段修改 OpenSpec delta", async () => {
  const { changeId, workspaceRoot } = await createWorkspaceWithState({
    currentPhase: "READY_FOR_READINESS_CHECK",
  });

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(workspaceRoot, "openspec", "changes", changeId, "design.md"),
        content: "small edit",
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /PLAN_DRAFT/);
});

test("拒絕 CCR 在 owner 不符時修改 OpenSpec delta", async () => {
  const { changeId, workspaceRoot } = await createWorkspaceWithState({
    currentOwner: "Qwen",
  });

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(workspaceRoot, "openspec", "changes", changeId, "tasks.md"),
        content: "- [ ] task",
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /currentOwner/);
});

test("缺少 CurrentState 時 fail-closed，不猜測寫入權", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ccr-write-guard-"));

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(workspaceRoot, "openspec", "changes", "missing-state", "proposal.md"),
        content: "proposal",
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /CurrentState/);
});

test("允許 CCR 在 PLAN_DRAFT 且持有 owner 時寫入該 Change artifacts", async () => {
  const { changeId, workspaceRoot } = await createWorkspaceWithState();

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(workspaceRoot, "openspec", "changes", changeId, "proposal.md"),
        content: "proposal",
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "allow");
});

test("允許 CCR 初始化合法的 PLAN_DRAFT CurrentState", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ccr-write-guard-"));
  const changeId = "new-change";

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(
          workspaceRoot,
          ".agent-runtime",
          changeId,
          "current-state.json",
        ),
        content: JSON.stringify({
          schemaVersion: "1.0.0",
          changeId,
          runId: "run-001",
          currentPhase: "PLAN_DRAFT",
          currentOwner: "CCR",
          attempt: 1,
          latestArtifactRefs: {},
          latestHandoff: {},
          gateStatus: {
            proposalApproved: false,
            reviewPassed: false,
            implementationVerified: false,
            readinessConfirmed: false,
          },
          blockers: [],
          nextActions: [],
          updatedAt: "2026-08-28T00:00:00.000Z",
          terminalStatus: "NON_TERMINAL",
        }),
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "allow");
});

test("拒絕將已存在但損壞的 CurrentState 當成首次初始化", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ccr-write-guard-"));
  const changeId = "broken-state";
  const runtimeDirectory = path.join(workspaceRoot, ".agent-runtime", changeId);
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "current-state.json"), "{broken", "utf8");

  const result = await evaluateCcrToolUse(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(runtimeDirectory, "current-state.json"),
        content: JSON.stringify({
          schemaVersion: "1.0.0",
          changeId,
          runId: "run-001",
          currentPhase: "PLAN_DRAFT",
          currentOwner: "CCR",
          attempt: 1,
          latestArtifactRefs: {},
          latestHandoff: {},
          gateStatus: {},
          blockers: [],
          nextActions: [],
          updatedAt: "2026-08-28T00:00:00.000Z",
          terminalStatus: "NON_TERMINAL",
        }),
      },
    },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /無效|損壞/);
});

test("拒絕 CCR 使用 Bash、MultiEdit 或 MCP 寫入繞過檔案守門", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ccr-write-guard-"));

  const bashResult = await evaluateCcrToolUse(
    { tool_name: "Bash", tool_input: { command: "echo bypass > backend/src/index.ts" } },
    { workspaceRoot },
  );
  const mcpResult = await evaluateCcrToolUse(
    {
      tool_name: "mcp__filesystem__write_file",
      tool_input: { path: "backend/src/index.ts", content: "bypass" },
    },
    { workspaceRoot },
  );
  const multiEditResult = await evaluateCcrToolUse(
    {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(workspaceRoot, "backend", "src", "index.ts"),
        edits: [{ old_string: "before", new_string: "after" }],
      },
    },
    { workspaceRoot },
  );

  assert.equal(bashResult.decision, "deny");
  assert.equal(mcpResult.decision, "deny");
  assert.equal(multiEditResult.decision, "deny");
});

test("Master 授權有效時允許 CCR 以 implementation_secondary 寫入 writeScope 內檔案", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();

  const fileResult = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "tools", "qwen-capture-adapter.mjs"),
    { workspaceRoot },
  );
  const directoryResult = await evaluateCcrToolUse(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(workspaceRoot, "tools", "fixtures", "qwen-capture", "result.ndjson"),
        old_string: "before",
        new_string: "after",
      },
    },
    { workspaceRoot },
  );
  const multiEditResult = await evaluateCcrToolUse(
    {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(workspaceRoot, "tools", "qwen-capture-adapter.mjs"),
        edits: [{ old_string: "before", new_string: "after" }],
      },
    },
    { workspaceRoot },
  );

  assert.equal(fileResult.decision, "allow");
  assert.match(fileResult.reason, new RegExp(AUTHORIZED_HANDOFF_ID));
  assert.equal(directoryResult.decision, "allow");
  assert.equal(multiEditResult.decision, "allow");
});

test("Master 授權有效時仍拒絕 writeScope 外的路徑", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();

  const outsideResult = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "backend", "src", "index.ts"),
    { workspaceRoot },
  );
  const siblingPrefixResult = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "tools", "fixtures-extra", "data.json"),
    { workspaceRoot },
  );
  const exactFileSuffixResult = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "tools", "qwen-capture-adapter.mjs.bak"),
    { workspaceRoot },
  );

  assert.equal(outsideResult.decision, "deny");
  assert.equal(siblingPrefixResult.decision, "deny");
  assert.equal(exactFileSuffixResult.decision, "deny");
});

test("Master 授權不擴張 OpenSpec delta 的 PLAN_DRAFT 限制", async () => {
  const { changeId, workspaceRoot } = await createAuthorizedWorkspace();

  const result = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "openspec", "changes", changeId, "design.md"),
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /PLAN_DRAFT/);
});

test("Master 授權內容不符時 fail-closed", async () => {
  const cases = [
    ["已過期", { expiresAt: "2000-01-01T00:00:00.000Z" }],
    ["expiresAt 無法解析", { expiresAt: "not-a-date" }],
    ["grantedBy 不是 Master", { grantedBy: "CCR" }],
    ["grantee 不是 CCR", { grantee: "Codex" }],
    ["actingRole 不是 implementation_secondary", { actingRole: "planning_secondary" }],
    ["grants 只有 self_acceptance", { grants: ["self_acceptance"] }],
    ["rolePolicyVersion 不是 2", { rolePolicyVersion: "1" }],
    ["changeId 不一致", { changeId: "other-change" }],
    ["changeId 含路徑穿越", { changeId: "../example-change" }],
    ["runId 不一致", { runId: "run-999" }],
    ["handoffId 不一致", { handoffId: "handoff-other" }],
    ["writeScope 為空", { writeScope: [] }],
    ["writeScope 含 ..", { writeScope: ["tools/qwen-capture-adapter.mjs", "../outside/"] }],
    ["writeScope 含絕對路徑", { writeScope: ["tools/qwen-capture-adapter.mjs", "/etc/"] }],
    ["writeScope 含磁碟代號", { writeScope: ["tools/qwen-capture-adapter.mjs", "C:/Windows/"] }],
  ];

  for (const [label, authorization] of cases) {
    const { workspaceRoot } = await createAuthorizedWorkspace({ authorization });
    const result = await evaluateCcrToolUse(
      writeEvent(workspaceRoot, "tools", "qwen-capture-adapter.mjs"),
      { workspaceRoot },
    );
    assert.equal(result.decision, "deny", label);
  }
});

test("CurrentState 與授權不一致時 fail-closed", async () => {
  const cases = [
    ["owner 不是 CCR", { currentOwner: "Codex" }],
    ["Change 已終止", { terminalStatus: "COMPLETED" }],
    [
      "latestHandoff 不是交給 CCR",
      {
        latestHandoff: {
          handoffId: AUTHORIZED_HANDOFF_ID,
          stage: "apply-change",
          from: "CCR",
          to: "Codex",
          status: "IN_PROGRESS",
        },
      },
    ],
    [
      "latestHandoff 已完成",
      {
        latestHandoff: {
          handoffId: AUTHORIZED_HANDOFF_ID,
          stage: "apply-change",
          from: "Codex",
          to: "CCR",
          status: "COMPLETED",
        },
      },
    ],
    ["缺少 latestHandoff", { latestHandoff: undefined }],
  ];

  for (const [label, state] of cases) {
    const { workspaceRoot } = await createAuthorizedWorkspace({ state });
    const result = await evaluateCcrToolUse(
      writeEvent(workspaceRoot, "tools", "qwen-capture-adapter.mjs"),
      { workspaceRoot },
    );
    assert.equal(result.decision, "deny", label);
  }
});

test("Master 授權檔損壞時 fail-closed", async () => {
  const { workspaceRoot } = await createWorkspaceWithState({
    currentPhase: "IMPLEMENTING",
    latestHandoff: {
      handoffId: AUTHORIZED_HANDOFF_ID,
      stage: "apply-change",
      from: "Codex",
      to: "CCR",
      status: "IN_PROGRESS",
    },
  });
  await writeMasterAuthorization(workspaceRoot, "{broken");

  const result = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, "tools", "qwen-capture-adapter.mjs"),
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
});

test("即使 writeScope 涵蓋，CCR 也不得修改守門、宿主設定或 Master 授權", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace({
    authorization: {
      writeScope: [
        ".claude/",
        ".claude/hooks/",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".agent-runtime/master-authorization.json",
      ],
    },
  });

  const targets = [
    [".claude", "hooks", "ccr-role-write-guard.mjs"],
    [".claude", "hooks", "ccr-role-write-guard.test.mjs"],
    [".claude", "settings.json"],
    [".claude", "settings.local.json"],
    [".agent-runtime", "master-authorization.json"],
  ];

  for (const segments of targets) {
    const result = await evaluateCcrToolUse(writeEvent(workspaceRoot, ...segments), {
      workspaceRoot,
    });
    assert.equal(result.decision, "deny", segments.join("/"));
  }
});

test("沒有 Master 授權時 CCR 不得寫入 Master 授權檔", async () => {
  const { workspaceRoot } = await createWorkspaceWithState();

  const result = await evaluateCcrToolUse(
    writeEvent(workspaceRoot, ".agent-runtime", "master-authorization.json"),
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
});

test("Master 授權有效時允許 Bash，但仍拒絕 NotebookEdit 與 MCP", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();

  const bashResult = await evaluateCcrToolUse(
    { tool_name: "Bash", tool_input: { command: "node --test tools/qwen-capture-adapter.test.mjs" } },
    { workspaceRoot },
  );
  const notebookResult = await evaluateCcrToolUse(
    {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: path.join(workspaceRoot, "tools", "fixtures", "a.ipynb") },
    },
    { workspaceRoot },
  );
  const mcpResult = await evaluateCcrToolUse(
    {
      tool_name: "mcp__filesystem__write_file",
      tool_input: { path: "tools/qwen-capture-adapter.mjs", content: "bypass" },
    },
    { workspaceRoot },
  );

  assert.equal(bashResult.decision, "allow");
  assert.match(bashResult.reason, new RegExp(AUTHORIZED_HANDOFF_ID));
  assert.equal(notebookResult.decision, "deny");
  assert.equal(mcpResult.decision, "deny");
});

test("Master 授權失效後 Bash 恢復拒絕", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace({
    authorization: { expiresAt: "2000-01-01T00:00:00.000Z" },
  });

  const result = await evaluateCcrToolUse(
    { tool_name: "Bash", tool_input: { command: "echo hi" } },
    { workspaceRoot },
  );

  assert.equal(result.decision, "deny");
});

test("Qwen 審查工作階段維持 plan 模式", async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
  const qwenSettings = JSON.parse(
    await readFile(path.join(workspaceRoot, ".qwen", "settings.json"), "utf8"),
  );

  assert.equal(qwenSettings.tools.approvalMode, "plan");
});

test("共享 Claude hook 只攔截檔案寫入工具與 Bash，不攔截 MCP", async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
  const settings = JSON.parse(
      await readFile(path.join(workspaceRoot, ".claude", "settings.json"), "utf8"),
  );
  const matcher = settings.hooks.PreToolUse[0].matcher;

  assert.deepEqual(
      matcher.split("|").sort(),
      ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"],
  );
});

test("容器授權依 key 匹配，損壞 entry 不得部分採用", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();
  const file = path.join(workspaceRoot, ".agent-runtime/master-authorization.json");
  const entry = JSON.parse(await readFile(file, "utf8"));
  const container = { schemaVersion: "2", authorizations: { [entry.authorizationId]: entry } };
  await writeFile(file, JSON.stringify(container));
  assert.equal((await evaluateCcrToolUse(writeEvent(workspaceRoot, "tools/qwen-capture-adapter.mjs"), { workspaceRoot })).decision, "allow");
  container.authorizations.broken = { authorizationId: "broken" };
  await writeFile(file, JSON.stringify(container));
  assert.equal((await evaluateCcrToolUse(writeEvent(workspaceRoot, "tools/qwen-capture-adapter.mjs"), { workspaceRoot })).decision, "deny");
});

test("有效授權也不得透過 Bash 碰觸授權檔或執行 GC", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();
  for (const command of ["echo x > .agent-runtime/master-authorization.json", "node tools/master-auth-gc.mjs --apply"]) {
    assert.equal((await evaluateCcrToolUse({ tool_name: "Bash", tool_input: { command } }, { workspaceRoot })).decision, "deny");
  }
});

test("不同 change 的多筆有效授權重疊時拒絕，不重疊時只取目標授權", async () => {
  const { workspaceRoot } = await createAuthorizedWorkspace();
  const file = path.join(workspaceRoot, ".agent-runtime/master-authorization.json");
  const first = JSON.parse(await readFile(file, "utf8"));
  const second = { ...first, authorizationId: "second", changeId: "second-change" };
  const state = JSON.parse(await readFile(path.join(workspaceRoot, ".agent-runtime/example-change/current-state.json"), "utf8"));
  state.changeId = second.changeId;
  state.latestHandoff.authorizationRef = "master-authorization.json#second";
  await mkdir(path.join(workspaceRoot, ".agent-runtime/second-change"));
  await writeFile(path.join(workspaceRoot, ".agent-runtime/second-change/current-state.json"), JSON.stringify(state));
  const container = { schemaVersion: "2", authorizations: { [first.authorizationId]: first, second } };
  await writeFile(file, JSON.stringify(container));
  const evaluate = () => evaluateCcrToolUse(writeEvent(workspaceRoot, "tools/qwen-capture-adapter.mjs"), { workspaceRoot });
  assert.match((await evaluate()).reason, /ambiguous_authorization/);
  second.writeScope = ["other/"];
  await writeFile(file, JSON.stringify(container));
  assert.equal((await evaluate()).decision, "allow");
});

for (const ref of [undefined, "master-authorization.json", "master-authorization.json#missing"]) {
  test(`授權引用 ${ref} 必須拒絕`, async () => {
    const { workspaceRoot } = await createAuthorizedWorkspace();
    const file = path.join(workspaceRoot, ".agent-runtime/example-change/current-state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.latestHandoff.authorizationRef = ref;
    await writeFile(file, JSON.stringify(state));
    assert.equal((await evaluateCcrToolUse(writeEvent(workspaceRoot, "tools/qwen-capture-adapter.mjs"), { workspaceRoot })).decision, "deny");
  });
}

for (const tool_name of ["Write", "Edit", "MultiEdit"]) {
  test(`${tool_name} 不得寫入授權容器`, async () => {
    const { workspaceRoot } = await createAuthorizedWorkspace();
    assert.equal((await evaluateCcrToolUse({ tool_name, tool_input: { file_path: ".agent-runtime/master-authorization.json" } }, { workspaceRoot })).decision, "deny");
  });
}
