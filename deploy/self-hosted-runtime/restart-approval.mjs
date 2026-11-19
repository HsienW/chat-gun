import fs from "node:fs";
import { compose, docker, must, record, digest, guard, privateEnv, runtime } from "./validation.mjs";
import { request, createThread, safe } from "./live-client.mjs";

const results = {};
const commands = [];
if (process.argv.includes("--continue")) {
  guard();
  const prior = JSON.parse(fs.readFileSync(`${runtime}/artifacts/v1-apply-002.json`,"utf8"));
  record("v1-initial-attempt", { results:prior.results, commands:prior.commands, error:prior.error, status:prior.status,
    harnessCorrection:"interrupt type 應依公開契約為 tool_authorization_confirmation；保留原證據並沿用同一個真實 interrupt。" });
  Object.assign(results, prior.results);
  commands.push(...prior.commands);
}
function database() {
  const script = `import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const results={};for(const t of ['business_effects','tool_executions','tool_execution_attempts','order_operation_requests'])results[t]=(await c.query('SELECT * FROM '+t)).rows;await c.end();console.log(JSON.stringify(results));`;
  const result = must(docker(["exec", "--interactive", "chat-gun-runtime-spike-runtime-1", "node", "--input-type=module"], {input:script}));
  return safe(JSON.parse(result.stdout));
}
try {
  guard();
  const envPath = "deploy/self-hosted-runtime/.env.spike.local";
  if (!privateEnv.SHOPPING_ORDER_BINDING_ENABLED) {
    fs.appendFileSync(envPath, "\nSHOPPING_ORDER_BINDING_ENABLED=true\nSHOPPING_ORDER_BINDING_SOURCE_TENANT=synthetic-tenant\nSHOPPING_ORDER_BINDING_SOURCE_PRINCIPAL=synthetic-shopper-a\nSHOPPING_ORDER_BINDING_TARGET_TENANT=public\nSHOPPING_ORDER_BINDING_TARGET_OWNER=anonymous\nSHOPPING_ORDER_BINDING_EPOCH=spike-apply-002\n");
  }
  if (!results.threadId) {
  commands.push(must(docker([...compose, "up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "90", "runtime"])));
  results.binding = { source: "synthetic-tenant/synthetic-shopper-a", target: "public/anonymous", epoch: "spike-apply-002", purpose: "只綁定既有合成訂單至隔離 BFF 的實際 development principal；不變更授權政策。" };
  results.databaseBefore = database();
  const thread = await createThread();
  const id = thread.body.thread_id;
  results.threadId = id;
  results.interruptRun = await request(`/api/langgraph/threads/${id}/runs/wait`, {assistant_id:"shopping_assistant",input:{messages:[{role:"user",content:"請為我的訂單 ORD-1001 申請整張訂單退款，原因是商品損壞（damaged）。請提出審批，等我核准後才執行。"}]},on_disconnect:"cancel"});
  results.before = await request(`/api/langgraph/threads/${id}/state`);
  results.beforeHistory = await request(`/api/langgraph/threads/${id}/history`, {limit:100});
  }
  const id = results.threadId;
  record("v1", {results:safe(results),commands,status:"in_progress",realModel:true});
  const pending = results.before.body.tasks?.flatMap(task=>task.interrupts||[]).find(i=>i.value?.type==="tool_authorization_confirmation");
  if (!pending) throw Error("approval_interrupt_not_created");
  await new Promise(resolve=>setTimeout(resolve,4000));
  commands.push(must(docker([...compose,"stop","--timeout","15","runtime"])));
  commands.push(must(docker([...compose,"up","--detach","--wait","--wait-timeout","90","runtime"])));
  results.after = await request(`/api/langgraph/threads/${id}/state`);
  results.afterHistory = await request(`/api/langgraph/threads/${id}/history`,{limit:100});
  results.historyRetained = digest(results.beforeHistory.body)===digest(results.afterHistory.body);
  results.stateRetained = digest(results.before.body.values)===digest(results.after.body.values);
  const p = pending.value;
  const command = {resume:{type:p.type,schemaVersion:p.schemaVersion,approvalId:p.approvalId,decisionId:p.decisionId,decision:"approve"}};
  results.firstResume = await request(`/api/langgraph/threads/${id}/runs/wait`, {assistant_id:"shopping_assistant",command,on_disconnect:"cancel"});
  results.afterResume = await request(`/api/langgraph/threads/${id}/state`);
  results.replay = await request(`/api/langgraph/threads/${id}/runs/wait`, {assistant_id:"shopping_assistant",command,on_disconnect:"cancel"});
  results.databaseAfter = database();
  record("v1", {results:safe(results),commands,status:"measured",realModel:true});
  console.log(JSON.stringify({status:"measured",threadId:id,historyRetained:results.historyRetained,stateRetained:results.stateRetained,firstResume:safe(results.firstResume),replay:safe(results.replay),databaseAfter:results.databaseAfter}));
} catch(error) {
  record("v1", {results:safe(results),commands,status:"error",error:error.message,failed:safe(error.result||null),realModel:true});
  console.log(JSON.stringify({status:"error",error:error.message,threadId:results.threadId,failed:safe(error.result||null)}));
  process.exitCode=1;
}
