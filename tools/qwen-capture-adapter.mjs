#!/usr/bin/env node

import { readRequest, auditReadScope } from "./qwen-read-scope.mjs";
import { spawn } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// This repository tool uses the validator installed with the backend tooling.
// Resolve from the adapter location, not the possibly temporary capture workspace.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const Ajv = requireBackend("ajv/dist/2020.js").default;
const ajv = new Ajv({ strict: false, allErrors: true });
requireBackend("ajv-formats")(ajv);
const contractRoot = new URL("../openspec/specs/", import.meta.url);
const contractValidators = new Map();
for (const name of ["current-state", "handoff", "agent-result"]) {
  contractValidators.set(name, ajv.compile(JSON.parse(readFileSync(
    new URL(`${name}-contract/${name}.schema.json`, contractRoot), "utf8",
  ))));
}

function validateContract(name, value) {
  const validate = contractValidators.get(name);
  if (!validate(value)) {
    // Schema locations are useful diagnostics; never echo input values.
    const errors = validate.errors.map(error => `${error.instancePath || "/"}: ${error.message}`).join("; ");
    throw new Error(`${name} schema validation failed: ${errors}`);
  }
}

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

  const fenced = [...output.matchAll(/```([a-z0-9_-]*)\s*([\s\S]*?)```/gi)];
  if (fenced.length === 0) return parseJsonObject(output.trim());
  const jsonBlocks = fenced.filter(([, tag]) => tag === "" || tag.toLowerCase() === "json").map(([, , body]) => body.trim());
  // Findings may quote code or sample JSON, so only a block that declares itself a review_result is the result.
  const reviews = jsonBlocks.flatMap(body => {
    try {
      const value = parseJsonObject(body);
      return value.kind === EXPECTED_KIND ? [value] : [];
    } catch { return []; }
  });
  if (reviews.length === 1) return reviews[0];
  if (reviews.length > 1 || jsonBlocks.length > 1) throw new Error("Multiple JSON candidates.");
  if (jsonBlocks.length === 0) throw new Error("No JSON candidate.");
  return parseJsonObject(jsonBlocks[0]);
}

function emptyObservations() {
  return { parentSessionId: null, model: null, provider: null, approvalMode: null, qwenCodeVersion: null,
    effectiveTools: null, subagents: [], tools: [], readPaths: [], unknownEventCount: 0,
    notObserved: ["parentSessionId", "model", "provider", "approvalMode", "subagents"], conflicts: [] };
}

export const REVIEWER_AGENT_NAME = "secondary-architecture-reviewer";

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(block => block?.type === "text" && typeof block.text === "string")
      .map(block => block.text).join("");
  }
  return null;
}

// Qwen 0.25.3 stream-json (verified against the installed CLI source):
// - every message carries the parent session_id; subagent messages are distinguished only by
//   parent_tool_use_id, which is the call id of the parent's `agent` tool_use;
// - the only success `result` event belongs to the parent session;
// - the reviewer's output reaches the parent as the tool_result of that `agent` call.
// The reviewer's tool_result is therefore the authoritative review; parent copies must match it.
// Event metadata, never message text, establishes provenance.
export function parseCaptureOutput(output, format = "text") {
  const observed = emptyObservations();
  if (format === "text") return { reviewResult: extractJsonObjectFromOutput(output), observed, reviewSource: null };
  if (!["json", "stream-json"].includes(format)) throw new Error("Unsupported output format.");
  let events;
  try {
    const raw = stripByteOrderMark(output).trim();
    if (!raw) throw new Error();
    const value = format === "json" ? JSON.parse(raw) : null;
    events = format === "json" ? (Array.isArray(value) ? value : [value])
      : raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  } catch { throw new Error("Malformed JSON capture."); }
  const authoritative = [];
  const copies = [];
  const metadata = value => typeof value === "string" && value.length > 0 && value.length <= 256
    && !containsSecret(value) ? value : null;
  const observe = (key, value) => {
    const safe = metadata(value);
    if (safe === null) return;
    if (observed[key] !== null && observed[key] !== safe) observed.conflicts.push(key);
    else observed[key] = safe;
  };
  const toReview = value => {
    if (value === undefined || value === null || value === "") return null;
    try {
      const review = typeof value === "string" ? extractJsonObjectFromOutput(value) : value;
      return review?.kind === "review_result" ? review : null;
    } catch { return null; }
  };
  const fail = message => {
    const error = new Error(message);
    error.observed = observed;
    throw error;
  };
  const isParentEvent = event => event.session_id === observed.parentSessionId && !event.parent_tool_use_id;
  const pendingResults = [];
  // Qwen emits a single success result per run; more than one is never a valid capture.
  let resultReviewEvents = 0;
  for (const event of events) {
    if (!isPlainObject(event)) throw new Error("Malformed event object.");
    if (event.type === "system" && event.subtype === "init") {
      if (!event.parent_tool_use_id) {
        observe("parentSessionId", event.session_id);
        observe("model", event.model);
        observe("approvalMode", event.permission_mode);
        observe("qwenCodeVersion", event.qwen_code_version);
        if (Array.isArray(event.tools)) {
          observed.effectiveTools = event.tools.map(metadata).filter(name => name !== null);
        }
      }
    } else if (!["assistant", "user", "result", "stream_event", "tool_progress"].includes(event.type)) {
      observed.unknownEventCount++;
    }
    if (event.type === "result") {
      if (event.is_error) observed.conflicts.push("result_error");
      // Qwen emits structured_result and its serialized result in the same event.
      if (event.structured_result !== undefined && event.result !== undefined) {
        let copy;
        try { copy = typeof event.result === "string" ? JSON.parse(event.result) : event.result; } catch { /* mismatch below */ }
        if (JSON.stringify(copy) !== JSON.stringify(event.structured_result)) throw new Error("Conflicting result representations.");
      }
      const review = toReview(event.structured_result ?? event.result);
      if (review) {
        copies.push(review);
        resultReviewEvents++;
      }
    }
    if (event.type !== "assistant" && event.type !== "user") continue;
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === "tool_use" && event.type === "assistant") {
        const name = metadata(block.name);
        const tool = { id: metadata(block.id), name, owner: null, status: "called",
          sessionId: metadata(event.session_id), parentToolUseId: metadata(event.parent_tool_use_id) };
        // The skill name is call metadata, not file content; it decides whether the load is read-only.
        if (name?.toLowerCase() === "skill") tool.skillName = metadata(block.input?.skill);
        const request = readRequest(name?.toLowerCase(), block.input);
        if (request) {
          if (request.paths.some(containsSecret)) { request.paths = []; request.proven = false; }
          tool.readRequest = request;
        }
        observed.tools.push(tool);
        if (name?.toLowerCase() === "agent" && isParentEvent(event)) {
          observed.subagents.push({ name: metadata(block.input?.subagent_type), toolUseId: tool.id });
        }
        if (name === "structured_output") {
          const review = toReview(block.input);
          if (review) copies.push(review);
        }
      } else if (block.type === "tool_result") {
        const tool = observed.tools.find(item => item.id !== null && item.id === block.tool_use_id);
        if (tool) tool.status = block.is_error ? "failed" : "completed";
        else observed.conflicts.push("unmatched_tool_result");
        if (isParentEvent(event) && !block.is_error) pendingResults.push({ toolUseId: block.tool_use_id, content: block.content });
      }
    }
  }
  const reviewerCalls = observed.subagents.filter(agent => agent.name === REVIEWER_AGENT_NAME && agent.toolUseId !== null);
  for (const { toolUseId, content } of pendingResults) {
    if (!reviewerCalls.some(agent => agent.toolUseId === toolUseId)) continue;
    const review = toReview(toolResultText(content));
    if (review) authoritative.push({ review, toolUseId });
  }
  const subagentIds = new Set(observed.subagents.map(agent => agent.toolUseId).filter(id => id !== null));
  const reviewerIds = new Set(reviewerCalls.map(agent => agent.toolUseId));
  for (const tool of observed.tools) {
    tool.owner = tool.parentToolUseId !== null
      ? (reviewerIds.has(tool.parentToolUseId) ? "subagent" : subagentIds.has(tool.parentToolUseId) ? "other_subagent" : null)
      : tool.sessionId !== null && tool.sessionId === observed.parentSessionId ? "parent" : null;
  }
  observed.notObserved = ["parentSessionId", "model", "provider", "approvalMode", "qwenCodeVersion", "effectiveTools"]
    .filter(key => observed[key] === null);
  if (!observed.subagents.length) observed.notObserved.push("subagents");
  for (const [index, agent] of observed.subagents.entries()) {
    for (const key of ["name", "toolUseId"]) {
      if (agent[key] === null) observed.notObserved.push(`subagents.${index}.${key}`);
    }
  }
  if (resultReviewEvents > 1) fail(`Expected at most one result event with a review; found ${resultReviewEvents}.`);
  if (authoritative.length > 1) fail(`Expected at most one reviewer tool_result review; found ${authoritative.length}.`);
  if (authoritative.length === 1) {
    const expected = JSON.stringify(authoritative[0].review);
    if (copies.some(copy => JSON.stringify(copy) !== expected)) fail("Parent review copy does not match the reviewer tool_result.");
    return { reviewResult: authoritative[0].review, observed,
      reviewSource: { toolUseId: authoritative[0].toolUseId, owner: "subagent" } };
  }
  // Without a reviewer tool_result the parent copy is kept for inspection but can never pass the gate.
  if (copies.length !== 1) fail(`Expected exactly one review_result candidate; found ${copies.length}.`);
  return { reviewResult: copies[0], observed, reviewSource: { toolUseId: null, owner: null } };
}

const WRITE_TOOLS = new Set([
  "write", "writefile", "write_file", "edit", "replace", "bash", "shell", "run_shell_command", "exec",
  "notebookedit", "notebook_edit", "save_memory", "manage_memory", "todo_write", "exit_plan_mode",
  "enter_worktree", "exit_worktree", "tool_call", "task_create", "task_update", "cron_create", "cron_delete",
]);
// Skills the reviewer contract (.qwen/agents/secondary-architecture-reviewer.md) requires it to load.
// Qwen declares the skill tool read-only, but an unknown skill name falls back to running a slash
// command, so only these names, confirmed by a successful tool_result, count as read-only.
export const REVIEWER_SKILL_NAMES = Object.freeze(["openspec-workflow-router", "secondary-architecture-reviewer"]);

function isReadOnlySkillLoad(tool) {
  return tool.name?.toLowerCase() === "skill" && REVIEWER_SKILL_NAMES.includes(tool.skillName)
    && tool.status === "completed";
}

// Controlled-launch provider evidence for Qwen 0.25.3. The adapter does not reproduce Qwen's runtime
// provider resolution (ModelsConfig.syncAfterAuthRefresh is stateful); it requires the qwen argv to
// pin --auth-type, --model and --openai-base-url to the expected values and checks every settings
// file Qwen reads for something that could override them: a modelProviders entry for the model
// (its baseUrl outranks the CLI value) or a conflicting security.auth.enforcedType. qwen-oauth
// ignores the CLI base URL, so it cannot be pinned this way.
const PROVIDER_ARG_ALIASES = Object.freeze({
  authType: ["--auth-type", "--authType"],
  model: ["--model", "-m"],
  baseUrl: ["--openai-base-url", "--openaiBaseUrl"],
});

function readQwenArg(args, aliases) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    for (const alias of aliases) {
      if (args[index] === alias) values.push(args[index + 1]);
      else if (args[index].startsWith(`${alias}=`)) values.push(args[index].slice(alias.length + 1));
    }
  }
  return values;
}

// Mirrors Storage.getGlobalQwenDir, getSystemSettingsPath, getSystemDefaultsPath and
// Storage#getWorkspaceSettingsPath in Qwen 0.25.3.
export function qwenSettingsPaths({ workspaceRoot, env = process.env, platform = os.platform(), homedir = os.homedir() }) {
  const system = env.QWEN_CODE_SYSTEM_SETTINGS_PATH || (platform === "darwin"
    ? "/Library/Application Support/QwenCode/settings.json"
    : platform === "win32" ? "C:\\ProgramData\\qwen-code\\settings.json" : "/etc/qwen-code/settings.json");
  const systemDefaults = env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), "system-defaults.json");
  let globalDir;
  if (env.QWEN_HOME) {
    const expanded = env.QWEN_HOME.startsWith("~") ? path.join(homedir, env.QWEN_HOME.slice(1)) : env.QWEN_HOME;
    globalDir = path.resolve(workspaceRoot, expanded);
  } else {
    globalDir = homedir ? path.join(homedir, ".qwen") : path.join(os.tmpdir(), ".qwen");
  }
  return [
    ["system", system],
    ["system-defaults", systemDefaults],
    ["user", path.join(globalDir, "settings.json")],
    ["workspace", path.join(workspaceRoot, ".qwen", "settings.json")],
  ];
}

// Qwen parses settings with strip-json-comments; strings are copied verbatim so `//` inside a URL survives.
function parseJsonWithComments(text) {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === "\\") { output += next ?? ""; index++; }
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      output += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) throw new Error("Unterminated comment.");
      index = end + 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(stripByteOrderMark(output));
}

export async function verifyProviderLaunch({ commandArgs = [], expected = null, workspaceRoot, env, platform, homedir }) {
  const conflicts = [];
  const evidence = { basis: "controlled-launch", wireObserved: false, authType: null, model: null, baseUrlHost: null,
    settingsFiles: [], conflicts, verified: false };
  if (!expected) {
    conflicts.push("expected_provider_not_supplied");
    return evidence;
  }
  const safe = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !containsSecret(value) ? value : null;
  evidence.authType = safe(expected.authType);
  evidence.model = safe(expected.model);
  try { evidence.baseUrlHost = safe(new URL(expected.baseUrl).hostname); } catch { /* reported below */ }
  if (!evidence.authType) conflicts.push("expected_auth_type_invalid");
  else if (evidence.authType === "qwen-oauth") conflicts.push("auth_type_not_cli_controllable");
  if (!evidence.model) conflicts.push("expected_model_invalid");
  if (!evidence.baseUrlHost) conflicts.push("expected_base_url_invalid");
  for (const [key, aliases] of Object.entries(PROVIDER_ARG_ALIASES)) {
    const values = readQwenArg(commandArgs, aliases);
    if (values.length !== 1 || values[0] !== expected[key]) conflicts.push(`argv_${key}_not_pinned`);
  }
  for (const [scope, file] of qwenSettingsPaths({ workspaceRoot, env, platform, homedir })) {
    const entry = { scope, present: false, parsed: null };
    evidence.settingsFiles.push(entry);
    let settings;
    try {
      settings = parseJsonWithComments(await readFile(file, "utf8"));
      entry.present = true;
      entry.parsed = true;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      entry.present = true;
      entry.parsed = false;
      conflicts.push(`${scope}_settings_unverifiable`);
      continue;
    }
    const enforced = settings?.security?.auth?.enforcedType;
    if (enforced !== undefined && enforced !== expected.authType) conflicts.push(`${scope}_enforced_type_conflict`);
    const providers = settings?.modelProviders;
    if (providers === undefined || providers === null) continue;
    if (!isPlainObject(providers)) {
      conflicts.push(`${scope}_model_providers_unrecognized`);
      continue;
    }
    // Any provider protocol counts. A matching entry wins over the CLI base URL, so it is accepted only
    // when its baseUrl is literally the pinned one; ids that cannot be compared literally are rejected.
    const overrides = Object.values(providers).filter(Array.isArray).flat()
      .some(item => typeof item?.id !== "string" || item.id.includes("$")
        || (item.id === expected.model && item.baseUrl !== expected.baseUrl));
    if (overrides) conflicts.push(`${scope}_model_provider_override`);
  }
  evidence.verified = conflicts.length === 0;
  return evidence;
}

// Qwen 0.25.3 reads context.fileFiltering. Directory searches stay certifiable only while
// .gitignore filtering and the ripgrep path remain enabled in every settings scope.
export async function verifySearchFiltering({ workspaceRoot, env, platform, homedir }) {
  for (const [, file] of qwenSettingsPaths({ workspaceRoot, env, platform, homedir })) {
    let settings;
    try { settings = parseJsonWithComments(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; return false; }
    if (settings?.context?.fileFiltering?.respectGitIgnore === false || settings?.tools?.useRipgrep === false) return false;
  }
  return true;
}

// The stream-json parsing and tool contracts above were verified against this Qwen release only.
export const VERIFIED_QWEN_VERSION = "0.25.3";

// On Windows the npm shim for qwen is a .cmd or .ps1 file, which spawn cannot start without a shell.
// The launch contract stays `-- qwen`; it resolves to `node <cli-entry.js>` and never uses a shell.
// QWEN_CLI_ENTRY pins one install: when set, it is the only candidate.
export async function resolveQwenCommand(command, commandArgs, { env = process.env, platform = process.platform } = {}) {
  if (command !== "qwen" || platform !== "win32") return { command, commandArgs };
  const pathValue = env.Path ?? env.PATH ?? "";
  const candidates = env.QWEN_CLI_ENTRY ? [env.QWEN_CLI_ENTRY]
    : pathValue.split(";").filter(Boolean).map(dir => path.join(dir, "node_modules", "@qwen-code", "qwen-code", "cli-entry.js"));
  for (const entry of candidates) {
    try {
      await access(entry, fsConstants.R_OK);
      return { command: process.execPath, commandArgs: [entry, ...commandArgs] };
    } catch { /* try the next PATH directory */ }
  }
  return { command, commandArgs };
}

function assessEvidence(observed, reviewSource, format) {
  const reasons = [];
  if (format === "text") reasons.push("text_has_no_isolation_evidence");
  if (observed.approvalMode !== "plan") reasons.push("parent_not_plan");
  if (!observed.parentSessionId) reasons.push("parent_session_not_observed");
  if (!observed.model) reasons.push("model_not_observed");
  if (observed.subagents.length !== 1 || observed.subagents[0]?.name !== REVIEWER_AGENT_NAME
      || reviewSource?.owner !== "subagent") reasons.push("reviewer_provenance_not_observed");
  if (observed.tools.some(tool => WRITE_TOOLS.has(tool.name?.toLowerCase()))) reasons.push("write_or_shell_tool_called");
  if (observed.tools.some(tool => tool.owner === null || tool.name === null)) reasons.push("tool_provenance_not_observed");
  // An unfamiliar tool might wrap writes or shell execution. Do not certify it as read-only.
  const readOnlyTools = new Set(["read_file", "grep_search", "glob", "list_directory",
    "agent", "structured_output"]);
  if (observed.tools.some(tool => !readOnlyTools.has(tool.name?.toLowerCase()) && !isReadOnlySkillLoad(tool))) {
    reasons.push("tool_readonly_not_proven");
  }
  if (observed.conflicts.length) reasons.push("conflicting_event_metadata");
  return { passed: reasons.length === 0, reasons };
}

const SECRET_PATTERNS = Object.freeze({
  provider_key: /\bsk-[a-zA-Z0-9_-]{12,}/i,
  cloud_access_key: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i,
  private_key: /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----/i,
  bearer_token: /\bBearer\s+[a-zA-Z0-9._~+/-]{8,}/i,
  jwt: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/i,
  credential_assignment: /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization|cookie)["']?\s*[:=]\s*["']?[^\s"',;}]{4,}/i,
});

function secretCategories(text) {
  return Object.entries(SECRET_PATTERNS).filter(([, pattern]) => pattern.test(text ?? "")).map(([category]) => category);
}

function containsSecret(text) {
  return secretCategories(text).length > 0;
}

const MAX_SECRET_HITS = 50;
// Diagnostics for suppressed output: rule category and event position, never the matched content.
function describeSecretHits(text, format) {
  const safeId = value => typeof value === "string" && /^[\w-]{1,128}$/u.test(value) ? value : null;
  const hits = [];
  let total = 0;
  for (const [index, line] of (text ?? "").split(/\r?\n/u).entries()) {
    const categories = secretCategories(line);
    if (!categories.length) continue;
    total++;
    if (hits.length === MAX_SECRET_HITS) continue;
    let event = null;
    if (format !== "text") { try { event = JSON.parse(line); } catch { /* position and category still help */ } }
    const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
    hits.push({ line: index + 1, categories, eventType: safeId(event?.type),
      blockTypes: blocks.map(block => safeId(block?.type)).filter(Boolean),
      toolUseIds: blocks.map(block => safeId(block?.tool_use_id ?? block?.id)).filter(Boolean) });
  }
  return { total, hits };
}

// Names fields and shapes only. Adapter messages may echo values, so suspect text is dropped.
function describeValidationFailure(error, parsed) {
  const candidate = parsed?.reviewResult;
  const safeKeys = value => isPlainObject(value) ? Object.keys(value).filter(key => /^[\w-]{1,64}$/u.test(key)).sort() : null;
  const message = error instanceof Error ? error.message.slice(0, 1000) : "unknown";
  return { message: containsSecret(message) ? "[redacted]" : message,
    candidateFound: isPlainObject(candidate), candidateOwner: parsed?.reviewSource?.owner ?? null,
    candidateKeys: safeKeys(candidate), payloadKeys: safeKeys(candidate?.payload) };
}

function redactArgv(argv) {
  let redactNext = false;
  let hostOnlyNext = false;
  // Base URLs may embed credentials or tenant paths; only the hostname is kept.
  const hostOnly = value => {
    try { return `[host:${new URL(value).hostname}]`; } catch { return "[REDACTED]"; }
  };
  return argv.map(arg => {
    if (redactNext) { redactNext = false; return "[REDACTED]"; }
    if (hostOnlyNext) { hostOnlyNext = false; return hostOnly(arg); }
    const baseUrlFlag = PROVIDER_ARG_ALIASES.baseUrl.find(alias => arg === alias || arg.startsWith(`${alias}=`));
    if (baseUrlFlag) {
      if (arg === baseUrlFlag) { hostOnlyNext = true; return arg; }
      return `${baseUrlFlag}=${hostOnly(arg.slice(baseUrlFlag.length + 1))}`;
    }
    if (/^--?[^=]*(?:key|token|secret|password|header)/i.test(arg)) {
      if (arg.includes("=")) return `${arg.split("=", 1)[0]}=[REDACTED]`;
      redactNext = true;
      return arg;
    }
    return containsSecret(arg) ? "[REDACTED]" : arg;
  });
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function serialize(value) { return typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`; }
function getOutputFormat(args) {
  let format = "text";
  for (let i = 0; i < args.length; i++) {
    if (["-o", "--output-format"].includes(args[i])) format = args[i + 1];
    else if (args[i].startsWith("--output-format=")) format = args[i].slice(16);
  }
  return format;
}
function versionArgs(args) {
  // Support `node /path/to/qwen/cli-entry.js ...` on Windows without invoking a shell.
  return args[0]?.endsWith("cli-entry.js") || args[0]?.endsWith("cli.js") ? [args[0], "--version"] : ["--version"];
}
async function assertAbsent(target) {
  try { await access(target); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Capture target already exists; refusing overwrite.");
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
  validateContract("agent-result", value);

  return value;
}

export async function captureQwenReviewResult({
  workspaceRoot = process.cwd(),
  changeId,
  runId,
  artifactId,
  stage = DEFAULT_STAGE,
  command,
  commandArgs = [],
  processResult,
  outputFormat,
  qwenVersion = null,
  fromFile = null,
  expectedProvider = null,
  settingsEnvironment = {},
  now = () => new Date(),
}) {
  validatePathSegment("changeId", changeId);
  if (typeof artifactId !== "string" || !/^[a-z0-9-]+$/.test(artifactId)) {
    throw new Error("artifactId is required and must contain only [a-z0-9-].");
  }
  requireNonEmptyString("runId", runId);
  requireNonEmptyString("stage", stage);
  if (stage !== "review-plan" && stage !== "review-result") throw new Error(`Unsupported review stage: ${stage}`);

  const root = path.resolve(workspaceRoot);
  const runtimeDir = path.join(root, ".agent-runtime", changeId);
  const artifactsDir = path.join(runtimeDir, "artifacts");
  const currentStatePath = path.join(runtimeDir, "current-state.json");
  const artifactPath = path.join(artifactsDir, `${artifactId}.json`);
  const capturePath = path.join(artifactsDir, `${artifactId}.capture.json`);
  const stdoutPath = path.join(artifactsDir, `${artifactId}.stdout.ndjson`);
  const stderrPath = path.join(artifactsDir, `${artifactId}.stderr.log`);

  ensureInside(root, runtimeDir);
  ensureInside(root, artifactsDir);
  ensureInside(root, currentStatePath);
  ensureInside(root, artifactPath);

  const canonicalRoot = await realpath(root);
  ensureInside(canonicalRoot, await realpath(runtimeDir));
  const lockPath = path.join(runtimeDir, "review.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: now().toISOString(), runId, artifactId }), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("review_lock_held");
    throw error;
  }
  try {
    ensureInside(canonicalRoot, await realpath(currentStatePath));
    const currentState = await readCurrentState(currentStatePath, { expectedChangeId: changeId, expectedRunId: runId });
    const reviewPhases = stage === "review-plan" ? ["PLAN_REVIEW"] : ["READY_FOR_REVIEW", "REVIEWING"];
    if (currentState.currentOwner !== "Qwen" || !reviewPhases.includes(currentState.currentPhase)) {
      throw new Error("CurrentState review owner/phase does not authorize capture.");
    }
    if (Object.values(currentState.latestArtifactRefs).some(ref => ref.artifactId === artifactId)) {
      throw new Error("artifactId already exists in CurrentState.");
    }
    await mkdir(artifactsDir, { recursive: true });
    ensureInside(await realpath(root), await realpath(artifactsDir));
    for (const target of [artifactPath, capturePath, stdoutPath, stderrPath]) await assertAbsent(target);
    const originalState = await readFile(currentStatePath, "utf8");
    const startedAt = now().toISOString();
    // Version lookup never uses review arguments, credentials or shell interpolation.
    if (!processResult && !fromFile) ({ command, commandArgs } = await resolveQwenCommand(command, commandArgs, settingsEnvironment));
    if (!processResult && !fromFile && qwenVersion === null) {
      const version = await runCommand(command, versionArgs(commandArgs), { cwd: root });
      if (version.exitCode === 0 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(version.stdout.trim())) qwenVersion = version.stdout.trim();
    }
    const result = processResult ?? (fromFile
      ? { exitCode: 0, stdout: await readFile(fromFile, "utf8"), stderr: "", signal: null }
      : await runCommand(command, commandArgs, { cwd: root }));
    const format = outputFormat ?? getOutputFormat(commandArgs);
    let parsed;
    let partialObserved;
    let captureError = result.exitCode !== 0 ? "process_nonzero_exit" : null;
    try { parsed = parseCaptureOutput(result.stdout, format); }
    catch (error) { partialObserved = error.observed; captureError ??= "output_extraction_failed"; }
    const observed = parsed?.observed ?? partialObserved ?? emptyObservations();
    const suppressed = { stdout: containsSecret(result.stdout), stderr: containsSecret(result.stderr) };
    observed.provider = await verifyProviderLaunch({ commandArgs: fromFile ? [] : commandArgs,
      expected: expectedProvider, workspaceRoot: root, ...settingsEnvironment });
    if (observed.provider.verified) observed.notObserved = observed.notObserved.filter(key => key !== "provider");
    const searchFilteringProven = await verifySearchFiltering({ workspaceRoot: root, ...settingsEnvironment });
    const readScopeReasons = await auditReadScope(observed, { root, changeId, runId, currentState, containsSecret, searchFilteringProven });
    const evidenceGate = assessEvidence(observed, parsed?.reviewSource, format);
    evidenceGate.reasons.push(...readScopeReasons);
    if (!observed.provider.verified) evidenceGate.reasons.push("provider_not_verified");
    else if (observed.model !== observed.provider.model) evidenceGate.reasons.push("model_differs_from_pinned_launch");
    if (observed.qwenCodeVersion !== VERIFIED_QWEN_VERSION) evidenceGate.reasons.push("qwen_version_unverified");
    if (suppressed.stdout || suppressed.stderr) evidenceGate.reasons.push("raw_output_contains_secret");
    if (captureError) evidenceGate.reasons.push(captureError);
    evidenceGate.passed = evidenceGate.reasons.length === 0;
    const reference = (id, target, kind = "evidence") => ({
      artifactId: id, changeId, runId, kind, relativePath: toPosixPath(path.relative(root, target)),
    });
    const evidence = {
      schemaVersion: "1.0.0", artifactId: `${artifactId}-capture`, changeId, runId, kind: "evidence",
      argv: redactArgv([command ?? (fromFile ? "from-file" : "injected-process"), ...commandArgs]),
      cwd: ".", qwenVersion: typeof qwenVersion === "string" && /^\d+\.\d+\.\d+[\w.+-]*$/.test(qwenVersion) ? qwenVersion : null,
      startedAt, endedAt: now().toISOString(),
      exitCode: result.exitCode, signal: result.signal ?? null, outputFormat: format,
      source: fromFile ? "from-file" : processResult ? "injected-process" : "child-process",
      hashes: { stdout: sha256(result.stdout), stderr: sha256(result.stderr), savedResult: null },
      spawnError: result.spawnError ?? null,
      redactedForSecret: suppressed,
      secretHits: { stdout: suppressed.stdout ? describeSecretHits(result.stdout, format) : null,
        stderr: suppressed.stderr ? describeSecretHits(result.stderr, "text") : null },
      observed, evidenceGate, error: captureError,
    };
    const evidenceEntries = () => [
      ...(!suppressed.stdout ? [[stdoutPath, result.stdout]] : []),
      ...(!suppressed.stderr ? [[stderrPath, result.stderr]] : []),
      [capturePath, evidence],
    ];
    if (captureError) {
      await writeCapture(evidenceEntries());
      throw new Error(`Capture failed: ${captureError}; evidence saved.`);
    }
    let reviewResult;
    try {
      reviewResult = validateReviewResult(parsed.reviewResult, {
        expectedChangeId: changeId, expectedRunId: runId, expectedStage: stage, expectedKind: EXPECTED_KIND,
      });
      if (reviewResult.artifactId !== artifactId) throw new Error("review_result artifactId does not match requested artifactId.");
    } catch (error) {
      evidence.error = "review_result_schema_or_artifactId_invalid";
      evidence.validationIssue = describeValidationFailure(error, parsed);
      evidence.evidenceGate = { passed: false, reasons: [...evidenceGate.reasons, evidence.error] };
      await writeCapture(evidenceEntries());
      throw new Error("Capture failed: review_result schema or artifactId invalid; evidence saved.");
    }
    if (containsSecret(JSON.stringify(reviewResult))) {
      evidence.error = "review_result_contains_secret";
      evidence.evidenceGate = { passed: false, reasons: [...evidenceGate.reasons, evidence.error] };
      await writeCapture(evidenceEntries());
      throw new Error("Capture failed: review_result contains secret; only safe evidence saved.");
    }
    const updatedState = applyVerdictTransition(currentState, reviewResult, {
      changeId,
      runId,
      relativePath: toPosixPath(path.relative(root, artifactPath)),
      now,
      effectiveVerdict: evidenceGate.passed ? reviewResult.payload.verdict : "INCOMPLETE",
    });
    const handoff = buildHandoff(currentState, updatedState, reviewResult);
    if (!evidenceGate.passed) handoff.reason = "Review evidence gate failed; CCR must recheck the review environment.";
    const handoffPath = path.join(artifactsDir, `${handoff.handoffId}.json`);
    await assertAbsent(handoffPath);
    updatedState.latestArtifactRefs.reviewCapture = reference(evidence.artifactId, capturePath);
    if (!suppressed.stdout) updatedState.latestArtifactRefs.reviewRawStdout = reference(`${artifactId}-stdout`, stdoutPath);
    else delete updatedState.latestArtifactRefs.reviewRawStdout;
    if (!suppressed.stderr) updatedState.latestArtifactRefs.reviewRawStderr = reference(`${artifactId}-stderr`, stderrPath);
    else delete updatedState.latestArtifactRefs.reviewRawStderr;
    updatedState.latestArtifactRefs.handoff = {
      artifactId: handoff.handoffId, changeId, runId, kind: "handoff",
      relativePath: toPosixPath(path.relative(root, handoffPath)),
    };
    validateContract("handoff", handoff);
    validateCanonicalCurrentState(updatedState, { expectedChangeId: changeId, expectedRunId: runId });
    for (const ref of handoff.requiredInputRefs) {
      validateArtifactPath(ref, changeId);
      const inputPath = path.resolve(root, ref.relativePath);
      ensureInside(root, inputPath);
      if (ref.artifactId === reviewResult.artifactId && inputPath === artifactPath) continue;
      await access(inputPath, fsConstants.R_OK);
      ensureInside(await realpath(root), await realpath(inputPath));
    }

    evidence.hashes.savedResult = sha256(serialize(reviewResult));
    if (await readFile(currentStatePath, "utf8") !== originalState) throw new Error("CurrentState changed during capture.");
    // Publish the state last, after all referenced documents have been staged.
    await writeCapture([
      ...evidenceEntries(), [artifactPath, reviewResult], [handoffPath, handoff], [currentStatePath, updatedState, originalState],
    ]);

    return {
      artifactPath,
      currentStatePath,
      handoffPath,
      capturePath,
      artifactReference: updatedState.latestArtifactRefs.reviewResult,
    };
  } finally {
    await unlink(lockPath);
  }
}

function applyVerdictTransition(currentState, reviewResult, { changeId, runId, relativePath, now, effectiveVerdict }) {
  const verdict = effectiveVerdict ?? reviewResult.payload.verdict;
  const stage = reviewResult.stage;
  const transition = resolveTransition(verdict, stage);
  const stageHandoff = buildStageHandoff(verdict, stage) ?? {
    stage: "readiness-check", from: "Qwen", to: "CCR", status: transition.handoffStatus,
  };

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
    latestHandoff: {
      handoffId: `handoff-${changeId}-${randomUUID()}`,
      ...stageHandoff,
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

function buildHandoff(currentState, updatedState, reviewResult) {
  const identity = updatedState.latestHandoff;
  const reviewRef = updatedState.latestArtifactRefs.reviewResult;
  const requiredInputRefs = [reviewRef];
  for (const ref of reviewResult.inputRefs) {
    if (!requiredInputRefs.some(input => input.artifactId === ref.artifactId)) requiredInputRefs.push(ref);
  }
  const implementation = identity.to === "Codex";
  return {
    schemaVersion: "1.0.0", ...identity,
    ...(currentState.rolePolicyVersion ? { rolePolicyVersion: currentState.rolePolicyVersion } : {}),
    changeId: currentState.changeId, runId: currentState.runId,
    reason: `Qwen ${reviewResult.stage}: ${reviewResult.payload.verdict}. Follow CurrentState owner and gates before execution.`,
    requiredInputRefs,
    expectedOutputKind: implementation ? "implementation_result" : "coordinator_result",
    onSuccess: {
      nextStage: implementation ? "READY_FOR_REVIEW" : "NEEDS_COORDINATOR_ARBITRATION",
      nextOwner: implementation ? "Qwen" : "CCR",
    },
    onFailure: { nextStage: "NEEDS_COORDINATOR_ARBITRATION", nextOwner: "CCR" },
    requiresHumanApproval: false,
    createdAt: updatedState.updatedAt,
  };
}

function validateArtifactPath(ref, changeId) {
  if (ref.changeId !== changeId || ref.relativePath.includes("..") || ref.relativePath.includes("\\")
      || !(ref.relativePath.startsWith(`openspec/changes/${changeId}/`) || ref.relativePath.startsWith(`.agent-runtime/${changeId}/`))
      || path.isAbsolute(ref.relativePath)) {
    throw new Error("Invalid handoff input reference.");
  }
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
      // CurrentState records blocking work; the original review retains Major.
      severity: "Blocker",
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

  validateContract("current-state", currentState);

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

async function writeCapture(entries) {
  const pending = [];
  const published = [];
  try {
    for (const [finalPath, value, previous] of entries) {
      if (previous === undefined) await assertAbsent(finalPath);
      pending.push({ finalPath, value, previous, tempPath: `${finalPath}.${randomUUID()}.tmp` });
    }
    for (const item of pending) {
      await writeFile(item.tempPath, serialize(item.value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    for (const item of pending) {
      if (item.previous === undefined) {
        // Hard-link publication is exclusive: rename would replace an existing artifact.
        await link(item.tempPath, item.finalPath);
      } else {
        if (await readFile(item.finalPath, "utf8") !== item.previous) throw new Error("CurrentState changed during publication.");
        await rename(item.tempPath, item.finalPath);
      }
      published.push(item);
    }
  } catch (error) {
    const failures = [error];
    for (const item of published.reverse()) {
      try {
        if (item.previous === undefined) await unlink(item.finalPath);
        else {
          await writeFile(item.tempPath, item.previous, { flag: "wx" });
          await rename(item.tempPath, item.finalPath);
        }
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Capture failed and rollback was incomplete.");
    throw error;
  } finally {
    for (const item of pending) {
      await unlink(item.tempPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
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
    child.on("error", error => resolve({ exitCode: 1, stdout, stderr, signal: null,
      spawnError: /^[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : "UNKNOWN" }));
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        signal,
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
    } else if (arg === "--artifact-id") {
      parsed.artifactId = value;
      index += 1;
    } else if (arg === "--output-format") {
      parsed.outputFormat = value;
      index += 1;
    } else if (arg === "--stage") {
      parsed.stage = value;
      index += 1;
    } else if (arg === "--from-file") {
      parsed.fromFile = value;
      index += 1;
    } else if (["--expected-auth-type", "--expected-model", "--expected-base-url"].includes(arg)) {
      const key = { "--expected-auth-type": "authType", "--expected-model": "model", "--expected-base-url": "baseUrl" }[arg];
      parsed.expectedProvider = { ...parsed.expectedProvider, [key]: value };
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
    "  node tools/qwen-capture-adapter.mjs --change-id <change-id> --run-id <run-id> --artifact-id <fresh-id> [--stage review-result] -- qwen <args...>",
    "  node tools/qwen-capture-adapter.mjs --change-id <change-id> --run-id <run-id> --artifact-id <fresh-id> [--stage review-plan] [--output-format stream-json] --from-file <capture-path>",
    "",
    "The adapter captures stdout from the command (or reads --from-file), extracts a review_result",
    "JSON object, validates changeId/runId/stage/kind/producer, then atomically writes:",
    "  .agent-runtime/<change-id>/artifacts/<artifactId>.json (exclusive creation)",
    "  <artifactId>.capture.json, <artifactId>.stdout.ndjson, <artifactId>.stderr.log",
    "Text/from-file captures never prove a live isolation probe; missing evidence routes INCOMPLETE.",
    "",
    "Options:",
    "  --from-file <path>  Read review_result from an existing JSON file instead of spawning a command.",
    "  --expected-auth-type <type> --expected-model <id> --expected-base-url <url>",
    "                      Provider the qwen argv must pin with --auth-type, --model and --openai-base-url.",
    "                      Without them, or when a settings file could override them, the evidence gate fails.",
  ].join("\n");
}

async function assertCurrentStateExists(workspaceRoot, changeId) {
  const currentStatePath = path.join(path.resolve(workspaceRoot), ".agent-runtime", changeId, "current-state.json");
  await access(currentStatePath, fsConstants.R_OK);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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

    if (!args.fromFile) {
      requireNonEmptyString("command", args.command);
    }

    const result = await captureQwenReviewResult(args);
    console.log(
      JSON.stringify(
        {
          ok: true,
          artifactPath: result.artifactPath,
          artifactReference: result.artifactReference,
          handoffPath: result.handoffPath,
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
