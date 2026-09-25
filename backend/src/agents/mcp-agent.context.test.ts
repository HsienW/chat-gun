import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mcp agent context architecture", () => {
  it("uses bounded shared context instead of spreading unbounded state messages", () => {
    const source = readFileSync(new URL("./mcp-agent.ts", import.meta.url), "utf8");
    expect(source).toContain("assembleMcpMessageContext");
    expect(source).not.toMatch(/\.\.\.state\.messages/);
  });
});
