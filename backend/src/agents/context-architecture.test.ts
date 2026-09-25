import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentFiles = [
  "chatbot.ts",
  "math-agent.ts",
  "mcp-agent.ts",
  "deep-researcher.ts",
] as const;

describe("production agent context architecture", () => {
  it.each(agentFiles)("does not directly use deprecated last-N assembly in %s", (file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(source).not.toContain("buildConversationContext");
  });

  it("does not spread unbounded MCP state into the model input", () => {
    const source = readFileSync(new URL("./mcp-agent.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.\.\.state\.messages/);
  });

  it.each(["chatbot.ts", "math-agent.ts", "mcp-agent.ts"])(
    "explicitly rethrows non-context errors in %s",
    (file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain(
        "if (!isContextHardLimitError(error)) throw error;"
      );
    }
  );
});
