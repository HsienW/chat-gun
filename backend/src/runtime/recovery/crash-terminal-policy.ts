import { z } from "zod";

import { LAST_EXECUTION_POINTS } from "./last-execution-point.js";

const crashKindSchema = z.enum([
  "checkpoint_store_unwritable",
  "state_deserialization_failed",
  "durable_invariant_violation",
  "worker_interrupted",
]);

const crashTerminalInputSchema = z
  .object({
    crash: z
      .object({
        kind: crashKindSchema,
        phase: z.enum(LAST_EXECUTION_POINTS),
        rawError: z.string().max(65_536),
      })
      .strict(),
    correlation: z
      .object({
        runId: z.string().trim().min(1).max(256),
        taskId: z.string().trim().min(1).max(256),
      })
      .strict(),
    telemetryLimits: z
      .object({
        maxRecords: z.number().int().positive().max(1000),
        timeoutMs: z.number().int().positive().max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();

const CRASH_REASON_CODES = {
  checkpoint_store_unwritable: "CHECKPOINT_STORE_UNWRITABLE",
  state_deserialization_failed: "STATE_DESERIALIZATION_FAILED",
  durable_invariant_violation: "DURABLE_INVARIANT_VIOLATION",
  worker_interrupted: "WORKER_INTERRUPTED",
} as const;

const FATAL_CRASH_KINDS = new Set<z.infer<typeof crashKindSchema>>([
  "checkpoint_store_unwritable",
  "state_deserialization_failed",
  "durable_invariant_violation",
]);

const TELEMETRY_FLUSH_MAX_RECORDS = 1000;
const TELEMETRY_FLUSH_TIMEOUT_MS = 2000;

type CrashTerminalInput = z.infer<typeof crashTerminalInputSchema>;

export interface CrashExternalDiagnostic {
  reasonCode: (typeof CRASH_REASON_CODES)[keyof typeof CRASH_REASON_CODES];
  fatal: boolean;
  phase: CrashTerminalInput["crash"]["phase"];
  runId: string;
  taskId: string;
}

export interface CrashLocalDiagnostic extends CrashExternalDiagnostic {
  bestEffortFailures: readonly CrashBestEffortFailure[];
}

export interface CrashTerminalDependencies {
  stopNewClaims(): Promise<void>;
  flushTelemetry(input: {
    maxRecords: number;
    timeoutMs: number;
  }): Promise<void>;
  persistRecoveryState(input: {
    runId: string;
    taskId: string;
    fatal: boolean;
    phase: CrashTerminalInput["crash"]["phase"];
    reasonCode: CrashExternalDiagnostic["reasonCode"];
  }): Promise<void>;
  writeLocalDiagnostic(diagnostic: CrashLocalDiagnostic): Promise<void>;
  exportExternalDiagnostic(diagnostic: CrashExternalDiagnostic): Promise<void>;
  exitNonZero(exitCode: number): Promise<void>;
}

export type CrashBestEffortFailure =
  | "STOP_CLAIMS_FAILED"
  | "TELEMETRY_FLUSH_FAILED"
  | "RECOVERY_PERSIST_FAILED"
  | "LOCAL_DIAGNOSTIC_FAILED"
  | "EXTERNAL_DIAGNOSTIC_FAILED"
  | "EXIT_ADAPTER_FAILED";

export interface CrashTerminalResult {
  disposition: "fatal_exit" | "recoverable";
  exitCode: 1 | null;
  reasonCode: CrashExternalDiagnostic["reasonCode"];
  bestEffortFailures: CrashBestEffortFailure[];
}

async function bestEffort(
  operation: () => Promise<void>,
  failure: CrashBestEffortFailure,
  failures: CrashBestEffortFailure[]
): Promise<void> {
  try {
    await operation();
  } catch {
    failures.push(failure);
  }
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("TELEMETRY_FLUSH_TIMEOUT")),
      timeoutMs
    );
    timeout.unref?.();
    operation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function applyCrashTerminalPolicy(
  inputValue: unknown,
  dependencies: CrashTerminalDependencies
): Promise<CrashTerminalResult> {
  const input = crashTerminalInputSchema.parse(inputValue);
  const fatal = FATAL_CRASH_KINDS.has(input.crash.kind);
  const reasonCode = CRASH_REASON_CODES[input.crash.kind];
  const telemetryLimits = input.telemetryLimits ?? {
    maxRecords: TELEMETRY_FLUSH_MAX_RECORDS,
    timeoutMs: TELEMETRY_FLUSH_TIMEOUT_MS,
  };
  const failures: CrashBestEffortFailure[] = [];
  const externalDiagnostic: CrashExternalDiagnostic = {
    reasonCode,
    fatal,
    phase: input.crash.phase,
    runId: input.correlation.runId,
    taskId: input.correlation.taskId,
  };

  if (fatal) {
    await bestEffort(
      () => dependencies.stopNewClaims(),
      "STOP_CLAIMS_FAILED",
      failures
    );
    await bestEffort(
      () =>
        withTimeout(
          dependencies.flushTelemetry(telemetryLimits),
          telemetryLimits.timeoutMs
        ),
      "TELEMETRY_FLUSH_FAILED",
      failures
    );
  }

  await bestEffort(
    () => dependencies.persistRecoveryState(externalDiagnostic),
    "RECOVERY_PERSIST_FAILED",
    failures
  );
  await bestEffort(
    () =>
      dependencies.writeLocalDiagnostic({
        ...externalDiagnostic,
        bestEffortFailures: [...failures],
      }),
    "LOCAL_DIAGNOSTIC_FAILED",
    failures
  );
  await bestEffort(
    () => dependencies.exportExternalDiagnostic(externalDiagnostic),
    "EXTERNAL_DIAGNOSTIC_FAILED",
    failures
  );

  if (fatal) {
    await bestEffort(
      () => dependencies.exitNonZero(1),
      "EXIT_ADAPTER_FAILED",
      failures
    );
  }

  return {
    disposition: fatal ? "fatal_exit" : "recoverable",
    exitCode: fatal ? 1 : null,
    reasonCode,
    bestEffortFailures: failures,
  };
}
