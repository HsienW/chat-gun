import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("production tool scheduling resilience architecture", () => {
  it("classifies concurrency from descriptors without fixed production tool names", () => {
    const pipelineSource = readSource("./pipeline.ts");

    expect(pipelineSource).toContain("descriptor.isReadOnly");
    expect(pipelineSource).toContain("descriptor.isConcurrencySafe(parsedInput.data)");
    for (const fixedToolName of ["weather", "web_search", "calculator", "mcp"]) {
      expect(pipelineSource).not.toContain(`toolName === \"${fixedToolName}\"`);
    }
  });

  it("keeps dispatch bounded and capacity sourced from runtime config", () => {
    const pipelineSource = readSource("./pipeline.ts");
    const schedulerSource = readSource("./scheduler.ts");

    expect(pipelineSource).not.toMatch(/Promise\.all\s*\(/u);
    expect(schedulerSource).not.toMatch(/Promise\.all\s*\(/u);
    expect(schedulerSource).toContain(
      "constructor(capacity: ToolDispatchSchedulerCapacity)"
    );
    expect(pipelineSource).toContain(
      "maxConcurrentReads: runtimeConfig.toolDispatchMaxConcurrentReads"
    );
    expect(pipelineSource).toContain(
      "runtimeConfig.toolDispatchMaxConcurrentReadsPerRun"
    );
  });

  it("uses the step lock for transition ownership without replacing idempotency", () => {
    const pipelineSource = readSource("./pipeline.ts");
    const runnerSource = readSource("../side-effect/tool-execution-runner.ts");

    expect(pipelineSource).toContain("ToolDispatchStepLockLease.acquire");
    expect(pipelineSource).toContain("new PgBusinessEffectLedger");
    expect(pipelineSource).toContain("dependencies.toolExecutionRunner.execute");
    expect(runnerSource).toContain("createReplayKey(input.identity)");
    expect(runnerSource).toContain("deriveBusinessEffectKey");
  });
});
