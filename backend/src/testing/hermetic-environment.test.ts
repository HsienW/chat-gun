import { afterEach, describe, expect, it, vi } from "vitest";

// Guards the default (hermetic) test run configured in vitest.config.ts. If that isolation is
// removed, these assertions fail instead of letting local proxy or Opik settings leak into tests.

const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("hermetic default test environment", () => {
  it("loads the committed dotenv fixture instead of the runtime settings file", async () => {
    await import("../platform/env.js");

    expect(process.env.CHAT_GUN_TEST_ENV_SOURCE).toBe("hermetic-fixture");
  });

  it("clears every proxy variable and turns Opik export off", () => {
    for (const name of PROXY_VARIABLES) {
      expect(process.env[name] ?? "", name).toBe("");
    }
    expect(process.env.OPIK_ENABLED).toBe("false");
  });

  it("does not configure a proxy dispatcher when the LLM gateway loads", async () => {
    vi.resetModules();
    const info = vi.spyOn(console, "info");

    await import("../platform/llm-gateway.js");

    const proxyEvents = info.mock.calls.filter(
      ([message]) => typeof message === "string" && message.includes("network_proxy_configured")
    );
    expect(proxyEvents).toHaveLength(0);
  });

  it("uses the no-op Opik tracer by default", async () => {
    vi.resetModules();
    const tracing = await import("../platform/tracing/opik/opik-tracer.js");

    expect(tracing.getOpikTracer().constructor).toBe(
      tracing.createNoopOpikTracer().constructor
    );
  });
});

describe("explicit per-test overrides", () => {
  it("applies a value the test stubs explicitly", () => {
    vi.stubEnv("OPIK_ENABLED", "true");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");

    expect(process.env.OPIK_ENABLED).toBe("true");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
  });

  it("returns to the isolated values after the previous test", () => {
    expect(process.env.OPIK_ENABLED).toBe("false");
    expect(process.env.HTTPS_PROXY ?? "").toBe("");
  });
});
