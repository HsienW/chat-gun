import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/evaluation/commerce/evaluate.cli.ts", ...args], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

describe("npm run commerce:evaluate", () => {
  it("is the chain evaluation CLI", () => {
    const manifest = JSON.parse(readFileSync(join(BACKEND_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

    expect(manifest.scripts["commerce:evaluate"]).toBe("tsx src/evaluation/commerce/evaluate.cli.ts");
  });

  it("fails live mode with a typed error and writes nothing", () => {
    const result = runCli(["--mode", "live"], { ...process.env, SIDE_EFFECT_INTEGRATION_DATABASE_URL: "postgres://unused" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CHAIN_EVAL_LIVE_NOT_IMPLEMENTED");
    expect(result.stdout).toBe("");
  }, 60_000);

  it("fails a deterministic run without the isolated database", () => {
    const env = { ...process.env };
    delete env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;

    const result = runCli(["--mode", "deterministic"], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CHAIN_EVAL_DATABASE_UNAVAILABLE");
  }, 60_000);
});
