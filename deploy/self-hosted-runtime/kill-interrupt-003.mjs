import {guard,record,compose,docker,must,request,createThread,database,execNode,safe,originalProject,runtimeContainer,waitReady,digest} from "./validation-003.mjs";
import {assessCrash} from "./crash-verdict-003.mjs";
import {assessLossWindow} from "./loss-window-003.mjs";

const project=originalProject;
const result={case:"V2a",realModel:true,commands:[]};
function files(id) {
  const code=`import fs from 'node:fs';import crypto from 'node:crypto';const id=process.argv[2];const files=fs.readdirSync('.langgraph_api').filter(p=>fs.statSync('.langgraph_api/'+p).isFile()).map(name=>{const path='.langgraph_api/'+name,b=fs.readFileSync(path);let selected;try{const j=JSON.parse(b);const storage=j.json?.storage;selected=storage?.[id];}catch{}return {path,bytes:b.length,mtime:fs.statSync(path).mtime.toISOString(),sha256:crypto.createHash('sha256').update(b).digest('hex'),containsThread:b.includes(Buffer.from(id)),serializedThreadStorage:selected}});console.log(JSON.stringify(files));`;
  const output=execNode(project,code,[id]);return {at:output.finishedAt,files:safe(JSON.parse(output.stdout))};
}
try {
  guard();
  result.commands.push(must(docker([...compose(project),"up","--detach","--wait","--wait-timeout","90","runtime","bff"])));
  result.hostReady=await waitReady();
  result.databaseBefore=database(project);
  result.thread=await createThread();const id=result.thread.body.thread_id;
  result.threadId=id;
  record("v2-interrupt",{...safe(result),status:"in_progress"});
  result.run=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:"shopping_assistant",input:{messages:[{role:"user",content:"請為我的訂單 ORD-1002 申請整張訂單退款，原因是商品損壞（damaged）。請提出審批，等我核准後才執行。"}]},on_disconnect:"cancel"});
  result.beforeState=await request(`/api/langgraph/threads/${id}/state`);
  result.beforeHistory=await request(`/api/langgraph/threads/${id}/history`,{limit:100});
  result.beforeRuns=await request(`/api/langgraph/threads/${id}/runs?limit=20`);
  const interrupt=result.beforeState.body.tasks?.flatMap(task=>task.interrupts||[]).find(i=>i.value?.type==="tool_authorization_confirmation");
  if(!interrupt)throw Error("v2_interrupt_not_created");
  result.filesBefore=files(id);
  const created=Date.parse(result.beforeState.body.created_at);
  if(!Number.isFinite(created)||Date.now()-created>=3000)throw Error("kill_window_missed");
  result.interruptCheckpointAt=result.beforeState.body.created_at;
  // 先保存真實終止前觀察，再送 SIGKILL；不以假 state 代替。
  record("v2-interrupt",{...safe(result),status:"before_kill"});
  result.kill=must(docker(["kill","--signal","KILL",runtimeContainer(project)]));
  result.killedState=must(docker(["inspect","--format","{{json .State}}",runtimeContainer(project)]));
  result.interruptToKillMs=Date.parse(result.kill.startedAt)-created;
  record("v2-interrupt",{...safe(result),status:"killed"});
  result.commands.push(must(docker([...compose(project),"up","--detach","--wait","--wait-timeout","90","runtime"])));
  result.readyAfter=await waitReady();
  result.afterState=await request(`/api/langgraph/threads/${id}/state`);
  result.afterHistory=await request(`/api/langgraph/threads/${id}/history`,{limit:100});
  result.afterRuns=await request(`/api/langgraph/threads/${id}/runs?limit=20`);
  result.filesAfter=files(id);result.databaseAfter=database(project);
  result.logs=must(docker(["logs","--timestamps","--tail","150",runtimeContainer(project)]));
  const beforeRun=result.beforeRuns.body.at(-1);
  const afterRun=Array.isArray(result.afterRuns.body)?result.afterRuns.body.find(row=>row.run_id===beforeRun.run_id):undefined;
  const executions=result.databaseAfter.tool_executions.filter(row=>row.thread_id===id);
  const executionIds=new Set(executions.map(row=>row.tool_execution_id));
  const successfulDispatches=result.databaseAfter.tool_execution_attempts.filter(row=>executionIds.has(row.tool_execution_id)&&row.outcome==="succeeded").length;
  result.verdict=assessCrash({beforeRun,afterRun,stateStatus:result.afterState.status,historyStatus:result.afterHistory.status,successfulDispatches});
  const beforeIds=Array.isArray(result.beforeHistory.body)?result.beforeHistory.body.map(s=>s.checkpoint?.checkpoint_id).filter(Boolean):[];
  const afterIds=Array.isArray(result.afterHistory.body)?result.afterHistory.body.map(s=>s.checkpoint?.checkpoint_id).filter(Boolean):[];
  result.loss={lostCheckpointIds:beforeIds.filter(id=>!afterIds.includes(id)),beforeMessages:result.beforeState.body.values?.messages?.length||0,afterMessages:result.afterState.body.values?.messages?.length||0,
    interruptBefore:true,interruptAfter:Boolean(result.afterState.body.tasks?.some(task=>task.interrupts?.length)),
    beforeRun,afterRun:afterRun||null,successfulDispatches,committedEffects:executions.filter(e=>e.status==="committed").length,
    lastPersistenceBeforeKill:result.filesBefore.files.map(f=>({path:f.path,mtime:f.mtime,containsThread:f.containsThread})),
    dataWindowFromLastPersistenceMs:result.filesBefore.files.map(f=>({path:f.path,milliseconds:Date.parse(result.kill.startedAt)-Date.parse(f.mtime)}))};
  result.lossWindow=assessLossWindow({before:Array.isArray(result.beforeHistory.body)?result.beforeHistory.body:[],after:Array.isArray(result.afterHistory.body)?result.afterHistory.body:[],killAt:result.kill.startedAt,windowMs:3000});
  result.status=result.verdict.status==="pass"&&result.lossWindow.status==="pass"?"pass":"fail";
  record("v2-interrupt",safe(result));
  console.log(JSON.stringify({status:result.status,threadId:id,interruptToKillMs:result.interruptToKillMs,verdict:result.verdict,loss:{lostCheckpointIds:result.loss.lostCheckpointIds,interruptAfter:result.loss.interruptAfter,successfulDispatches}}));
  if(result.status!=="pass")process.exitCode=1;
}catch(error){record("v2-interrupt",{...safe(result),status:"error",error:error.message,causeCode:error.cause?.code||null,failed:safe(error.result||null)});console.log(JSON.stringify({status:"error",error:error.message,causeCode:error.cause?.code||null,failed:safe(error.result||null)}));process.exitCode=1;}
