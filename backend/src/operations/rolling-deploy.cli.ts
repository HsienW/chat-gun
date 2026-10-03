import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseRollingDeployPlan,
  runRollingDeployment,
  type RollingDeployDependencies,
} from "./rolling-deploy.js";

const MAX_ADAPTER_BYTES = 1024 * 1024;
const ALLOWED_ADAPTER_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);

type RollingDeployPlan = ReturnType<typeof parseRollingDeployPlan>;
type RollingDeployEnvironment = Readonly<Record<string, string | undefined>>;

export interface RollingDeployDependencyFactoryContext {
  plan: RollingDeployPlan;
  environment: RollingDeployEnvironment;
}

export type RollingDeployDependencyFactory = (
  context: RollingDeployDependencyFactoryContext
) => Promise<RollingDeployDependencies> | RollingDeployDependencies;

export interface RollingDeployCliInput {
  environment: RollingDeployEnvironment;
  createDependencies: RollingDeployDependencyFactory;
  writeOutput(output: string): void;
}

function resolveWorkspaceAdapterPath(
  modulePath: string | undefined,
  workspaceRoot: string
): string {
  if (!modulePath) throw new Error("ROLLING_DEPLOY_ADAPTER_MODULE_REQUIRED");
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const adapterPath = path.resolve(resolvedWorkspaceRoot, modulePath);
  const relativePath = path.relative(resolvedWorkspaceRoot, adapterPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_OUTSIDE_WORKSPACE");
  }
  if (!ALLOWED_ADAPTER_EXTENSIONS.has(path.extname(adapterPath))) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_EXTENSION_UNSUPPORTED");
  }
  return adapterPath;
}

function assertPathInsideWorkspace(
  adapterPath: string,
  workspaceRoot: string
): void {
  const relativePath = path.relative(workspaceRoot, adapterPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_OUTSIDE_WORKSPACE");
  }
}

function isDependencyFactoryModule(
  value: unknown
): value is {
  createRollingDeployDependencies: RollingDeployDependencyFactory;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "createRollingDeployDependencies" in value &&
    typeof value.createRollingDeployDependencies === "function"
  );
}

function isRollingDeployDependencies(
  value: unknown
): value is RollingDeployDependencies {
  return (
    typeof value === "object" &&
    value !== null &&
    "drainOldInstance" in value &&
    typeof value.drainOldInstance === "function" &&
    "checkResumeCompatibility" in value &&
    typeof value.checkResumeCompatibility === "function" &&
    "runCanary" in value &&
    typeof value.runCanary === "function" &&
    "shiftTraffic" in value &&
    typeof value.shiftTraffic === "function"
  );
}

export async function loadRollingDeployDependencyFactory(
  modulePath: string | undefined,
  workspaceRoot = process.cwd()
): Promise<RollingDeployDependencyFactory> {
  const candidatePath = resolveWorkspaceAdapterPath(modulePath, workspaceRoot);
  const [resolvedWorkspaceRoot, adapterPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(candidatePath),
  ]);
  assertPathInsideWorkspace(adapterPath, resolvedWorkspaceRoot);
  if (!ALLOWED_ADAPTER_EXTENSIONS.has(path.extname(adapterPath))) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_EXTENSION_UNSUPPORTED");
  }
  const adapterStat = await stat(adapterPath);
  if (!adapterStat.isFile() || adapterStat.size > MAX_ADAPTER_BYTES) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_FILE_INVALID");
  }
  const adapterModule: unknown = await import(pathToFileURL(adapterPath).href);
  if (!isDependencyFactoryModule(adapterModule)) {
    throw new Error("ROLLING_DEPLOY_ADAPTER_FACTORY_INVALID");
  }
  return async (context) => {
    const dependencies: unknown =
      await adapterModule.createRollingDeployDependencies(context);
    if (!isRollingDeployDependencies(dependencies)) {
      throw new Error("ROLLING_DEPLOY_ADAPTER_DEPENDENCIES_INVALID");
    }
    return dependencies;
  };
}

export async function runRollingDeployCli(
  input: RollingDeployCliInput
): Promise<number> {
  try {
    const rawPlan = input.environment.ROLLING_DEPLOY_PLAN_JSON;
    if (!rawPlan) throw new Error("ROLLING_DEPLOY_PLAN_JSON_REQUIRED");
    const planValue: unknown = JSON.parse(rawPlan);
    const plan = parseRollingDeployPlan(planValue);
    const dependencies = await input.createDependencies({
      plan,
      environment: input.environment,
    });
    const result = await runRollingDeployment(plan, dependencies);
    input.writeOutput(`${JSON.stringify(result)}\n`);
    return result.status === "completed" ? 0 : 1;
  } catch {
    input.writeOutput(
      `${JSON.stringify({
        status: "failed",
        reasonCode: "ROLLING_DEPLOY_CLI_FAILED",
      })}\n`
    );
    return 1;
  }
}

function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  return (
    entryPath !== undefined &&
    path.resolve(fileURLToPath(moduleUrl)) === path.resolve(entryPath)
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const exitCode = await runRollingDeployCli({
    environment: process.env,
    createDependencies: async (context) => {
      const factory = await loadRollingDeployDependencyFactory(
        process.env.ROLLING_DEPLOY_ADAPTER_MODULE
      );
      return factory(context);
    },
    writeOutput: (output) => process.stdout.write(output),
  });
  process.exitCode = exitCode;
}
