import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  addBadTraceRegressionCase,
  compareVersionPinnedExperiments,
} from "./feedback-loop.js";

const MAX_WORKFLOW_BYTES = 1024 * 1024;

function resolveWorkspaceInputPath(argument: string | undefined): string {
  if (!argument) throw new Error("WORKFLOW_PATH_REQUIRED");
  const workspaceRoot = path.resolve(process.cwd());
  const workflowPath = path.resolve(workspaceRoot, argument);
  const relativePath = path.relative(workspaceRoot, workflowPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("WORKFLOW_PATH_OUTSIDE_WORKSPACE");
  }
  return workflowPath;
}

async function main(): Promise<void> {
  try {
    const workflowPath = resolveWorkspaceInputPath(process.argv[2]);
    const workflowStat = await stat(workflowPath);
    if (!workflowStat.isFile() || workflowStat.size > MAX_WORKFLOW_BYTES) {
      throw new Error("WORKFLOW_FILE_INVALID");
    }
    const workflow = JSON.parse(
      await readFile(workflowPath, "utf8")
    ) as Record<string, unknown>;
    const dataset = addBadTraceRegressionCase(
      workflow.baseDataset,
      workflow.badTrace,
      workflow.policy
    );
    const comparison = compareVersionPinnedExperiments(
      workflow.before,
      workflow.after
    );
    console.log(JSON.stringify({ dataset, comparison }));
  } catch {
    console.log(
      JSON.stringify({
        status: "failed",
        reasonCode: "FEEDBACK_WORKFLOW_INVALID",
      })
    );
    process.exitCode = 1;
  }
}

await main();
