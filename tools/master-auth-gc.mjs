#!/usr/bin/env node
// Master-only CLI. Agents may test this module against isolated fixtures, never run the CLI.
import { writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MASTER_AUTHORIZATION_PATH, parseAuthorizationContainer, readInsideWorkspace } from "./master-authorization.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const ACTIVE = new Set(["PENDING", "ACCEPTED", "IN_PROGRESS"]);
export async function collectExpiredAuthorizations({ workspaceRoot, apply = false, now = Date.now(), beforeCommit = async () => {} }) {
  const original = await readInsideWorkspace(workspaceRoot, MASTER_AUTHORIZATION_PATH);
  const container = parseAuthorizationContainer(original);
  if (container.status !== "valid") throw new Error("invalid_authorization_container");
  const removed = [];
  for (const [id, entry] of container.entries) {
    let expired = Date.parse(entry.expiresAt) <= now;
    if (!expired) {
      try {
        const state = JSON.parse(await readInsideWorkspace(workspaceRoot, `.agent-runtime/${entry.changeId}/current-state.json`));
        if (state.changeId !== entry.changeId || typeof state.runId !== "string" ||
            !["NON_TERMINAL", "TERMINAL"].includes(state.terminalStatus) ||
            typeof state.latestHandoff?.handoffId !== "string" ||
            ![...ACTIVE, "COMPLETED", "FAILED", "REJECTED", "EXPIRED"].includes(state.latestHandoff.status)) {
          throw new Error("invalid_current_state");
        }
        expired = state.terminalStatus !== "NON_TERMINAL" || state.runId !== entry.runId ||
          state.latestHandoff.handoffId !== entry.handoffId || !ACTIVE.has(state.latestHandoff.status);
      } catch (error) {
        if (error.code !== "ENOENT") throw error; // Do not delete on unreadable/corrupt state.
        expired = true;
      }
    }
    if (expired) removed.push(id);
  }
  if (!apply || !removed.length) return { removed, applied: false };
  const entries = new Map(container.entries);
  for (const id of removed) entries.delete(id);
  const target = path.resolve(workspaceRoot, MASTER_AUTHORIZATION_PATH);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: "2", authorizations: Object.fromEntries(entries) }, null, 2)}\n`, { flag: "wx" });
    await beforeCommit();
    if (hash(await readInsideWorkspace(workspaceRoot, MASTER_AUTHORIZATION_PATH)) !== hash(original)) throw new Error("authorization_changed");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return { removed, applied: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--apply")) throw new Error("Usage: node tools/master-auth-gc.mjs [--apply] (Master only)");
    console.log(JSON.stringify(await collectExpiredAuthorizations({ workspaceRoot: process.cwd(), apply: args.includes("--apply") })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
