import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectExpiredAuthorizations } from "./master-auth-gc.mjs";
import { authorizationSnapshot, parseAuthorizationContainer, verifyAuthorizationSnapshot, verifySelfAcceptance, resolveReferencedAuthorization, withinWriteScope } from "./master-authorization.mjs";

const entry = { authorizationId: "a", rolePolicyVersion: "2", grantedBy: "Master", grantee: "CCR",
  actingRole: "implementation_secondary", grants: ["secondary_takeover", "self_acceptance"],
  changeId: "example", runId: "run", handoffId: "handoff", writeScope: ["tools/"], expiresAt: "2999-01-01T00:00:00Z" };

test("schema rejects malformed containers and missing legacy ID", () => {
  for (const value of [null, [], { authorizations: [] }, { ...entry, authorizationId: undefined },
    { schemaVersion: "2", authorizations: { wrong: entry } }, { ...entry, grants: [3] }]) {
    assert.equal(parseAuthorizationContainer(JSON.stringify(value)).status, "invalid");
  }
  assert.equal(parseAuthorizationContainer(JSON.stringify(entry)).status, "valid");
});

test("snapshot is deterministic and changes when grants change", () => {
  assert.deepEqual(authorizationSnapshot(entry), authorizationSnapshot(Object.fromEntries(Object.entries(entry).reverse())));
  assert.notEqual(authorizationSnapshot(entry).sha256, authorizationSnapshot({ ...entry, grants: ["self_acceptance"] }).sha256);
  assert.equal(verifyAuthorizationSnapshot(authorizationSnapshot(entry)), true);
  assert.equal(verifyAuthorizationSnapshot({ ...authorizationSnapshot(entry), sha256: "0".repeat(64) }), false);
  assert.equal(verifyAuthorizationSnapshot(authorizationSnapshot({ ...entry, grants: ["secondary_takeover"] })), false);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "master-gc-test-"));
  await mkdir(path.join(root, ".agent-runtime/example"), { recursive: true });
  const file = path.join(root, ".agent-runtime/master-authorization.json");
  await writeFile(file, JSON.stringify({ schemaVersion: "2", authorizations: { a: entry, expired: { ...entry, authorizationId: "expired", expiresAt: "2000-01-01T00:00:00Z" } } }));
  await writeFile(path.join(root, ".agent-runtime/example/current-state.json"), JSON.stringify({
    terminalStatus: "NON_TERMINAL", changeId: "example", runId: "run",
    latestHandoff: { handoffId: "handoff", status: "IN_PROGRESS" } }));
  return { root, file };
}

test("GC defaults to dry-run and apply removes only expired entries", async () => {
  const { root, file } = await fixture();
  const before = await readFile(file, "utf8");
  assert.deepEqual((await collectExpiredAuthorizations({ workspaceRoot: root })).removed, ["expired"]);
  assert.equal(await readFile(file, "utf8"), before);
  await collectExpiredAuthorizations({ workspaceRoot: root, apply: true });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).authorizations), ["a"]);
});

test("GC refuses concurrent authorization changes", async () => {
  const { root, file } = await fixture();
  await assert.rejects(() => collectExpiredAuthorizations({ workspaceRoot: root, apply: true,
    beforeCommit: () => writeFile(file, "changed-by-master") }), /authorization_changed/);
  assert.equal(await readFile(file, "utf8"), "changed-by-master");
});

for (const status of ["COMPLETED", "FAILED", "REJECTED", "EXPIRED"]) {
  test(`GC removes inactive handoff ${status}`, async () => {
    const { root } = await fixture();
    const statePath = path.join(root, ".agent-runtime/example/current-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.latestHandoff.status = status;
    await writeFile(statePath, JSON.stringify(state));
    assert.deepEqual((await collectExpiredAuthorizations({ workspaceRoot: root })).removed, ["a", "expired"]);
  });
}

test("GC aborts on corrupt state instead of deleting authorization", async () => {
  const { root, file } = await fixture();
  const before = await readFile(file, "utf8");
  await writeFile(path.join(root, ".agent-runtime/example/current-state.json"), "{broken");
  await assert.rejects(() => collectExpiredAuthorizations({ workspaceRoot: root, apply: true }));
  assert.equal(await readFile(file, "utf8"), before);
});

test("referenced resolver never substitutes a different entry", async () => {
  const { root } = await fixture();
  const statePath = path.join(root, ".agent-runtime/example/current-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.currentOwner = "CCR";
  state.latestHandoff.to = "CCR";
  state.latestHandoff.authorizationRef = "master-authorization.json#a";
  await writeFile(statePath, JSON.stringify(state));
  assert.equal((await resolveReferencedAuthorization(root, state, "tools/task.mjs")).authorizationId, "a");
  state.latestHandoff.authorizationRef = "master-authorization.json#missing";
  assert.equal(await resolveReferencedAuthorization(root, state, "tools/task.mjs"), null);
  for (const target of ["tools/../outside", "tools//file", "C:/tools/file", "tools\\file"]) {
    assert.equal(withinWriteScope(target, ["tools/"]), false);
  }
});

test("self acceptance requires the live referenced entry, not just a consistent snapshot", async () => {
  const { root, file } = await fixture();
  const statePath = path.join(root, ".agent-runtime/example/current-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.currentOwner = "CCR";
  state.latestHandoff.to = "CCR";
  state.latestHandoff.authorizationRef = "master-authorization.json#a";
  const snapshot = authorizationSnapshot(entry);
  assert.equal(await verifySelfAcceptance(root, state, snapshot), true);

  const forged = authorizationSnapshot({ ...entry, writeScope: ["everything/"] });
  assert.equal(verifyAuthorizationSnapshot(forged), true);
  assert.equal(await verifySelfAcceptance(root, state, forged), false);

  const inactive = { ...state, latestHandoff: { ...state.latestHandoff, status: "COMPLETED" } };
  assert.equal(await verifySelfAcceptance(root, inactive, snapshot), false);
  const otherRef = { ...state, latestHandoff: { ...state.latestHandoff, authorizationRef: "master-authorization.json#expired" } };
  assert.equal(await verifySelfAcceptance(root, otherRef, snapshot), false);

  await writeFile(file, JSON.stringify({ schemaVersion: "2", authorizations: { a: { ...entry, grants: ["secondary_takeover"] } } }));
  assert.equal(await verifySelfAcceptance(root, state, snapshot), false);
  await unlink(file);
  assert.equal(await verifySelfAcceptance(root, state, snapshot), false);
});

test("GC removes terminal and missing states", async () => {
  for (const missing of [false, true]) {
    const { root } = await fixture();
    const statePath = path.join(root, ".agent-runtime/example/current-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.terminalStatus = "TERMINAL";
    if (missing) await unlink(statePath); else await writeFile(statePath, JSON.stringify(state));
    assert.deepEqual((await collectExpiredAuthorizations({ workspaceRoot: root })).removed, ["a", "expired"]);
  }
});
