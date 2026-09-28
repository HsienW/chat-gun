import { describe, expect, it, vi } from "vitest";

import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import {
  createClarificationInterruptManifest,
  persistClarificationInterruptManifest,
} from "./clarification-manifest.js";

const executionManifest = {
  manifestVersion: "1.0.0",
  graphId: "deep_researcher",
  graphConfigHash: "a".repeat(64),
  schemaVersions: {
    runtimeEventEnvelope: "1.0.0",
    toolDescriptor: "1.0",
    authorizationPolicy: "1.0",
    normalizedInput: "1.0",
  },
} as const;

function createRepository(): InterruptManifestRepository {
  return {
    create: vi.fn(async (manifest) => manifest),
    findByInterruptId: vi.fn(async () => null),
    consume: vi.fn(async () => null),
    transitionStatus: vi.fn(async () => null),
  };
}

describe("clarification interrupt manifest", () => {
  it("creates a stable clarification manifest without a decisionRef", () => {
    const first = createClarificationInterruptManifest({
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      scopeId: "scope-1",
      round: 0,
      expectedResponseSchemaRef: "weather_clarification_resume@1.0",
      expiryAt: "2026-09-28T05:00:00.000Z",
      executionManifest,
      now: new Date("2026-09-28T04:00:00.000Z"),
    });
    const replay = createClarificationInterruptManifest({
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      scopeId: "scope-1",
      round: 0,
      expectedResponseSchemaRef: "weather_clarification_resume@1.0",
      expiryAt: "2026-09-28T05:00:00.000Z",
      executionManifest,
      now: new Date("2026-09-28T04:01:00.000Z"),
    });

    expect(first.interruptId).toBe(replay.interruptId);
    expect(first.kind).toBe("clarification");
    expect("decisionRef" in first).toBe(false);
  });

  it("reuses an existing manifest after node replay and rejects binding drift", async () => {
    const repository = createRepository();
    const manifest = createClarificationInterruptManifest({
      threadId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      scopeId: "scope-1",
      round: 0,
      expectedResponseSchemaRef: "weather_clarification_resume@1.0",
      expiryAt: "2026-09-28T05:00:00.000Z",
      executionManifest,
      now: new Date("2026-09-28T04:00:00.000Z"),
    });
    vi.mocked(repository.findByInterruptId).mockResolvedValueOnce(manifest);

    await expect(
      persistClarificationInterruptManifest(repository, {
        ...manifest,
        expiryAt: "2026-09-28T05:01:00.000Z",
        createdAt: "2026-09-28T04:01:00.000Z",
        updatedAt: "2026-09-28T04:01:00.000Z",
      })
    ).resolves.toEqual(manifest);
    expect(repository.create).not.toHaveBeenCalled();

    vi.mocked(repository.findByInterruptId).mockResolvedValueOnce({
      ...manifest,
      scopeId: "other-scope",
    });
    await expect(
      persistClarificationInterruptManifest(repository, manifest)
    ).rejects.toThrow("Clarification interrupt manifest binding conflict");
  });
});
