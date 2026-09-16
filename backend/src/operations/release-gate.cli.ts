import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { evaluateReleaseGate } from "./release-gate.js";

const MAX_REPORT_BYTES = 1024 * 1024;

function resolveWorkspaceReportPath(argument: string | undefined): string {
  if (!argument) throw new Error("REPORT_PATH_REQUIRED");
  const workspaceRoot = path.resolve(process.cwd());
  const reportPath = path.resolve(workspaceRoot, argument);
  const relativePath = path.relative(workspaceRoot, reportPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("REPORT_PATH_OUTSIDE_WORKSPACE");
  }
  return reportPath;
}

async function main(): Promise<void> {
  try {
    const reportPath = resolveWorkspaceReportPath(process.argv[2]);
    const reportStat = await stat(reportPath);
    if (!reportStat.isFile() || reportStat.size > MAX_REPORT_BYTES) {
      throw new Error("REPORT_FILE_INVALID");
    }
    const reportText = await readFile(reportPath, "utf8");
    const result = evaluateReleaseGate(JSON.parse(reportText) as unknown);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch {
    console.log(
      JSON.stringify({
        status: "invalid_report",
        reportVersion: null,
        datasetVersion: null,
        failureReasonCodes: ["RELEASE_GATE_REPORT_INVALID"],
      })
    );
    process.exitCode = 1;
  }
}

await main();
