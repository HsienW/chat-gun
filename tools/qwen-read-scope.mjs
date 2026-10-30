import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// Verified installed CLI parameters; unknown aliases must not silently inherit these contracts.
export const READ_TOOLS = new Set(["read_file", "grep_search", "glob", "list_directory"]);
// Qwen 0.25.3: grep_search and glob search the working directory when path is omitted.
const SEARCH_FILTER_PARAM = Object.freeze({ grep_search: "glob", glob: "pattern" });
const FORBIDDEN_DIRS = Object.freeze(["node_modules", "dist", "build", "coverage", ".git"]);
export function readRequest(name, input) {
  if (!READ_TOOLS.has(name)) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { paths: [], proven: false };
  const filterParam = SEARCH_FILTER_PARAM[name];
  const pathValue = input[name === "read_file" ? "file_path" : "path"];
  const values = [filterParam && pathValue === undefined ? "." : pathValue];
  const proven = values.every(value => typeof value === "string" && value.trim() !== "");
  return { paths: proven ? values : [], proven,
    search: Boolean(filterParam), filter: filterParam ? input[filterParam] : undefined,
    ignoresDisabled: input.file_filtering_options?.respect_git_ignore === false || input.respect_git_ignore === false };
}

function forbidden(relative, changeId, refs) {
  const parts = relative.toLowerCase().split("/");
  if (parts.some(part => part.startsWith(".env") || FORBIDDEN_DIRS.includes(part))) return true;
  if (parts[0] === ".agent-runtime") return !refs.has(relative) || !relative.startsWith(`.agent-runtime/${changeId}/`);
  return false;
}

// A search filter must not name a refused location, even though Qwen's own filtering would drop it.
function unsafeSearchFilter(filter, containsSecret) {
  if (filter === undefined) return false;
  if (typeof filter !== "string" || containsSecret(filter)) return true;
  const normalized = filter.replaceAll("\\", "/").toLowerCase();
  if (normalized.startsWith("/") || /^[a-z]:/u.test(normalized)) return true;
  const parts = normalized.split(/[/{},]+/u);
  return parts.some(part => part === ".." || part === ".agent-runtime" || part.startsWith(".env") || FORBIDDEN_DIRS.includes(part));
}

export async function auditReadScope(observed, { root, changeId, runId, currentState, containsSecret, searchFilteringProven = false }) {
  const refs = new Set();
  const required = currentState.latestHandoff?.requiredInputRefs ?? [];
  for (const ref of [...Object.values(currentState.latestArtifactRefs), ...required]) {
    if (ref?.changeId === changeId && (!ref.runId || ref.runId === runId || required.includes(ref)) &&
        typeof ref.relativePath === "string" && !ref.relativePath.includes("..") &&
        ref.relativePath.startsWith(`.agent-runtime/${changeId}/`)) refs.add(ref.relativePath);
  }
  const reasons = new Set();
  const readPaths = new Set();
  const canonicalRoot = await realpath(root);
  for (const tool of observed.tools) {
    const request = tool.readRequest;
    delete tool.readRequest;
    if (!request) continue;
    if (!request.proven || request.ignoresDisabled) reasons.add("read_scope_not_proven");
    if (request.search && unsafeSearchFilter(request.filter, containsSecret)) reasons.add("read_scope_violation");
    const targets = [];
    for (const value of request.paths) {
      if (containsSecret(value)) { reasons.add("read_scope_violation"); readPaths.add("[redacted]"); continue; }
      const absolute = path.resolve(root, value.replaceAll("\\", "/"));
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) ||
          (path.win32.isAbsolute(value) && !path.isAbsolute(value))) {
        reasons.add("read_scope_violation"); readPaths.add("[outside-workspace]"); continue;
      }
      readPaths.add(relative || ".");
      targets.push(relative || ".");
      if (forbidden(relative, changeId, refs)) { reasons.add("read_scope_violation"); continue; }
      // Wildcards can include unreferenced runtime files or secrets; without resolved tool paths
      // their read scope cannot be certified.
      if (/[?*\[\]{}!]/u.test(relative)) { reasons.add("read_scope_not_proven"); continue; }
      try {
        const real = await realpath(absolute);
        const realRelative = path.relative(canonicalRoot, real).split(path.sep).join("/");
        if (realRelative === ".." || realRelative.startsWith("../") || path.isAbsolute(realRelative) || forbidden(realRelative, changeId, refs)) {
          reasons.add("read_scope_violation"); continue;
        }
        // Directory searches are certified only while Qwen's .gitignore filtering is proven active.
        if ((await stat(real)).isDirectory() && tool.name?.toLowerCase() !== "list_directory" &&
            !(request.search && searchFilteringProven)) {
          reasons.add("read_scope_not_proven"); continue;
        }
        if (!refs.has(relative)) {
          // The workspace root cannot be ignored, yet git check-ignore --no-index can report "." as matched.
          for (const candidate of new Set([relative, realRelative].filter(Boolean))) {
            try {
              execFileSync("git", ["check-ignore", "--no-index", "--quiet", "--", candidate], { cwd: root, stdio: "pipe", windowsHide: true });
              reasons.add("read_scope_violation");
            } catch (error) {
              if (error.status !== 1) reasons.add("read_scope_not_proven");
            }
          }
        }
      } catch { reasons.add("read_scope_not_proven"); }
    }
    if (targets.length) tool.readTargets = targets;
  }
  observed.readPaths = [...readPaths].sort();
  return [...reasons];
}
