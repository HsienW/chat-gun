import { describe, expect, it } from "vitest";

import {
  PgBusinessEffectLedger,
  type SideEffectDatabase,
} from "./business-effect-ledger.js";
import { createReplayKey, hashBusinessEffectKey } from "./identity.js";
import type { Queryable } from "../persistence/rows.js";

type FakeQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};
type FakeQueryHandler = (
  text: string,
  values?: readonly unknown[]
) => Promise<FakeQueryResult>;

const now = new Date("2026-08-17T00:00:00.000Z");
const replayKey = createReplayKey({
  runId: "run-1",
  stepId: "step-1",
  logicalToolCallId: "tool-call-1",
  callIndex: 0,
  toolName: "side_effect_tool",
  toolVersion: "1",
});

const prepareInput = {
  businessEffectId: "effect-1",
  toolExecutionId: "execution-1",
  businessEffectKey: hashBusinessEffectKey("resource-1"),
  scope: {
    scopeId: "scope-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
  },
  replayKey,
  requestHash: "request-hash-1",
  requestId: "request-1",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  stepId: "step-1",
  callIndex: 0,
  toolName: "side_effect_tool",
  toolVersion: "1",
};

function businessEffectRow(commitState = "prepared") {
  return {
    business_effect_id: "effect-1",
    scope_id: "scope-1",
    tenant_id: "tenant-1",
    business_effect_key: String(prepareInput.businessEffectKey),
    external_system_namespace: null,
    external_operation_id: null,
    commit_state: commitState,
    expires_at: null,
    created_at: now,
    committed_at: commitState === "committed" ? now : null,
    updated_at: now,
  };
}

function toolExecutionRow(status = "prepared", resultRef: string | null = null) {
  return {
    tool_execution_id: "execution-1",
    business_effect_id: "effect-1",
    replay_key: String(replayKey),
    request_id: "request-1",
    thread_id: "thread-1",
    run_id: "run-1",
    task_id: "task-1",
    step_id: "step-1",
    tool_name: "side_effect_tool",
    tool_version: "1",
    call_index: 0,
    status,
    request_hash: "request-hash-1",
    result_ref: resultRef,
    created_at: now,
    updated_at: now,
  };
}

class FakeSideEffectDatabase implements SideEffectDatabase {
  constructor(private readonly handler: FakeQueryHandler) {}

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: TResult[]; rowCount: number | null }> {
    const result = await this.handler(text, values);
    return { rows: result.rows as TResult[], rowCount: result.rowCount };
  }

  async withTransaction<TResult>(
    operation: (transaction: Queryable) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

describe("PgBusinessEffectLedger.prepare", () => {
  it("returns a typed unavailable result when durable prepare fails", async () => {
    const db = new FakeSideEffectDatabase(async () => {
      throw new Error("database unavailable");
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare(prepareInput)).resolves.toEqual({
      type: "unavailable",
      errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
    });
  });

  it("claims a new business effect and prepares its execution atomically", async () => {
    const executedSql: string[] = [];
    const executedValues: unknown[][] = [];
    const db = new FakeSideEffectDatabase(async (text, values) => {
      executedSql.push(text);
      executedValues.push([...(values ?? [])]);
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [businessEffectRow()], rowCount: 1 };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        return { rows: [toolExecutionRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare({
      ...prepareInput,
      decisionId: "decision-1",
      securityEvidence: {
        executionProfileVersion: "1.0",
        effectiveCapabilities: { executionMode: "isolated_process" },
        secretRefsUsed: ["env:BRAVE_API_KEY"],
        egressDecision: null,
      },
    })).resolves.toMatchObject({
      type: "claimed",
      businessEffect: { businessEffectId: "effect-1", commitState: "prepared" },
      execution: { toolExecutionId: "execution-1", status: "prepared" },
    });
    expect(executedSql).toHaveLength(2);
    expect(executedSql[1]).toContain("execution_profile_version");
    expect(executedSql[1]).toContain("termination_cause");
    expect(executedValues[1]).toHaveLength(21);
    expect(executedValues[1]?.[18]).toBeNull();
    expect(executedValues[1]?.[19]).toBeNull();
    // A claimed execution is linked to its decision only once it is executing.
    expect(executedValues[1]?.[20]).toBeNull();
    expect(executedValues[1]).toContain("1.0");
    expect(JSON.stringify(executedValues[1])).toContain("env:BRAVE_API_KEY");
  });

  it("does not claim an already committed business effect", async () => {
    let insertedValues: readonly unknown[] | undefined;
    const db = new FakeSideEffectDatabase(async (text, values) => {
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM business_effects")) {
        return { rows: [businessEffectRow("committed")], rowCount: 1 };
      }
      if (text.includes("FROM tool_executions") && text.includes("status = 'committed'")) {
        return {
          rows: [{
            ...toolExecutionRow("committed", "result-ref-1"),
            termination_cause: "completed",
          }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        insertedValues = values;
        return {
          rows: [{
            ...toolExecutionRow("committed", "result-ref-1"),
            termination_cause: "completed",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare({ ...prepareInput, decisionId: "decision-2" })).resolves.toMatchObject({
      type: "existing_committed",
      execution: {
        resultRef: "result-ref-1",
        status: "committed",
        terminationCause: "completed",
      },
    });
    expect(insertedValues).toHaveLength(21);
    // The reusing submission is recorded as deduplicated, not as its own completion.
    expect(insertedValues?.[18]).toBe("deduplicated");
    expect(insertedValues?.[19]).toBeNull();
    // It keeps its own verified decision, so its approval still finds it (design §6.7).
    expect(insertedValues?.[20]).toBe("decision-2");
  });

  it("names the original committing execution and skips earlier reuses", async () => {
    const executedSql: string[] = [];
    const db = new FakeSideEffectDatabase(async (text) => {
      executedSql.push(text);
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM business_effects")) {
        return { rows: [businessEffectRow("committed")], rowCount: 1 };
      }
      if (text.includes("FROM tool_executions") && text.includes("status = 'committed'")) {
        return {
          rows: [{
            ...toolExecutionRow("committed", "result-ref-1"),
            tool_execution_id: "execution-original",
            termination_cause: "completed",
          }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        return {
          rows: [{
            ...toolExecutionRow("committed", "result-ref-1"),
            termination_cause: "deduplicated",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare(prepareInput)).resolves.toMatchObject({
      type: "existing_committed",
      originalExecutionId: "execution-original",
    });
    expect(
      executedSql.find((sql) => sql.includes("status = 'committed'"))
    ).toContain("termination_cause IS DISTINCT FROM 'deduplicated'");
  });

  it.each([
    ["prepared", "deduplicated"],
    ["unknown", "deduplicated"],
    ["compensated", null],
  ])("records the not-claimed termination for an original that is %s", async (commitState, cause) => {
    let insertedValues: readonly unknown[] | undefined;
    const db = new FakeSideEffectDatabase(async (text, values) => {
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM business_effects")) {
        return { rows: [businessEffectRow(commitState)], rowCount: 1 };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        insertedValues = values;
        return {
          rows: [{ ...toolExecutionRow("failed"), claim_disposition: "not_claimed" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await new PgBusinessEffectLedger(db).prepare(prepareInput);

    expect(insertedValues?.[18]).toBe(cause);
  });

  it("records a submission that cannot claim an in-flight effect as failed and not_claimed", async () => {
    let insertedValues: readonly unknown[] | undefined;
    const db = new FakeSideEffectDatabase(async (text, values) => {
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM business_effects")) {
        return { rows: [businessEffectRow("prepared")], rowCount: 1 };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        insertedValues = values;
        return {
          rows: [{ ...toolExecutionRow("failed"), claim_disposition: "not_claimed" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare(prepareInput)).resolves.toMatchObject({
      type: "not_claimed",
      execution: { status: "failed", claimDisposition: "not_claimed" },
    });
    expect(insertedValues?.[11]).toBe("failed");
    expect(insertedValues?.[19]).toBe("not_claimed");
  });

  it("reclaims a released effect with compare-and-set", async () => {
    const executedSql: string[] = [];
    const db = new FakeSideEffectDatabase(async (text) => {
      executedSql.push(text);
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("UPDATE business_effects")) {
        return { rows: [businessEffectRow("prepared")], rowCount: 1 };
      }
      if (text.includes("FROM business_effects")) {
        return {
          rows: [{ ...businessEffectRow("prepared"), released_at: now }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        return { rows: [toolExecutionRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    const result = await ledger.prepare(prepareInput);

    expect(result).toMatchObject({
      type: "claimed",
      execution: { status: "prepared" },
    });
    if (result.type !== "claimed") throw new Error("Expected a reclaimed effect");
    expect(result.businessEffect.releasedAt).toBeUndefined();
    const reclaim = executedSql.find((sql) => sql.includes("UPDATE business_effects"));
    expect(reclaim).toContain("released_at = NULL");
    expect(reclaim).toContain("released_at IS NOT NULL");
  });

  it("does not reclaim when another submission cleared released_at first", async () => {
    const db = new FakeSideEffectDatabase(async (text) => {
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("UPDATE business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM business_effects")) {
        return {
          rows: [{ ...businessEffectRow("prepared"), released_at: now }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        return {
          rows: [{ ...toolExecutionRow("failed"), claim_disposition: "not_claimed" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare(prepareInput)).resolves.toMatchObject({
      type: "not_claimed",
    });
  });

  it("rolls the reclaim back when the replay key already has an execution", async () => {
    const db = new FakeSideEffectDatabase(async (text) => {
      if (text.includes("INSERT INTO business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("UPDATE business_effects")) {
        return { rows: [businessEffectRow("prepared")], rowCount: 1 };
      }
      if (text.includes("FROM business_effects")) {
        return {
          rows: [{ ...businessEffectRow("prepared"), released_at: now }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO tool_executions")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(ledger.prepare(prepareInput)).resolves.toEqual({
      type: "unavailable",
      errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
    });
  });
});

describe("PgBusinessEffectLedger lock order", () => {
  function recordingLedger(effectRowCount = 1) {
    const executedSql: string[] = [];
    const executedValues: unknown[][] = [];
    const db = new FakeSideEffectDatabase(async (text, values) => {
      executedSql.push(text);
      executedValues.push([...(values ?? [])]);
      if (text.includes("UPDATE business_effects")) {
        return { rows: [], rowCount: effectRowCount };
      }
      return { rows: [], rowCount: 1 };
    });
    return { ledger: new PgBusinessEffectLedger(db), executedSql, executedValues };
  }

  it("releases the effect before failing the execution", async () => {
    const { ledger, executedSql, executedValues } = recordingLedger();

    await ledger.releaseClaim({
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      terminationCause: "failed_not_committed",
    });

    expect(executedSql[0]).toContain("UPDATE business_effects");
    expect(executedSql[0]).toContain("released_at = NOW()");
    expect(executedSql[0]).toContain("released_at IS NULL");
    expect(executedValues[0]).toEqual(["effect-1", "prepared"]);
    expect(executedSql[1]).toContain("UPDATE tool_executions");
    expect(executedSql[1]).toContain("status = 'failed'");
    expect(executedValues[1]).toEqual([
      "execution-1",
      "executing",
      "failed_not_committed",
    ]);
  });

  it("does not touch the execution when the effect is no longer releasable", async () => {
    const { ledger, executedSql } = recordingLedger(0);

    await expect(
      ledger.releaseClaim({
        businessEffectId: "effect-1",
        expectedEffectState: "prepared",
        toolExecutionId: "execution-1",
        expectedExecutionStatus: "executing",
      })
    ).rejects.toMatchObject({ name: "SideEffectStateConflictError" });
    expect(executedSql).toHaveLength(1);
  });

  it("moves the effect before the execution when marking an outcome unknown", async () => {
    const { ledger, executedSql, executedValues } = recordingLedger();

    await ledger.transitionBusinessEffectAndExecution({
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
      nextEffectState: "unknown",
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      nextExecutionStatus: "unknown",
    });

    expect(executedSql[0]).toContain("UPDATE business_effects");
    expect(executedValues[0]).toEqual(["effect-1", "prepared", "unknown"]);
    expect(executedSql[1]).toContain("UPDATE tool_executions");
    expect(executedValues[1]).toEqual(["execution-1", "executing", "unknown"]);
  });
});

describe("PgBusinessEffectLedger.transitionExecution", () => {
  it("persists the terminal cause with the execution status transition", async () => {
    let executedSql = "";
    let executedValues: readonly unknown[] | undefined;
    const db = new FakeSideEffectDatabase(async (text, values) => {
      executedSql = text;
      executedValues = values;
      return { rows: [], rowCount: 1 };
    });
    const ledger = new PgBusinessEffectLedger(db);

    await ledger.transitionExecution({
      toolExecutionId: "execution-1",
      expectedStatus: "executing",
      nextStatus: "failed",
      terminationCause: "failed_not_committed",
    });

    expect(executedSql).toContain("termination_cause");
    expect(executedValues).toEqual([
      "execution-1",
      "executing",
      "failed",
      null,
      "failed_not_committed",
    ]);
  });
});

describe("PgBusinessEffectLedger.commitExecutionAndBusinessEffect", () => {
  it("persists completed as the atomic commit termination cause", async () => {
    const executedSql: string[] = [];
    const executedValues: unknown[][] = [];
    const db = new FakeSideEffectDatabase(async (text, values) => {
      executedSql.push(text);
      executedValues.push([...(values ?? [])]);
      return { rows: [], rowCount: 1 };
    });
    const ledger = new PgBusinessEffectLedger(db);

    await ledger.commitExecutionAndBusinessEffect({
      toolExecutionId: "execution-1",
      expectedExecutionStatus: "executing",
      resultRef: "result-ref-1",
      terminationCause: "completed",
      businessEffectId: "effect-1",
      expectedEffectState: "prepared",
    });

    expect(executedSql[0]).toContain("UPDATE business_effects");
    expect(executedSql[1]).toContain("termination_cause");
    expect(executedValues[1]).toEqual([
      "execution-1",
      "executing",
      "result-ref-1",
      "completed",
    ]);
  });

  it("locks the business effect before the execution and stops when its CAS fails", async () => {
    const executedSql: string[] = [];
    const db = new FakeSideEffectDatabase(async (text) => {
      executedSql.push(text);
      if (text.includes("UPDATE tool_executions")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE business_effects")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const ledger = new PgBusinessEffectLedger(db);

    await expect(
      ledger.commitExecutionAndBusinessEffect({
        toolExecutionId: "execution-1",
        expectedExecutionStatus: "executing",
        resultRef: "result-ref-1",
        businessEffectId: "effect-1",
        expectedEffectState: "prepared",
      })
    ).rejects.toMatchObject({ name: "SideEffectStateConflictError" });
    expect(executedSql).toHaveLength(1);
    expect(executedSql[0]).toContain("UPDATE business_effects");
  });
});
