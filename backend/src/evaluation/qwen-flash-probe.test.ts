import { describe, expect, it, vi } from "vitest";
import { runQwenFlashProbe } from "./qwen-flash-probe.js";

const settings = { isEnabled: true, endpoint: "https://example.test/v1?key=hidden", apiKey: "fake-secret", model: "configured-model", timeoutMs: 50 };
function validResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message: body.tools ? { tool_calls: [{ function: { name: "probe_echo", arguments: '{"ok":true}' } }] } : { content: body.response_format ? '{"ok":true}' : "ok" } }], usage: { completion_tokens_details: { reasoning_tokens: 0 } } }), { headers: { "content-type": "application/json" } });
}
describe("opt-in Qwen compatibility probe", () => {
  it("skips every request by default", async () => {
    const fetcher = vi.fn();
    const evidence = await runQwenFlashProbe({ ...settings, isEnabled: false }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(evidence.results.every((entry) => entry.status === "not_executed")).toBe(true);
  });
  it("fails closed before requesting when credentials are missing", async () => {
    const fetcher = vi.fn();
    const evidence = await runQwenFlashProbe({ ...settings, apiKey: "" }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(evidence.results.every((entry) => entry.errorCode === "missing_credentials")).toBe(true);
  });
  it("validates all five capabilities and returns safe evidence", async () => {
    const bodies: Record<string, unknown>[] = [];
    const evidence = await runQwenFlashProbe(settings, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body); return validResponse(body);
    });
    expect(evidence.results.map((entry) => entry.capability)).toEqual(["text", "json_object", "tool_calling", "vision", "thinking_off"]);
    expect(evidence.results.every((entry) => entry.status === "passed")).toBe(true);
    expect(bodies.every((body) => body.enable_thinking === false && body.model === settings.model)).toBe(true);
    expect(JSON.stringify(bodies[3])).toContain("data:image/png;base64,");
    const image = JSON.stringify(bodies[3]).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/u)![1]!;
    const png = Buffer.from(image, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      let crc = 0xffffffff;
      for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      expect((crc ^ 0xffffffff) >>> 0).toBe(png.readUInt32BE(offset + 8 + length));
      offset += length + 12;
    }
    expect(evidence.endpointHost).toBe("example.test");
    expect(JSON.stringify(evidence)).not.toMatch(/fake-secret|hidden|tool_calls|Authorization/u);
  });
  it("continues after provider, unsupported, schema and timeout failures", async () => {
    let index = 0;
    const evidence = await runQwenFlashProbe(settings, async (_url, init) => {
      switch (index++) {
        case 0: return new Response("secret upstream error", { status: 500 });
        case 1: return new Response("unsupported", { status: 400 });
        case 2: return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "wrong", arguments: "{}" } }] } }] }));
        case 3: return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
        default: return validResponse({});
      }
    });
    expect(evidence.results.map((entry) => entry.errorCode)).toEqual(["provider_error", "unsupported", "schema_invalid", "timeout", undefined]);
    expect(JSON.stringify(evidence)).not.toContain("secret upstream error");
  });
  it("preserves completed results and marks unfinished items not executed on cancellation", async () => {
    const controller = new AbortController(); let index = 0;
    const evidence = await runQwenFlashProbe({ ...settings, signal: controller.signal }, async (_url, init) => {
      if (index++ === 0) return validResponse({});
      controller.abort(); throw controller.signal.reason;
    });
    expect(evidence.results[0]?.status).toBe("passed");
    expect(evidence.results.slice(1).every((entry) => entry.status === "not_executed" && entry.errorCode === "cancelled")).toBe(true);
  });
  it("rejects malformed JSON content and nonzero reasoning tokens", async () => {
    const evidence = await runQwenFlashProbe(settings, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format) return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":"true"}' } }] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens_details: { reasoning_tokens: 2 } } }));
    });
    expect(evidence.results[1]?.errorCode).toBe("schema_invalid");
    expect(evidence.results[4]?.errorCode).toBe("schema_invalid");
  });
});
