import { afterAll, describe, expect, it } from "vitest";

const langGraphBaseUrl = process.env.LANGGRAPH_SPIKE_BASE_URL;
const assistantId = process.env.LANGGRAPH_SPIKE_ASSISTANT_ID ?? "math_agent";
const describeLive = langGraphBaseUrl === undefined ? describe.skip : describe;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requestJson(pathname: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, langGraphBaseUrl), init);
  expect(response.ok, `${response.status} ${response.statusText}`).toBe(true);
  const payload: unknown = await response.json();
  expect(isRecord(payload)).toBe(true);
  if (!isRecord(payload)) {
    throw new Error("LangGraph API returned a non-object payload");
  }
  return payload;
}

async function waitForThreadToSettle(threadId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  let thread = await requestJson(`/threads/${threadId}`);
  while (thread.status === "busy" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    thread = await requestJson(`/threads/${threadId}`);
  }
  return thread;
}

describeLive("LangGraph Agent Server worker/queue signal spike", () => {
  let threadId: string | undefined;

  afterAll(async () => {
    if (threadId === undefined || langGraphBaseUrl === undefined) return;
    await fetch(new URL(`/threads/${threadId}`, langGraphBaseUrl), {
      method: "DELETE",
    });
  });

  it("exposes run/thread progress signals but no public claim, lease, or heartbeat", async () => {
    const thread = await requestJson("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(typeof thread.thread_id).toBe("string");
    threadId = String(thread.thread_id);

    const run = await requestJson(`/threads/${threadId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assistant_id: assistantId,
        input: { messages: [{ role: "user", content: "T0 signal spike" }] },
        interrupt_before: "*",
        stream_mode: "values",
      }),
    });
    expect(typeof run.run_id).toBe("string");

    const runRead = await requestJson(`/threads/${threadId}/runs/${String(run.run_id)}`);
    const threadRead = await waitForThreadToSettle(threadId);
    const runKeys = Object.keys(runRead);
    const threadKeys = Object.keys(threadRead);
    const workerSignalPattern = /heartbeat|lease|claim|worker/i;

    expect(runRead.status).toMatch(/^(pending|running|success|error|timeout|interrupted)$/);
    expect(runRead.created_at).toEqual(expect.any(String));
    expect(runRead.updated_at).toEqual(expect.any(String));
    expect(threadRead.status).toBe("interrupted");
    expect(threadRead.created_at).toEqual(expect.any(String));
    expect(threadRead.updated_at).toEqual(expect.any(String));
    expect(isRecord(threadRead.interrupts)).toBe(true);
    expect(runKeys.filter((key) => workerSignalPattern.test(key))).toEqual([]);
    expect(threadKeys.filter((key) => workerSignalPattern.test(key))).toEqual([]);
    expect(isRecord(runRead.kwargs) ? runRead.kwargs.interrupt_before : undefined).toBe("*");
  });
});
