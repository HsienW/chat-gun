import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../persistence/rows.js";
import {
  durableInterruptManifestSchema,
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
} from "./interrupt-manifest.js";
import { PgInterruptManifestRepository } from "./interrupt-manifest-repository.js";

const interruptManifestMigration = readFileSync(
  new URL(
    "../persistence/migrations/019_create_interrupt_manifests.sql",
    import.meta.url
  ),
  "utf8"
);

const interruptManifestColumns = new Set(
  Array.from(
    interruptManifestMigration.matchAll(/^  ([a-z][a-z0-9_]*)\s+/gm),
    ([, column]) => column
  )
);

const executionManifest = {
  manifestVersion: "1.0.0",
  graphId: "deep_researcher",
  graphConfigHash: "a".repeat(64),
  deploymentVersion: "2026.09.28",
  schemaVersions: {
    runtimeEventEnvelope: "1.0.0",
    toolDescriptor: "1.0",
    authorizationPolicy: "1.0",
    normalizedInput: "1.0",
  },
} as const;

const clarificationManifest: DurableInterruptManifest = {
  interruptId: `clarification:${"b".repeat(64)}`,
  kind: "clarification",
  runId: "run-1",
  threadId: "thread-1",
  taskId: "task-1",
  stepId: "step-1",
  scopeId: "scope-1",
  expectedResponseSchemaRef: "weather_clarification_resume@1.0",
  expiryAt: "2026-09-28T05:00:00.000Z",
  executionManifest,
  status: "waiting",
  createdAt: "2026-09-28T04:00:00.000Z",
  updatedAt: "2026-09-28T04:00:00.000Z",
};

describe("DurableInterruptManifest", () => {
  it("strictly validates complete clarification correlation", () => {
    expect(parseDurableInterruptManifest(clarificationManifest)).toEqual(
      clarificationManifest
    );
    expect(() =>
      durableInterruptManifestSchema.parse({
        ...clarificationManifest,
        taskId: undefined,
      })
    ).toThrow();
    expect(() =>
      durableInterruptManifestSchema.parse({
        ...clarificationManifest,
        unexpected: true,
      })
    ).toThrow();
  });

  it("requires decisionRef only for confirmation manifests", () => {
    const confirmation = {
      ...clarificationManifest,
      interruptId: `confirmation:${"c".repeat(64)}`,
      kind: "confirmation" as const,
      expectedResponseSchemaRef: "tool_authorization_confirmation@1.0",
      decisionRef: {
        decisionId: "decision-1",
        approvalId: "d".repeat(64),
      },
    };

    expect(parseDurableInterruptManifest(confirmation)).toEqual(confirmation);
    expect(() =>
      parseDurableInterruptManifest({ ...confirmation, decisionRef: undefined })
    ).toThrow();
    expect(() =>
      parseDurableInterruptManifest({
        ...clarificationManifest,
        decisionRef: confirmation.decisionRef,
      })
    ).toThrow();
  });
});

describe("PgInterruptManifestRepository", () => {
  it("creates and reads a strict durable manifest", async () => {
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      text: string,
      _values: readonly unknown[] = []
    ) => {
      if (text.includes("INSERT INTO interrupt_manifests")) {
        return {
          rows: [{ manifest: clarificationManifest }] as unknown as TResult[],
          rowCount: 1,
        };
      }
      return {
        rows: [{ manifest: clarificationManifest }] as unknown as TResult[],
        rowCount: 1,
      };
    });
    const repository = new PgInterruptManifestRepository({ query } as Queryable);

    await expect(repository.create(clarificationManifest)).resolves.toEqual(
      clarificationManifest
    );
    await expect(
      repository.findByInterruptId(clarificationManifest.interruptId)
    ).resolves.toEqual(clarificationManifest);
    expect(query.mock.calls[0]?.[1]).toContain(clarificationManifest.runId);
  });

  it("atomically consumes waiting clarification once with full correlation", async () => {
    let consumed = false;
    const query = vi.fn(async <TResult extends Record<string, unknown>>(
      text: string,
      _values: readonly unknown[] = []
    ) => {
      if (text.includes("UPDATE interrupt_manifests") && !consumed) {
        consumed = true;
        return {
          rows: [
            {
              manifest: {
                ...clarificationManifest,
                status: "resumed",
                updatedAt: "2026-09-28T04:30:00.000Z",
              },
            },
          ] as unknown as TResult[],
          rowCount: 1,
        };
      }
      return { rows: [] as TResult[], rowCount: 0 };
    });
    const repository = new PgInterruptManifestRepository({ query } as Queryable);
    const consumeInput = {
      interruptId: clarificationManifest.interruptId,
      runId: clarificationManifest.runId,
      taskId: clarificationManifest.taskId,
      scopeId: clarificationManifest.scopeId,
      now: new Date("2026-09-28T04:30:00.000Z"),
    };

    const [first, replay] = await Promise.all([
      repository.consume(consumeInput),
      repository.consume(consumeInput),
    ]);

    expect([first, replay].filter(Boolean)).toHaveLength(1);
    const consumeSql = query.mock.calls[0]?.[0] ?? "";
    const expiryColumn =
      /\bAND\s+([a-z][a-z0-9_]*)\s+>\s+\$5\b/i.exec(consumeSql)?.[1];

    expect(consumeSql).toContain("status = 'waiting'");
    expect(consumeSql).toContain("expiry_at >");
    expect(expiryColumn).toBeDefined();
    expect(interruptManifestColumns).toContain(expiryColumn);
    expect(expiryColumn).toBe("expiry_at");
    expect(query.mock.calls[0]?.[1]).toEqual([
      clarificationManifest.interruptId,
      clarificationManifest.runId,
      clarificationManifest.taskId,
      clarificationManifest.scopeId,
      "2026-09-28T04:30:00.000Z",
    ]);
  });
});
