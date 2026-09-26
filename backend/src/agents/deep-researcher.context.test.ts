import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deep researcher context architecture", () => {
  it("routes planner and synthesis context through the shared boundary", () => {
    const source = readFileSync(new URL("./deep-researcher.ts", import.meta.url), "utf8");
    expect(source.match(/assembleAgentContext/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source).toContain("activeState:");
    expect(source).not.toMatch(/contextPack\.(?:memory|memories)/i);
  });
});
