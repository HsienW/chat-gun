import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("generation environment example", () => {
  const raw = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const entries = Object.fromEntries(raw.split(/\r?\n/u).filter((line) => /^[A-Z_]+=/u.test(line)).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  it("uses flash for every generation purpose and retains opt-in probes", () => {
    for (const key of ["QWEN_CHAT_MODEL", "QWEN_RESEARCH_MODEL", "QWEN_VISION_MODEL", "QWEN_TOOL_MODEL", "DEFAULT_MODEL", "CHAT_MODEL", "MATH_MODEL", "MCP_AGENT_MODEL", "SHOPPING_ASSISTANT_MODEL", "KB_EVAL_GENERATION_MODEL"]) {
      expect(entries[key], key).toBe("qwen3.5-flash");
    }
    expect(entries.LLM_THINKING_DEFAULT_ENABLED).toBe("false");
    expect(entries.SHOPPING_ASSISTANT_THINKING_ENABLED).toBe("false");
    expect(entries.RUN_QWEN_FLASH_PROBE).toBe("false");
    expect(entries.QWEN_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(raw).toContain("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(raw).toContain("API Key 依區域分開");
  });
  it("contains no nonempty credential or connection value", () => {
    for (const [key, value] of Object.entries(entries)) {
      if (/(?:API_KEY|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES_URI|REDIS_URI)$/u.test(key)) expect(value, key).toBe("");
    }
  });
  it("keeps the existing embedding, rerank and judge example settings absent", () => {
    expect(Object.keys(entries).filter((key) => /EMBEDDING|RERANK|JUDGE/u.test(key))).toEqual([]);
  });
});
