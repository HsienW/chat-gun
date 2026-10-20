import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PgGraphTaskAdmission } from "./graph-task-admission.js";
import { readExecutionContext } from "./read-execution-context.js";

const context = readExecutionContext(null, { configurable: {
  request_id: "request-1", thread_id: "thread-1", run_id: "run-1", task_id: "task-1",
} }, "development");

function database() {
  const rows: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    if (sql.startsWith("SELECT task_id")) {
      return { rows: rows.filter((row) => {
        if (sql.includes("WHERE task_id")) return row.task_id === parameters?.[0];
        const metadata = z.object({ graphEntry: z.object({ initialRunId: z.string() }) }).parse(row.metadata);
        return metadata.graphEntry.initialRunId === parameters?.[0];
      }) };
    }
    if (sql.startsWith("INSERT INTO agent_tasks")) rows.push({ task_id: parameters?.[0], metadata: { graphEntry: parameters?.[1] } });
    return { rows: [] };
  });
  const release = vi.fn();
  const store = new PgGraphTaskAdmission(() => ({ connect: async () => ({ query, release }) }));
  return { store, query, release, rows };
}

describe("graph Task admission", () => {
  it("persists independent identity and reuses admission for a repeated native run", async () => {
    const { store, rows } = database();
    expect(await store.admit(context)).toEqual({ taskId: "task-1", runId: "run-1" });
    expect(await store.admit({ ...context, taskId: "unused-candidate" })).toEqual({ taskId: "task-1", runId: "run-1" });
    expect(rows).toHaveLength(1);
  });

  it("keeps concurrent native runs on one thread in separate product tasks", async () => {
    const { store, rows } = database();
    const first = await store.admit(context);
    const second = await store.admit({ ...context, runId: "run-2", taskId: "task-2" });
    expect([first, second]).toEqual([{ taskId: "task-1", runId: "run-1" }, { taskId: "task-2", runId: "run-2" }]);
    expect(rows).toHaveLength(2);
    expect(await store.admit({ ...context, taskId: "new-candidate" })).toEqual({ taskId: "task-1", runId: "run-1" });
  });

  it("resumes only the same task, owner, thread and scope", async () => {
    const { store } = database();
    await store.admit(context);
    expect(await store.admit({ ...context, runId: "run-resume" }, "task-1")).toEqual({ taskId: "task-1", runId: "run-1" });
    await expect(store.admit({ ...context, threadId: "other-thread" }, "task-1")).rejects.toThrow();
    await expect(store.admit({ ...context, scope: { ...context.scope, scopeId: "other-scope" } }, "task-1")).rejects.toThrow();
    await expect(store.admit({ ...context, principal: { ...context.principal, principalId: "other-principal" } }, "task-1")).rejects.toThrow();
  });

  it("rejects an unknown resume task and releases the transaction", async () => {
    const { store, query, release } = database();
    await expect(store.admit(context, "missing-task")).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed without a database", async () => {
    await expect(new PgGraphTaskAdmission(() => null).admit(context)).rejects.toThrow();
  });

  it("parks a legacy resume missing the versioned durable binding without mutating its row", async () => {
    const { store, rows } = database();
    rows.push({ task_id: "legacy-task", metadata: {} });
    const before = structuredClone(rows[0]);
    await expect(store.admit(context, "legacy-task")).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(rows[0]).toEqual(before);
  });

  it.each(["version", "tenant"] as const)("parks a durable %s mismatch and leaves its row unchanged", async (mismatch) => {
    const { store, rows } = database();
    await store.admit(context);
    const saved = z.object({ graphEntry: z.record(z.unknown()) }).parse(rows[0].metadata);
    rows[0].metadata = { graphEntry: { ...saved.graphEntry, ...(mismatch === "version" ? { correlationVersion: "9.0.0" } : { tenantId: "other-tenant" }) } };
    const before = structuredClone(rows[0]);
    await expect(store.admit(context, context.taskId)).rejects.toMatchObject({ code: "CHECKPOINT_PARKED" });
    expect(rows[0]).toEqual(before);
  });

  it("rolls back without inserting when cancellation arrives during admission", async () => {
    const controller = new AbortController();
    const { store, query, release, rows } = database();
    query.mockImplementationOnce(async () => { controller.abort(); return { rows: [] }; });
    await expect(store.admit(context, undefined, controller.signal)).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(rows).toHaveLength(0);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO agent_tasks"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
