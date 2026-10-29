import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import { PgInterruptManifestRepository } from "./interrupt-manifest-repository.js";

describe("PgInterruptManifestRepository waiting confirmation lookup", () => {
  it("queries only waiting confirmation manifests for the thread and scope", async () => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      _text: string,
      _values: readonly unknown[] = []
    ) => ({ rows: [] as TResult[], rowCount: 0 }));
    const repository = new PgInterruptManifestRepository({ query } as Queryable);

    await expect(
      repository.findWaitingConfirmationByThread({
        threadId: "thread-1",
        scopeId: "scope-1",
      })
    ).resolves.toBeNull();

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("kind = 'confirmation'");
    expect(String(sql)).toContain("status = 'waiting'");
    expect(String(sql)).toContain("thread_id = $1");
    expect(String(sql)).toContain("scope_id = $2");
    expect(values).toEqual(["thread-1", "scope-1"]);
  });
});
