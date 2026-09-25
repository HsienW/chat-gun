import { describe, expect, it } from "vitest";

import { ContextPriority } from "./context-budget.js";
import { buildContextManifest } from "./context-manifest.js";

describe("ContextManifest", () => {
  it("contains references and token counts without raw content or credentials", () => {
    const manifest = buildContextManifest({
      blocks: [
        {
          priority: ContextPriority.P3,
          label: "Long-term memory",
          content: "email=user@example.test apiKey=secret",
          estimatedTokens: 10,
          source: "memory",
          referenceId: "memory-7",
        },
      ],
      totalTokens: 10,
      effectiveLimit: 100,
      compressionAction: "none",
    });

    const serialized = JSON.stringify(manifest);
    expect(manifest.sourceRefs).toEqual([
      {
        priority: ContextPriority.P3,
        kind: "memory",
        referenceId: "memory-7",
        estimatedTokens: 10,
      },
    ]);
    expect(serialized).not.toContain("user@example.test");
    expect(serialized).not.toContain("secret");
  });

  it("hashes non-memory references that could contain identifying data", () => {
    const manifest = buildContextManifest({
      blocks: [{
        priority: ContextPriority.P1,
        label: "Task",
        content: "safe",
        estimatedTokens: 1,
        source: "current_task",
        referenceId: "user@example.test",
      }],
      totalTokens: 1,
      effectiveLimit: 10,
      compressionAction: "none",
    });

    expect(manifest.sourceRefs[0]?.referenceId).toMatch(/^ref-[a-f0-9]{16}$/);
    expect(JSON.stringify(manifest)).not.toContain("user@example.test");
  });
});
