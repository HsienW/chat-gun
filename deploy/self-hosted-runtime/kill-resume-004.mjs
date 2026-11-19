import fs from 'node:fs';
import {guard,record,runtime,compose,docker,must,request,createThread,database,safe,originalProject as project,runtimeContainer,waitReady,approvalCommand,audits} from './validation-004.mjs';
import {files,snapshot} from './observations-004.mjs';
import {counts,query,holdConfirmation,compareTerminals} from './approval-observations-004.mjs';
import {assessActivityWindow} from './activity-window-004.mjs';
import {assessEffectCounts} from './side-effect-verdict-004.mjs';
const timing=process.argv[2];if(!['before','after'].includes(timing))throw Error('explicit_timing_required');
const name=`v2c-${timing}`,r={case:`V2c-${timing}`,realModel:true,startedAt:new Date().toISOString(),commands:[]};
let lock,resumePromise;
try {
  guard();
  const previousPath=`${runtime}/artifacts/${name}-apply-004.json`;
  if(fs.existsSync(previousPath)) {
    const old=JSON.parse(fs.readFileSync(previousPath,'utf8'));
    if(!process.argv.includes('--retry-provider')||old.kill||old.run?.body?.turn?.failureCode!=='INTENT_ROUTING_PROVIDER_ERROR')throw Error('previous_attempt_requires_explicit_safe_continuation');
    const priorCounts=counts(database(project),old.threadId);
    if(priorCounts.successfulDispatches||priorCounts.committedEffects)throw Error('unsafe_provider_retry');
    record(`${name}-provider-attempt`,{...old,countsBeforeRetry:priorCounts,logs:must(docker(['logs','--timestamps','--since',old.startedAt,runtimeContainer(project)])),diagnosis:'intent routing provider_error 約 20 秒，尚未建立審批或 side-effect，僅允許一次同輸入重試；不修改模型、Prompt 或產品。'});
  }
  const prior=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v2b-stream-apply-004.json`,'utf8'));
  if(prior.status!=='pass')throw Error('v2b_not_passed');
  if(timing==='after'&&JSON.parse(fs.readFileSync(`${runtime}/artifacts/v2c-before-apply-004.json`,'utf8')).status!=='pass')throw Error('v2c_before_not_passed');
  r.ready=await waitReady();r.thread=await createThread();const id=r.threadId=r.thread.body.thread_id;
  r.run=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:'shopping_assistant',input:{messages:[{role:'user',content:`請為我的訂單 ${timing==='before'?'ORD-1001':'ORD-1002'} 申請整張訂單退款，原因是商品損壞（damaged）。請提出審批，等我核准後才執行。`}]},on_disconnect:'cancel'});
  r.waiting=await snapshot(id);r.command=approvalCommand(r.waiting.state.body);
  const approvalId=r.command.resume.approvalId;
  await new Promise(resolve=>setTimeout(resolve,3500));r.durableFiles=files(id);r.databaseBefore=database(project);r.countsBefore=counts(r.databaseBefore,id);
  if(r.countsBefore.successfulDispatches!==0)throw Error('unexpected_prior_dispatch');
  if(timing==='before') {
    lock=await holdConfirmation(approvalId);r.lock=lock.lock;
    resumePromise=request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:'shopping_assistant',command:r.command,on_disconnect:'cancel'}).catch(error=>({error:error.message,code:error.cause?.code}));
    r.blockedSamples=[];const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      const rows=query("SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[r.lock.pid]);
      r.blockedSamples.push({at:new Date().toISOString(),rows});if(rows.length)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(!r.blockedSamples.at(-1)?.rows.length)throw Error('pre_effect_boundary_not_observed');
  } else {
    r.firstResume=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:'shopping_assistant',command:r.command,on_disconnect:'cancel'});
  }
  r.beforeKill=await snapshot(id);r.databaseAtKill=database(project);r.countsAtKill=counts(r.databaseAtKill,id);r.filesBefore=files(id);
  if(r.countsAtKill.successfulDispatches!==(timing==='before'?0:1))throw Error('wrong_side_effect_boundary');
  if(r.filesBefore.files.find(f=>f.path.includes('checkpointer')).sha256!==r.durableFiles.files.find(f=>f.path.includes('checkpointer')).sha256)throw Error('checkpoint_already_flushed');
  record(name,{...safe(r),status:'before_kill'});
  r.kill=must(docker(['kill','--signal','KILL',runtimeContainer(project)]));r.killedState=must(docker(['inspect','--format','{{json .State}}',runtimeContainer(project)]));
  if(resumePromise)r.firstResume=await resumePromise;
  r.commands.push(must(docker([...compose(project),'up','--detach','--wait','--wait-timeout','90','runtime'])));r.readyAfter=await waitReady();
  r.afterRestart=await snapshot(id);r.databaseAfterRestart=database(project);r.countsAfterRestart=counts(r.databaseAfterRestart,id);
  r.restoredCommand=approvalCommand(r.afterRestart.state.body);
  const since=new Date().toISOString();
  r.secondResume=await request(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:'shopping_assistant',command:r.restoredCommand,on_disconnect:'cancel'});
  r.final=await snapshot(id);r.databaseFinal=database(project);r.finalCounts=counts(r.databaseFinal,id);r.audit=audits(project,since);
  r.transitions=compareTerminals(r.beforeKill.runs.body,Array.isArray(r.afterRestart.runs.body)?r.afterRestart.runs.body:[]);
  const baselineIds=r.waiting.history.body.map(v=>v.checkpoint?.checkpoint_id);
  const afterIds=new Set(r.afterRestart.history.body?.map?.(v=>v.checkpoint?.checkpoint_id)||[]);
  r.loss=assessActivityWindow({before:r.beforeKill.history.body,after:r.afterRestart.history.body,lastWriteAt:r.durableFiles.files.map(f=>f.mtime).sort().at(-1),killAt:JSON.parse(r.killedState.stdout).FinishedAt,durableBaselinePreserved:baselineIds.every(v=>afterIds.has(v))});
  r.effectVerdict=assessEffectCounts(r.countsAtKill,r.finalCounts,timing==='before'?0:1);
  r.hardInvariants={noDuplicate:r.effectVerdict.noDuplicate,noTerminalRegression:r.transitions.every(v=>!v.regressed),deserializable:r.afterRestart.state.status===200&&r.afterRestart.history.status===200&&r.final.state.status===200};
  r.checks={...r.hardInvariants,restoredWaiting:r.restoredCommand.resume.approvalId===approvalId,lossInBoundary:r.loss.status==='pass',appropriateKillBoundary:r.countsAtKill.successfulDispatches===(timing==='before'?0:1),replayedAfterEffectSafe:timing==='before'||(r.loss.lost.length>0&&r.audit.rejectedCount>=1&&r.countsAfterRestart.successfulDispatches===1)};
  r.checks.countRetained=r.effectVerdict.countRetained;
  r.preventedBy=timing==='after'?'PgAuthorizationConfirmationStore.consume：authorization_confirmations 的 status=pending 條件式更新僅能消費一次；既有 approved 資料使第二次 UPDATE 無資料，回 CONFIRMATION_REPLAYED_OR_EXPIRED 並 audit，未進 physicalDispatch。':'初次 consume SQL 被列鎖擋住，SIGKILL 時 dispatch=0。連線終止解除列鎖後，伺服器端已送出的 consume SQL 仍完成，approved 保留；重啟再次核准因非 pending 被拒，最終 dispatch=0，訂單 operation failed。';
  r.status=Object.values(r.checks).every(Boolean)?'pass':'fail';record(name,safe(r));
  console.log(JSON.stringify({status:r.status,case:r.case,checks:r.checks,countsAtKill:r.countsAtKill,finalCounts:r.finalCounts,rejectedAudit:r.audit.rejectedCount,loss:r.loss,transitions:r.transitions,preventedBy:r.preventedBy}));
  if(r.status!=='pass')process.exitCode=1;
}catch(error){record(name,{...safe(r),status:'error',error:error.message,code:error.cause?.code,failed:safe(error.result||null)});console.log(JSON.stringify({status:'error',case:r.case,error:error.message,code:error.cause?.code,failed:safe(error.result||null)}));process.exitCode=1;}
finally{if(lock){try{query('SELECT pg_terminate_backend($1)',[lock.lock.pid]);}catch{}lock.worker.kill();}}
