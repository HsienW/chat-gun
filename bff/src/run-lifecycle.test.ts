import { afterEach, describe, expect, it, vi } from "vitest";
import { HeldRunLifecycle, parseRunIdentity } from "./run-lifecycle.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const location = `/threads/${threadId}/runs/${runId}`;
const upstream = new URL(`http://upstream.fixture.test/api/threads/${threadId}/runs/stream`);

describe("held run lifecycle (LangGraph API 1.4.5)", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  function fixture(expiresAt = Date.now() + 40000) {
    const release = vi.fn(async () => {});
    const audit = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "interrupted" }), { status: 200 }));
    const lifecycle = new HeldRunLifecycle({ leases: [{ expiresAt, release }], acceptedAt: Date.now(), timeoutMs: 1000, requestId: "request-fixture", audit, fetcher });
    return { release, audit, fetcher, lifecycle };
  }
  it("reads the same verified Content-Location identity for stream and wait without trusting foreign origins", () => {
    expect(parseRunIdentity(location, upstream)).toEqual({ threadId, runId, url: `http://upstream.fixture.test/api${location}` });
    expect(parseRunIdentity(`/runs/${runId}`, upstream)).toBeUndefined();
    expect(parseRunIdentity(`https://foreign.fixture.test${location}`, upstream)).toBeUndefined();
    expect(parseRunIdentity("/threads/invalid/runs/invalid", upstream)).toBeUndefined();
    expect(parseRunIdentity(location, new URL(`http://upstream.fixture.test/threads/${runId}/runs/wait`))).toBeUndefined();
  });
  it("does not reset its absolute deadline when headers or an alternate upstream arrive", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(999);
    f.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), new URL(upstream.toString().replace("upstream.fixture.test", "alternate.fixture.test")), new Headers());
    f.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), upstream, new Headers());
    await vi.advanceTimersByTimeAsync(1);
    expect(f.lifecycle.controller.signal.aborted).toBe(true);
    await f.lifecycle.finish("abnormal");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["not_forwarded", "completed", "rejected"] as const)("releases once on %s without cancel", async outcome => {
    const f = fixture();
    await f.lifecycle.finish(outcome);
    await f.lifecycle.finish(outcome);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("interrupts first and releases only after terminal confirmation", async () => {
    const f = fixture();
    f.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), upstream, new Headers({ "x-request-id": "request-fixture" }));
    await f.lifecycle.finish("abnormal");
    expect(String(f.fetcher.mock.calls[0][0])).toBe(`http://upstream.fixture.test/api${location}/cancel?action=interrupt&wait=true`);
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(f.fetcher.mock.calls[1][0])).toBe(`http://upstream.fixture.test/api${location}`);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.audit).toHaveBeenCalledWith("run_cancel_confirmed", expect.objectContaining({ requestId: "request-fixture" }));
  });
  it("keeps capacity for TTL when identity is missing or cancel fails", async () => {
    const missing = fixture();
    await missing.lifecycle.finish("abnormal");
    expect(missing.release).not.toHaveBeenCalled();
    const failed = fixture();
    failed.fetcher.mockReset().mockResolvedValue(new Response("", { status: 503 }));
    failed.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), upstream, new Headers());
    await failed.lifecycle.finish("abnormal");
    expect(failed.release).not.toHaveBeenCalled();
    expect(failed.audit).toHaveBeenCalledWith("run_lease_retained", expect.objectContaining({ reason: "cancel_failed" }));
  });
  it("bounds the entire cancel plus confirmation by the same lease expiry", async () => {
    vi.useFakeTimers();
    const f = fixture(Date.now() + 100);
    f.fetcher.mockReset().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("cancel deadline")), { once: true });
    }));
    f.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), upstream, new Headers());
    const ending = f.lifecycle.finish("abnormal");
    await vi.advanceTimersByTimeAsync(100);
    await ending;
    expect(f.release).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith("run_lease_retained", expect.objectContaining({ reason: "confirmation_failed" }));
  });
  it("does not treat an unknown or nonterminal status as cancellation confirmation", async () => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{"status":"running"}'));
    f.lifecycle.observeResponse(new Response("", { headers: { "content-location": location } }), upstream, new Headers());
    await f.lifecycle.finish("abnormal");
    expect(f.release).not.toHaveBeenCalled();
  });
});
