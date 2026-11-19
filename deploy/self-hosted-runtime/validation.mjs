import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const changeId = "spike-mit-langgraph-server";
export const runtime = `.agent-runtime/${changeId}`;
const statePath = path.join(root, runtime, "current-state.json");
const handoffPath = path.join(root, runtime, "artifacts/handoff-apply-change-002.json");
const requireBackend = createRequire(path.join(root, "backend/package.json"));
const parse = requireBackend("dotenv").parse;
export const privateEnv = Object.assign({}, ...[".env", "deploy/self-hosted-runtime/.env.spike.local"].map(p => parse(fs.readFileSync(path.join(root, p)))));
const secrets = new Set(Object.entries(privateEnv).filter(([key, value]) => /API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL/.test(key) && value.length >= 8).map(([, value]) => value));
export const compose = ["compose", "--env-file", ".env", "--env-file", "deploy/self-hosted-runtime/.env.spike.local", "--file", "deploy/self-hosted-runtime/compose.yaml"];
export function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [...secrets].sort((a,b) => b.length-a.length)) text = text.split(secret).join("[REDACTED]");
  return text;
}
export function guard() {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  if (state.changeId !== changeId || state.runId !== "run-001" || state.currentOwner !== "Codex"
      || !["READY_FOR_IMPLEMENTATION", "IMPLEMENTING"].includes(state.currentPhase)
      || state.latestHandoff.handoffId !== handoff.handoffId || handoff.handoffId !== "handoff-apply-change-002"
      || handoff.to !== "Codex" || !["PENDING", "IN_PROGRESS"].includes(handoff.status)) throw Error("role_gate_failed");
  return { state, handoff };
}
function write(file, text) {
  const target = path.resolve(root, file);
  if (!target.startsWith(path.join(root, runtime) + path.sep)) throw Error("artifact_scope_failed");
  if (redact(text) !== text) throw Error("secret_in_artifact");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
export function record(name, value) {
  const { state } = guard();
  if (!/^[a-z0-9-]+$/.test(name)) throw Error("invalid_evidence_name");
  const artifactId = `${name}-apply-002`;
  const relativePath = `${runtime}/artifacts/${artifactId}.json`;
  const artifact = { schemaVersion: "1.0.0", artifactId, changeId, runId: "run-001", kind: "evidence", recordedAt: new Date().toISOString(), ...value };
  write(relativePath, JSON.stringify(artifact, null, 2) + "\n");
  state.latestArtifactRefs[name] = { artifactId, changeId, runId: "run-001", kind: "evidence", relativePath };
  state.updatedAt = new Date().toISOString();
  write(`${runtime}/current-state.json`, JSON.stringify(state, null, 2) + "\n");
  return artifact;
}
export function claim(strict) {
  const { state, handoff } = guard();
  if (strict.exit_code !== 0) throw Error("strict_gate_failed");
  handoff.status = "IN_PROGRESS";
  state.currentPhase = "IMPLEMENTING";
  state.latestHandoff.status = "IN_PROGRESS";
  state.nextActions = ["依新版 Scenario 完成缺金鑰對照與逐筆秘密判讀，再依序執行 V0 至 V5。"];
  state.updatedAt = new Date().toISOString();
  write(`${runtime}/artifacts/handoff-apply-change-002.json`, JSON.stringify(handoff, null, 2) + "\n");
  write(`${runtime}/current-state.json`, JSON.stringify(state, null, 2) + "\n");
  return record("validation", { strict, commands: [] });
}
export function docker(args, options = {}) {
  guard();
  const startedAt = new Date().toISOString();
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...options });
  return { command: ["docker", ...args], startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
    stdout: redact(result.stdout || ""), stderr: redact(result.stderr || ""), error: result.error?.code || null };
}
export function must(result) {
  if (result.exitCode !== 0) throw Object.assign(Error("command_failed"), { result });
  return result;
}
export function containerRequest(container, route, body, method = body === undefined ? "GET" : "POST") {
  const script = `const r=await fetch('http://127.0.0.1:8000'+${JSON.stringify(route)}, {method:${JSON.stringify(method)},headers:{'content-type':'application/json'},body:${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))},signal:AbortSignal.timeout(120000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));`;
  const result = must(docker(["exec", "--interactive", container, "node", "--input-type=module"], { input: script }));
  return JSON.parse(result.stdout.trim());
}
export function digest(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
