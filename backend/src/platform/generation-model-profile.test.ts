import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { DEFAULT_GENERATION_MODEL, type DefaultGenerationModel } from "./generation-model-profile.js";

const MODEL_KEYS = [
  "QWEN_CHAT_MODEL", "QWEN_RESEARCH_MODEL", "QWEN_TOOL_MODEL", "QWEN_VISION_MODEL",
  "CHAT_MODEL", "MATH_MODEL", "MCP_AGENT_MODEL", "DEFAULT_MODEL",
] as const;
const PURPOSES = ["chat", "math", "research", "vision", "tool"] as const;

function clearModelSettings() {
  for (const key of MODEL_KEYS) vi.stubEnv(key, "");
}

describe("default generation model (D-10)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the literal type of the single default", () => {
    expectTypeOf(DEFAULT_GENERATION_MODEL).toEqualTypeOf<"qwen3.5-flash">();
    expectTypeOf<DefaultGenerationModel>().toEqualTypeOf<"qwen3.5-flash">();
    expect(DEFAULT_GENERATION_MODEL).toBe("qwen3.5-flash");
  });

  it("resolves every purpose, vision included, to the default when nothing is configured", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    clearModelSettings();
    vi.resetModules();
    const { resolveModelForPurpose } = await import("./llm-gateway.js");

    expect(PURPOSES.map((purpose) => resolveModelForPurpose(purpose))).toEqual(PURPOSES.map(() => DEFAULT_GENERATION_MODEL));
  });

  it("sends the default model on the wire for each purpose", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    vi.stubEnv("QWEN_BASE_URL", "http://provider.fixture.test/v1");
    clearModelSettings();
    vi.resetModules();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { llmGateway } = await import("./llm-gateway.js");

    for (const purpose of PURPOSES) await llmGateway.createChatModel({ purpose }).invoke("ping");

    expect(fetchMock.mock.calls.map((call) => (JSON.parse(String(call[1]?.body)) as { model: string }).model))
      .toEqual(PURPOSES.map(() => DEFAULT_GENERATION_MODEL));
  });

  it("keeps the resolution order: caller, purpose setting, legacy setting, default", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    clearModelSettings();
    vi.stubEnv("QWEN_RESEARCH_MODEL", "qwen3.7-plus");
    vi.stubEnv("MATH_MODEL", "legacy-math");
    vi.resetModules();
    const { resolveModelForPurpose } = await import("./llm-gateway.js");

    expect(resolveModelForPurpose("research")).toBe("qwen3.7-plus");
    expect(resolveModelForPurpose("research", "caller-model")).toBe("caller-model");
    expect(resolveModelForPurpose("math")).toBe("legacy-math");
    expect(resolveModelForPurpose("chat")).toBe(DEFAULT_GENERATION_MODEL);
    expect(resolveModelForPurpose("vision")).toBe(DEFAULT_GENERATION_MODEL);
  });

  it("keeps legacy aliases working", async () => {
    vi.stubEnv("LLM_PROVIDER", "qwen");
    clearModelSettings();
    vi.stubEnv("DEFAULT_MODEL", "legacy-default");
    vi.stubEnv("MCP_AGENT_MODEL", "legacy-tool");
    vi.resetModules();
    const { resolveModelForPurpose } = await import("./llm-gateway.js");

    expect(resolveModelForPurpose("chat")).toBe("legacy-default");
    expect(resolveModelForPurpose("vision")).toBe("legacy-default");
    expect(resolveModelForPurpose("tool")).toBe("legacy-tool");
  });
});
