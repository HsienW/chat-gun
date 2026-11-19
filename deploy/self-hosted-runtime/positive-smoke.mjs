import { compose, docker, must, containerRequest, record } from "./validation.mjs";
import { request, createThread, safe } from "./live-client.mjs";

const results = [];
try {
  results.push(must(docker([...compose, "config", "--quiet"])));
  results.push(must(docker([...compose, "up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "90", "runtime", "bff"])));
  const ready = containerRequest("chat-gun-runtime-spike-bff-1", "/api/ready");
  results.push(ready);
  const thread = await createThread();
  results.push(thread);
  record("positive", { results: safe(results), status: "in_progress" });
  const run = await request(`/api/langgraph/threads/${thread.body.thread_id}/runs/wait`, {
    assistant_id: "chatbot", input: { messages: [{ role: "user", content: "這是隔離部署驗證。請只回覆：測試成功。" }] }, on_disconnect: "cancel",
  });
  results.push(run);
  const state = await request(`/api/langgraph/threads/${thread.body.thread_id}/state`);
  results.push(state);
  const passed = ready.status === 200 && run.status === 200 && !run.body?.__error__ && Array.isArray(state.body?.values?.messages) && state.body.values.messages.some(m => m.type === "ai" || m.role === "assistant");
  record("positive", { results: safe(results), status: passed ? "pass" : "fail", realModel: true });
  console.log(JSON.stringify({ status: passed ? "pass" : "fail", run: safe(run), state: safe(state) }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  record("positive", { results: safe(results), status: "error", error: error.message, failed: safe(error.result || null), realModel: true });
  console.log(JSON.stringify({ status: "error", error: error.message, failed: safe(error.result || null) }));
  process.exitCode = 1;
}
