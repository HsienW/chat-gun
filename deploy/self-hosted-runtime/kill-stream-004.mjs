import {randomUUID} from 'node:crypto';
import {guard,record,compose,docker,must,request,createThread,safe,originalProject as project,runtimeContainer,waitReady,database,privateEnv} from './validation-004.mjs';
import {files,leases,snapshot,parseEvents} from './observations-004.mjs';
import {assessCrash} from './crash-verdict-003.mjs';
import {assessActivityWindow} from './activity-window-004.mjs';
const r={case:'V2b',realModel:true,startedAt:new Date().toISOString(),chunks:[],commands:[]};
try {
  guard();r.commands.push(must(docker([...compose(project),'up','--detach','--wait','--wait-timeout','90','ledger','knowledge-postgres'])));
  r.commands.push(must(docker([...compose(project),'run','--rm','--no-deps','runtime','npm','run','migrations:up'])));
  r.commands.push(must(docker([...compose(project),'up','--detach','--wait','--wait-timeout','90','runtime','bff'])));
  r.ready=await waitReady();
  r.thread=await createThread();r.threadId=r.thread.body.thread_id;const id=r.threadId;
  // 沒有 API 存取的等待，是本案例明確要求的寫檔邊界；檔案觀察不會重設 debounce。
  await new Promise(resolve=>setTimeout(resolve,3500));r.durableFiles=files(id);r.beforeLease=leases();
  const requestId=randomUUID();r.requestId=requestId;
  const response=await fetch(`http://127.0.0.1:8124/api/langgraph/threads/${id}/runs/stream`,{method:'POST',headers:{'content-type':'application/json','x-request-id':requestId,'connection':'close'},body:JSON.stringify({assistant_id:'chatbot',input:{messages:[{role:'user',content:'請用繁體中文分十二段，詳細說明資料備份與災難復原的步驟，每段至少四句話。這是串流傳輸驗證，請直接作答。'}]},stream_mode:['messages-tuple','updates','values','custom'],on_disconnect:'cancel',stream_resumable:false}),signal:AbortSignal.timeout(120000)});
  r.http={status:response.status,contentType:response.headers.get('content-type'),location:response.headers.get('content-location')};
  if(response.status!==200)throw Object.assign(Error('stream_rejected'),{result:await response.text()});
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',killed=false;
  while(true) {
    const part=await reader.read();if(part.done)break;const at=new Date().toISOString(),chunk=decoder.decode(part.value,{stream:true});
    r.chunks.push({at,bytes:part.value.length,text:safe(chunk)});text+=chunk;
    if(!killed&&parseEvents(text).some(e=>e.event==='values')) {
      r.before=await snapshot(id);r.leaseDuring=leases();r.filesBefore=files(id);
      if(r.before.runs.body.at(-1)?.status!=='running')throw Error('running_window_missed');
      record('v2b-stream',{...safe(r),status:'before_kill'});
      r.kill=must(docker(['kill','--signal','KILL',runtimeContainer(project)]));killed=true;
      r.killedState=must(docker(['inspect','--format','{{json .State}}',runtimeContainer(project)]));
    }
  }
  r.streamEndAt=new Date().toISOString();r.events=parseEvents(text);
  if(!killed)throw Error('stream_kill_trigger_not_seen');
  r.leaseAfterKill=leases();
  r.commands.push(must(docker([...compose(project),'up','--detach','--wait','--wait-timeout','90','runtime'])));r.readyAfter=await waitReady();
  r.after=await snapshot(id);r.filesAfter=files(id);r.databaseAfter=database(project);
  const beforeRun=r.before.runs.body.at(-1),afterRun=Array.isArray(r.after.runs.body)?r.after.runs.body.find(v=>v.run_id===beforeRun.run_id):undefined;
  r.hardInvariants=assessCrash({beforeRun,afterRun,stateStatus:r.after.state.status,historyStatus:r.after.history.status,successfulDispatches:0});
  const lastWriteAt=r.durableFiles.files.map(f=>f.mtime).sort().at(-1);
  r.loss=assessActivityWindow({before:Array.isArray(r.before.history.body)?r.before.history.body:[],after:Array.isArray(r.after.history.body)?r.after.history.body:[],lastWriteAt,killAt:JSON.parse(r.killedState.stdout).FinishedAt,durableBaselinePreserved:r.after.state.status===200});
  const expiresAt=Number(r.leaseDuring.members[1]);r.leasePolls=[];
  const deadline=expiresAt+2000;
  while(Date.now()<deadline) {const point=leases();r.leasePolls.push(point);if(point.members.length===0)break;await new Promise(resolve=>setTimeout(resolve,1000));}
  r.bffLogs=must(docker(['logs','--timestamps','--since',r.startedAt,`${project}-bff-1`]));
  r.checks={streamWasRunning:beforeRun.status==='running',identifiableError:r.events.some(e=>e.event==='error'&&e.data?.error?.code),leaseAcquired:r.leaseDuring.members.length===2,leaseReclaimed:r.leasePolls.at(-1)?.members.length===0,lossInBoundary:r.loss.status==='pass',hardInvariants:r.hardInvariants.status==='pass'};
  r.status=Object.values(r.checks).every(Boolean)?'pass':'fail';record('v2b-stream',safe(r));
  console.log(JSON.stringify({status:r.status,checks:r.checks,hardInvariants:r.hardInvariants,loss:r.loss,eventTypes:r.events.map(e=>e.event),leaseTtlMs:Number(privateEnv.DEMO_LEASE_TTL_MS)}));
  if(r.status!=='pass')process.exitCode=1;
}catch(error){record('v2b-stream',{...safe(r),status:'error',error:error.message,code:error.cause?.code,failed:safe(error.result||null)});console.log(JSON.stringify({status:'error',error:error.message,code:error.cause?.code,failed:safe(error.result||null)}));process.exitCode=1;}
