import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import {
  classifyRecoveryReason,
  parseRecoveryReason,
  PgRecoveryRecordRepository,
  type RecoveryRecord,
} from "./recovery-reason.js";

describe("RecoveryReason", () => {
  it("keeps user cancel separate from transport disconnect", () => {
    expect(
      classifyRecoveryReason(
        parseRecoveryReason({
          cancellationReason: "user_cancel",
          transportDisconnect: true,
        })
      )
    ).toEqual({
      category: "user_cancelled",
      shouldResume: false,
      transportDisconnected: true,
    });
    expect(
      classifyRecoveryReason(
        parseRecoveryReason({ transportDisconnect: true })
      )
    ).toEqual({
      category: "transport_disconnected",
      shouldResume: true,
      transportDisconnected: true,
    });
  });

  it("keeps crash separate from timeout", () => {
    expect(
      classifyRecoveryReason(
        parseRecoveryReason({
          cancellationReason: "crash",
          crash: { fatal: false, phase: "executing" },
        })
      )
    ).toMatchObject({ category: "crashed", shouldResume: true });
    expect(
      classifyRecoveryReason(
        parseRecoveryReason({ cancellationReason: "timeout" })
      )
    ).toMatchObject({ category: "timed_out", shouldResume: false });
  });

  it("fails closed on unknown reasons or an empty record", () => {
    expect(() => parseRecoveryReason({ cancellationReason: "disconnect" })).toThrow();
    expect(() => parseRecoveryReason({})).toThrow();
  });
});

describe("PgRecoveryRecordRepository", () => {
  it("persists and reads separated recovery reason fields", async () => {
    const record: RecoveryRecord = {
      recordId: "record-1",
      runId: "run-1",
      taskId: "task-1",
      reason: {
        cancellationReason: "crash",
        transportDisconnect: true,
        crash: { fatal: false, phase: "executing" },
      },
      classification: "crashed",
      recordedAt: "2026-09-28T05:00:00.000Z",
    };
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      _text: string,
      _values: readonly unknown[] = []
    ) => ({
      rows: [{ recovery_record: record }] as unknown as TResult[],
      rowCount: 1,
    }));
    const repository = new PgRecoveryRecordRepository({ query } as Queryable);

    await expect(repository.create(record)).resolves.toEqual(record);
    await expect(repository.findLatestByTaskId("task-1")).resolves.toEqual(record);
    expect(query.mock.calls[0]?.[1]?.[4]).toEqual(record.reason);
    expect(JSON.stringify(query.mock.calls[0]?.[1]?.[4])).toContain(
      '"transportDisconnect":true'
    );
  });
});
