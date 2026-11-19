import { randomUUID } from "node:crypto";
import { guard, redact } from "./validation.mjs";

let cookie;
export async function request(route, body, { method = body === undefined ? "GET" : "POST", timeout = 120000 } = {}) {
  guard();
  const startedAt = new Date().toISOString();
  const headers = { "content-type": "application/json", "x-request-id": randomUUID() };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`http://127.0.0.1:8124${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { route, startedAt, finishedAt: new Date().toISOString(), status: response.status, body: value };
}

export function safe(value) {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /token|secret|password|credential|capability/i.test(key) ? "[OMITTED]" : safe(item)]));
  return typeof value === "string" ? redact(value) : value;
}

export async function createThread() {
  const result = await request("/api/langgraph/threads", { metadata: { spike: "apply-002" } });
  if (result.status !== 200 || typeof result.body.thread_id !== "string") throw Object.assign(Error("thread_create_failed"), { result });
  return result;
}
