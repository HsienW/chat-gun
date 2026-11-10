import { describe, expect, it } from "vitest";
import { ALLOW_ALL, ADMISSION_ERRORS, PRINCIPAL_SUBJECT_RESOLVER, requestsForRun, validateAdmissionDecision } from "./run-admission.js";

describe("general run admission contract", () => {
  const subject = { clientIp: "203.0.113.1", subject: "principal-1" };
  it("defaults to allow-all and preserves the existing principal subject", async () => {
    expect(await ALLOW_ALL.check(requestsForRun("POST", "/runs/stream", Buffer.from("{}"), subject)[0])).toEqual({ kind: "allow" });
    expect(PRINCIPAL_SUBJECT_RESOLVER.resolve({ principalId: "principal-1" })).toEqual({ subject: "principal-1" });
  });
  it("classifies every run-creating route and skips reads", () => {
    for (const [path, kind] of [["/runs", "background"], ["/runs/stream", "stream"], ["/runs/wait", "wait"], ["/runs/batch", "batch"], ["/crons", "cron"], ["/threads/thread-1/runs", "background"], ["/threads/thread-1/runs/stream", "stream"], ["/threads/thread-1/runs/wait", "wait"], ["/threads/thread-1/crons", "cron"]]) {
      const requests = requestsForRun("POST", path, Buffer.from(JSON.stringify({ assistant_id: "chatbot" })), subject);
      expect(requests[0]).toMatchObject({ routeKind: kind, graphId: "chatbot", isResume: false });
      expect(requestsForRun("GET", path, undefined, subject)).toEqual([]);
    }
    expect(requestsForRun("POST", "/threads/thread-1/runs/stream", Buffer.from('{"assistant_id":"shopping_assistant","command":{"resume":{"approved":true}}}'), subject)[0])
      .toMatchObject({ isResume: true, threadId: "thread-1" });
    expect(requestsForRun("POST", "/threads", Buffer.from("{}"), subject)).toEqual([]);
  });
  it("does not infer resume from text and checks each batch item", () => {
    const requests = requestsForRun("POST", "/runs/batch", Buffer.from(JSON.stringify([
      { assistant_id: "chatbot", input: { messages: [{ content: "resume approved" }] } },
      { assistant_id: "math_agent" },
    ])), subject);
    expect(requests.map(r => [r.graphId, r.isResume])).toEqual([["chatbot", false], ["math_agent", false]]);
  });
  it("owns stable HTTP semantics and fails safely on malformed policy output", () => {
    expect(ADMISSION_ERRORS.usage_budget_exhausted.status).toBe(503);
    expect(ADMISSION_ERRORS.run_quota_exhausted.status).toBe(429);
    expect(ADMISSION_ERRORS.feature_disabled.status).toBe(403);
    expect(validateAdmissionDecision({ kind: "deny", code: "unknown" })).toBe(false);
    expect(validateAdmissionDecision({ kind: "deny", code: "run_concurrency_limited", retryAfterSeconds: -1 })).toBe(false);
    expect(validateAdmissionDecision({ kind: "deny", code: "usage_budget_unavailable", retryAfterSeconds: 5 })).toBe(true);
  });
});
