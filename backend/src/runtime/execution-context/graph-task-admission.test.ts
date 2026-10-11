import { describe, expect, it, vi } from "vitest";
import { PgGraphTaskAdmission } from "./graph-task-admission.js";
import { readExecutionContext } from "./read-execution-context.js";

const context = readExecutionContext(null, { configurable: {
  request_id: "request-1", thread_id: "thread-1", run_id: "run-1", task_id: "task-1",
} }, "development");

function database() {
  const rows: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    if (sql.startsWith("SELECT task_id")) return { rows: [...rows] };
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
    expect(await store.admit(context)).toBe("task-1");
    expect(await store.admit({ ...context, taskId: "unused-candidate" })).toBe("task-1");
    expect(rows).toHaveLength(1);
  });

  it("resumes only the same task, owner, thread and scope", async () => {
    const { store } = database();
    await store.admit(context);
    expect(await store.admit({ ...context, runId: "run-resume" }, "task-1")).toBe("task-1");
    await expect(store.admit({ ...context, threadId: "other-thread" }, "task-1")).rejects.toThrow();
    await expect(store.admit({ ...context, scope: { ...context.scope, scopeId: "other-scope" } }, "task-1")).rejects.toThrow();
    await expect(store.admit({ ...context, principal: { ...context.principal, principalId: "other-principal" } }, "task-1")).rejects.toThrow();
  });

  it("rejects an unknown resume task and releases the transaction", async () => {
    const { store, query, release } = database();
    await expect(store.admit(context, "missing-task")).rejects.toThrow();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed without a database", async () => {
    await expect(new PgGraphTaskAdmission(() => null).admit(context)).rejects.toThrow();
  });
});
