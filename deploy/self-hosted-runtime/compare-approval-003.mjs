import fs from "node:fs";
import { guard,record,runtime,compose,docker,must,environment,database,audits,request,createThread,approvalCommand,digest,safe,originalProject,markTask,waitReady } from "./validation-003.mjs";

const legacyProject="chat-gun-runtime-spike-v1-legacy";
const result={commands:[],realModel:true};
if(process.argv.includes("--continue-legacy")) {
  guard();const prior=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v1-comparison-apply-003.json`,"utf8"));
  if(prior.status!=="error"||!prior.legacy||prior.legacy.threadId)throw Error("unsafe_legacy_continuation");
  record("v1-comparison-initial-attempt",prior);
  Object.assign(result,prior,{status:"in_progress"});delete result.error;delete result.failed;
}
function countEffects(db,threadId) {
  const executions=db.tool_executions.filter(row=>row.thread_id===threadId);
  const ids=new Set(executions.map(row=>row.tool_execution_id));
  const effects=new Set(executions.filter(row=>row.status==="committed").map(row=>row.business_effect_id));
  return {committedEffects:db.business_effects.filter(row=>effects.has(row.business_effect_id)&&row.commit_state==="committed").length,
    successfulDispatches:db.tool_execution_attempts.filter(row=>ids.has(row.tool_execution_id)&&row.outcome==="succeeded").length};
}
try {
  guard();
  const prior=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v1-apply-002.json`,"utf8")).results;
  const supplement=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v1-supplement-apply-002.json`,"utf8"));
  if(!result.legacy) {
  result.commands.push(must(docker([...compose(originalProject),"up","--detach","--wait","--wait-timeout","90","runtime","bff"])));
  const custom={baselineEvidence:["v1-apply-002","v1-supplement-apply-002"],threadId:prior.threadId,
    baselineReplay:prior.replay,baselineRuns:supplement.results.runs,runtimeEnvironment:environment(originalProject),bffEnvironment:environment(originalProject,"bff")};
  result.custom=custom;
  const auditSince=new Date().toISOString();
  const command=approvalCommand(prior.before.body);
  custom.auditProbeReplay=await request(`/api/langgraph/threads/${prior.threadId}/runs/wait`,{assistant_id:"shopping_assistant",command,on_disconnect:"cancel"});
  custom.auditProbeRuns=await request(`/api/langgraph/threads/${prior.threadId}/runs?limit=20`);
  custom.database=database(originalProject);
  custom.audit=audits(originalProject,auditSince);
  custom.audit.note="002 的容器 logs 已清理，不能回溯宣稱原第二次呼叫沒有 audit；本輪只重放同一已消費 interrupt 補查 audit，完整 V1 沿用原證據。";
  custom.counts=countEffects(custom.database,custom.threadId);
  record("v1-comparison",{...safe(result),status:"in_progress"});
  result.commands.push(must(docker([...compose(originalProject),"down"])));
  const legacy={};result.legacy=legacy;
  result.commands.push(must(docker([...compose(legacyProject,true),"up","--detach","--wait","--wait-timeout","90","ledger","knowledge-postgres"])));
  result.commands.push(must(docker([...compose(legacyProject,true),"run","--rm","--no-deps","runtime","npm","run","migrations:up"])));
  result.commands.push(must(docker([...compose(legacyProject,true),"up","--detach","--wait","--wait-timeout","90","runtime","bff"])));
  legacy.runtimeEnvironment=environment(legacyProject);legacy.bffEnvironment=environment(legacyProject,"bff");
  legacy.beforeDatabase=database(legacyProject);
  }
  const custom=result.custom,legacy=result.legacy;
  legacy.hostReady=await waitReady();
  const thread=await createThread();legacy.threadId=thread.body.thread_id;
  const id=legacy.threadId;
  legacy.run=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:"shopping_assistant",input:{messages:[{role:"user",content:prior.before.body.values.messages[0].content}]},on_disconnect:"cancel"});
  legacy.before=await request(`/api/langgraph/threads/${id}/state`);
  legacy.historyBefore=await request(`/api/langgraph/threads/${id}/history`,{limit:100});
  const resume=approvalCommand(legacy.before.body);
  record("v1-comparison",{...safe(result),status:"in_progress"});
  await new Promise(resolve=>setTimeout(resolve,4000));
  result.commands.push(must(docker([...compose(legacyProject,true),"stop","--timeout","15","runtime"])));
  result.commands.push(must(docker([...compose(legacyProject,true),"up","--detach","--wait","--wait-timeout","90","runtime"])));
  legacy.after=await request(`/api/langgraph/threads/${id}/state`);
  legacy.historyAfter=await request(`/api/langgraph/threads/${id}/history`,{limit:100});
  legacy.historyRetained=digest(legacy.historyBefore.body)===digest(legacy.historyAfter.body);
  legacy.stateRetained=digest(legacy.before.body.values)===digest(legacy.after.body.values);
  legacy.firstResume=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:"shopping_assistant",command:resume,on_disconnect:"cancel"});
  legacy.runsBeforeReplay=await request(`/api/langgraph/threads/${id}/runs?limit=20`);
  const since=new Date().toISOString();
  legacy.replay=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:"shopping_assistant",command:resume,on_disconnect:"cancel"});
  legacy.runs=await request(`/api/langgraph/threads/${id}/runs?limit=20`);
  legacy.audit=audits(legacyProject,since);legacy.database=database(legacyProject);legacy.counts=countEffects(legacy.database,id);
  const oldRuns=new Set(legacy.runsBeforeReplay.body.map(row=>row.run_id));
  legacy.replayRun=legacy.runs.body.find(row=>!oldRuns.has(row.run_id));
  const legacySucceeded=legacy.firstResume.status===200&&Object.values(legacy.firstResume.body.operations||{}).some(o=>o.state==="confirmed");
  const customRun=custom.baselineRuns.body.find(row=>row.created_at===prior.replay.startedAt)||custom.baselineRuns.body.at(-1);
  const checks={sameRuntimeEnvironment:custom.runtimeEnvironment.sha256===legacy.runtimeEnvironment.sha256,
    sameBffEnvironment:custom.bffEnvironment.sha256===legacy.bffEnvironment.sha256,
    sameReplayHttp:prior.replay.status===legacy.replay.status,
    sameReplayRun:customRun?.status===legacy.replayRun?.status,
    sameNoopResponse:digest(prior.firstResume.body)===digest(prior.replay.body)&&digest(legacy.firstResume.body)===digest(legacy.replay.body),
    sameRejectedAudit:custom.audit.rejectedCount===legacy.audit.rejectedCount,
    legacySucceeded,legacyHistoryRetained:legacy.historyRetained,legacyStateRetained:legacy.stateRetained,
    customEffectsOnce:custom.counts.committedEffects===1&&custom.counts.successfulDispatches===1,
    legacyEffectsOnce:legacy.counts.committedEffects===1&&legacy.counts.successfulDispatches===1};
  const passed=Object.values(checks).every(Boolean);
  result.checks=checks;result.status=passed?"pass":"fail";
  result.existingProductGap=passed&&legacy.replay.status===200&&legacy.audit.rejectedCount===0?"兩邊均 no-op／success，沒有 authorization.confirmation.rejected audit；記為既有產品規格缺口。":null;
  result.commands.push(must(docker([...compose(legacyProject,true),"down"])));
  record("v1-comparison",safe(result));
  if(passed)markTask("2.1");else process.exitCode=1;
  console.log(JSON.stringify({status:result.status,checks,customCounts:custom.counts,legacyCounts:legacy.counts,customAudit:custom.audit.rejectedCount,legacyAudit:legacy.audit.rejectedCount,replayRun:legacy.replayRun?.status}));
}catch(error){record("v1-comparison",{...safe(result),status:"error",error:error.message,causeCode:error.cause?.code||null,failed:safe(error.result||null)});console.log(JSON.stringify({status:"error",error:error.message,causeCode:error.cause?.code||null,failed:safe(error.result||null)}));process.exitCode=1;}
