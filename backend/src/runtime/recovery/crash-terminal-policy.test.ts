import { describe, expect, it, vi } from "vitest";

import {
  applyCrashTerminalPolicy,
  type CrashTerminalDependencies,
} from "./crash-terminal-policy.js";

function createDependencies() {
  const calls: string[] = [];
  const dependencies: CrashTerminalDependencies = {
    stopNewClaims: vi.fn(async () => {
      calls.push("stop");
    }),
    flushTelemetry: vi.fn(async ({ maxRecords }) => {
      calls.push(`flush:${maxRecords}`);
    }),
    persistRecoveryState: vi.fn(async () => {
      calls.push("persist");
    }),
    writeLocalDiagnostic: vi.fn(async () => {
      calls.push("local");
    }),
    exportExternalDiagnostic: vi.fn(async () => {
      calls.push("external");
    }),
    exitNonZero: vi.fn(async () => {
      calls.push("exit");
    }),
  };
  return { calls, dependencies };
}

describe("crash terminal policy", () => {
  it("stops claims, bounds telemetry, persists recovery, and exits for fatal corruption", async () => {
    const { calls, dependencies } = createDependencies();

    const result = await applyCrashTerminalPolicy(
      {
        crash: {
          kind: "checkpoint_store_unwritable",
          phase: "executing",
          rawError: "postgres password=do-not-export",
        },
        correlation: { runId: "run-1", taskId: "task-1" },
      },
      dependencies
    );

    expect(result).toMatchObject({ disposition: "fatal_exit", exitCode: 1 });
    expect(calls).toEqual([
      "stop",
      "flush:1000",
      "persist",
      "local",
      "external",
      "exit",
    ]);
    expect(dependencies.flushTelemetry).toHaveBeenCalledWith({
      maxRecords: 1000,
      timeoutMs: 2000,
    });
    expect(dependencies.exportExternalDiagnostic).toHaveBeenCalledWith({
      reasonCode: "CHECKPOINT_STORE_UNWRITABLE",
      fatal: true,
      phase: "executing",
      runId: "run-1",
      taskId: "task-1",
    });
    expect(
      JSON.stringify(vi.mocked(dependencies.exportExternalDiagnostic).mock.calls)
    ).not.toContain("do-not-export");
    expect(
      JSON.stringify(vi.mocked(dependencies.writeLocalDiagnostic).mock.calls)
    ).not.toContain("do-not-export");
  });

  it("persists a recoverable crash without stopping claims or exiting", async () => {
    const { calls, dependencies } = createDependencies();

    const result = await applyCrashTerminalPolicy(
      {
        crash: {
          kind: "worker_interrupted",
          phase: "executing",
          rawError: "socket reset",
        },
        correlation: { runId: "run-2", taskId: "task-2" },
      },
      dependencies
    );

    expect(result).toMatchObject({ disposition: "recoverable", exitCode: null });
    expect(calls).toEqual(["persist", "local", "external"]);
    expect(dependencies.stopNewClaims).not.toHaveBeenCalled();
    expect(dependencies.flushTelemetry).not.toHaveBeenCalled();
    expect(dependencies.exitNonZero).not.toHaveBeenCalled();
  });

  it("keeps fatal shutdown progressing when best-effort steps fail", async () => {
    const { dependencies } = createDependencies();
    vi.mocked(dependencies.flushTelemetry).mockRejectedValueOnce(
      new Error("flush unavailable")
    );
    vi.mocked(dependencies.persistRecoveryState).mockRejectedValueOnce(
      new Error("checkpoint unavailable")
    );

    const result = await applyCrashTerminalPolicy(
      {
        crash: {
          kind: "durable_invariant_violation",
          phase: "committed",
          rawError: "secret payload",
        },
        correlation: { runId: "run-3", taskId: "task-3" },
      },
      dependencies
    );

    expect(result.bestEffortFailures).toEqual([
      "TELEMETRY_FLUSH_FAILED",
      "RECOVERY_PERSIST_FAILED",
    ]);
    expect(dependencies.writeLocalDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffortFailures: [
          "TELEMETRY_FLUSH_FAILED",
          "RECOVERY_PERSIST_FAILED",
        ],
      })
    );
    expect(dependencies.exitNonZero).toHaveBeenCalledWith(1);
  });

  it("rejects telemetry bounds above the safe policy maximum", async () => {
    const { dependencies } = createDependencies();

    await expect(
      applyCrashTerminalPolicy(
        {
          crash: {
            kind: "worker_interrupted",
            phase: "executing",
            rawError: "socket reset",
          },
          correlation: { runId: "run-4", taskId: "task-4" },
          telemetryLimits: { maxRecords: 1001, timeoutMs: 2001 },
        },
        dependencies
      )
    ).rejects.toThrow();
  });
});
