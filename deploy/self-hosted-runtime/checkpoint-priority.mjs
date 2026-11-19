import { compose, docker, must, record, digest } from "./validation.mjs";
import { request, createThread, safe } from "./live-client.mjs";

const cases = [];
const commands = [];
function files() {
  const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const ids=${JSON.stringify(cases.map(c=>c.threadId))};function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(d=>{const f=path.join(p,d.name);if(d.isDirectory())return walk(f);const b=fs.readFileSync(f);return [{path:f,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),threadIds:ids.filter(id=>b.includes(Buffer.from(id)))}]})}console.log(JSON.stringify(walk('.langgraph_api')))`;
  const result = must(docker(["exec", "chat-gun-runtime-spike-runtime-1", "node", "-e", script]));
  return { command: result.command, at: result.finishedAt, files: JSON.parse(result.stdout) };
}
try {
  for (const [graph, content] of [["shopping_assistant", "請簡短說明退貨政策。"], ["deep_researcher", "用一句話說明什麼是二分搜尋，不需要網路研究。"]]) {
    const thread = await createThread();
    const row = { graph, threadId: thread.body.thread_id, createThread: thread };
    cases.push(row);
    record("v0", { cases: safe(cases), commands, status: "in_progress", realModel: true });
    row.run = await request(`/api/langgraph/threads/${row.threadId}/runs/wait`, { assistant_id: graph, input: { messages: [{ role: "user", content }] }, on_disconnect: "cancel" });
    row.before = await request(`/api/langgraph/threads/${row.threadId}/state`);
    row.beforeHistory = await request(`/api/langgraph/threads/${row.threadId}/history`, { limit: 100 });
    record("v0", { cases: safe(cases), commands, status: "in_progress", realModel: true });
    if (row.run.status !== 200 || row.run.body?.__error__ || row.before.status !== 200 || !row.before.body?.checkpoint) throw Error(`graph_run_failed:${graph}`);
  }
  // 等待超過已知 3 秒 debounce；這是待測持久化窗口，不用延遲掩蓋 race。
  await new Promise(resolve => setTimeout(resolve, 4000));
  const persistedBefore = files();
  commands.push(must(docker([...compose, "stop", "--timeout", "15", "runtime"])));
  commands.push(must(docker([...compose, "up", "--detach", "--wait", "--wait-timeout", "90", "runtime"])));
  const persistedAfter = files();
  for (const row of cases) {
    row.after = await request(`/api/langgraph/threads/${row.threadId}/state`);
    row.afterHistory = await request(`/api/langgraph/threads/${row.threadId}/history`, { limit: 100 });
    row.retained = row.after.status === 200 && digest(row.before.body.values) === digest(row.after.body.values);
    row.historyRetained = row.afterHistory.status === 200 && digest(row.beforeHistory.body) === digest(row.afterHistory.body);
    row.checkpointFilePaths = persistedBefore.files.filter(f => /checkpoint/i.test(f.path) && f.threadIds.includes(row.threadId)).map(f=>f.path);
  }
  record("v0", { cases: safe(cases), commands, persistedBefore, persistedAfter, status: "measured", realModel: true });
  console.log(JSON.stringify({status:"measured",cases:cases.map(({graph,threadId,retained,historyRetained,checkpointFilePaths})=>({graph,threadId,retained,historyRetained,checkpointFilePaths})),files:persistedBefore}));
} catch (error) {
  record("v0", { cases: safe(cases), commands, status: "error", error: error.message, failed: safe(error.result || null), realModel: true });
  console.log(JSON.stringify({status:"error",error:error.message,cases:safe(cases),failed:safe(error.result || null)}));
  process.exitCode = 1;
}
