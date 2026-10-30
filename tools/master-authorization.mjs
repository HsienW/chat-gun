import { readFile, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";

const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
let ajv;
try {
  const Ajv = requireBackend("ajv/dist/2020.js").default;
  ajv = new Ajv({ strict: false, allErrors: true });
  requireBackend("ajv-formats")(ajv);
} catch (error) {
  // The CCR hook imports this module, so a fresh clone would otherwise deny every write without saying why.
  throw new Error("Authorization validation needs backend dependencies; run npm install in backend/.", { cause: error });
}
const validate = ajv.compile(JSON.parse(readFileSync(new URL(
  "../openspec/specs/agent-role-policy/master-authorization.schema.json", import.meta.url), "utf8")));
export const MASTER_AUTHORIZATION_PATH = ".agent-runtime/master-authorization.json";
const ACTIVE = new Set(["PENDING", "ACCEPTED", "IN_PROGRESS"]);

export function parseAuthorizationContainer(raw) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) return { status: "invalid" };
    const value = JSON.parse(raw);
    if (!validate(value)) return { status: "invalid" };
    const entries = new Map(Object.entries(value.authorizations ?? { [value.authorizationId]: value }));
    if ([...entries].some(([id, entry]) => id !== entry.authorizationId)) return { status: "invalid" };
    return { status: "valid", entries };
  } catch { return { status: "invalid" }; }
}

export async function readInsideWorkspace(root, relative) {
  const canonicalRoot = await realpath(root);
  const target = await realpath(path.resolve(root, relative));
  const rel = path.relative(canonicalRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("path_outside_workspace");
  return readFile(target, "utf8");
}

export async function loadAuthorizationContainer(root) {
  try { return parseAuthorizationContainer(await readInsideWorkspace(root, MASTER_AUTHORIZATION_PATH)); }
  catch (error) { return { status: error.code === "ENOENT" ? "missing" : "invalid" }; }
}

export function authorizationMatchesState(entry, state, now = Date.now()) {
  const handoff = state?.latestHandoff;
  return Date.parse(entry.expiresAt) > now && state?.changeId === entry.changeId &&
    entry.actingRole === (entry.grantee === "CCR" ? "implementation_secondary" : "planning_secondary") &&
    state.runId === entry.runId && state.currentOwner === entry.grantee &&
    state.terminalStatus === "NON_TERMINAL" && handoff?.handoffId === entry.handoffId &&
    handoff.to === entry.grantee && ACTIVE.has(handoff.status) &&
    handoff.authorizationRef === `master-authorization.json#${entry.authorizationId}`;
}

export function withinWriteScope(target, scopes) {
  if (typeof target !== "string" || !target || /[:\\]/u.test(target) || path.posix.isAbsolute(target) ||
      target.split("/").some(part => part === "." || part === ".." || part === "")) return false;
  return scopes.some(scope => scope.endsWith("/") ? target.startsWith(scope) : target === scope);
}

export async function activeAuthorizations(root, entries, now = Date.now()) {
  const active = [];
  for (const entry of entries.values()) {
    try {
      const state = JSON.parse(await readInsideWorkspace(root, `.agent-runtime/${entry.changeId}/current-state.json`));
      if (authorizationMatchesState(entry, state, now)) active.push(entry);
    } catch { /* Missing, corrupt or escaped state cannot grant permission. */ }
  }
  return active;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

export function authorizationSnapshot(entry) {
  if (!validate(entry)) throw new Error("invalid_authorization");
  const normalizedJson = JSON.stringify(canonicalize(entry));
  return { authorizationId: entry.authorizationId, normalizedJson,
    sha256: createHash("sha256").update(normalizedJson).digest("hex") };
}

// Codex must select the referenced entry first; other entries never substitute for a missing ID.
export async function resolveReferencedAuthorization(root, state, target, { grant = "secondary_takeover", now = Date.now() } = {}) {
  const match = /^master-authorization\.json#([A-Za-z0-9_.-]+)$/u.exec(state?.latestHandoff?.authorizationRef ?? "");
  if (!match) return null;
  const container = await loadAuthorizationContainer(root);
  if (container.status !== "valid") return null;
  const entry = container.entries.get(match[1]);
  if (!entry || !authorizationMatchesState(entry, state, now) || !entry.grants.includes(grant) || !withinWriteScope(target, entry.writeScope)) return null;
  const overlaps = (await activeAuthorizations(root, container.entries, now)).filter(candidate =>
    candidate.grants.includes(grant) && withinWriteScope(target, candidate.writeScope));
  if (overlaps.length !== 1 || overlaps[0].authorizationId !== entry.authorizationId) return null;
  return entry;
}

// Audit only: a self-consistent snapshot can be fabricated, so it never proves that a grant existed.
export function verifyAuthorizationSnapshot(snapshot) {
  try {
    const entry = JSON.parse(snapshot.normalizedJson);
    const expected = authorizationSnapshot(entry);
    return entry.grants.includes("self_acceptance") && expected.authorizationId === snapshot.authorizationId &&
      expected.normalizedJson === snapshot.normalizedJson && expected.sha256 === snapshot.sha256;
  } catch { return false; }
}

// The acceptance gate: the snapshot must equal the live entry the current Handoff references.
export async function verifySelfAcceptance(root, state, snapshot, now = Date.now()) {
  if (!verifyAuthorizationSnapshot(snapshot)) return false;
  const match = /^master-authorization\.json#([A-Za-z0-9_.-]+)$/u.exec(state?.latestHandoff?.authorizationRef ?? "");
  if (!match || match[1] !== snapshot.authorizationId) return false;
  const container = await loadAuthorizationContainer(root);
  if (container.status !== "valid") return false;
  const entry = container.entries.get(match[1]);
  return Boolean(entry) && entry.grants.includes("self_acceptance") && authorizationMatchesState(entry, state, now) &&
    authorizationSnapshot(entry).sha256 === snapshot.sha256;
}
