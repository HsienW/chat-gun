import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {guard,record,runtime,compose,docker,must,request,safe,digest,waitReady,markTask,privateEnv} from './validation-004.mjs';
import {startSampler,longestWriteGap} from './resource-sampler-004.mjs';
const retryRate=process.argv.includes('--retry-rate');
const resumeSampler=process.argv.includes('--resume-sampler');
const project=retryRate||resumeSampler?'chat-gun-runtime-spike-v5b-004':'chat-gun-runtime-spike-v5-004';
const configuration=()=>[...compose(project),'--file','deploy/self-hosted-runtime/resource-004.yaml'];
let r={case:'V5',fakeModelEndpoint:true,modelSemanticAcceptance:false,project,startedAt:new Date().toISOString(),parameters:{visitorsPerDay:4,turnsPerVisitor:10,days:7,concurrency:1,totalRounds:280,sampleIntervalMs:100},days:[],commands:[],throttles:[]};let sampler;
async function pacedRequest(route,body) {
  const start=Date.now(),maxWait=Math.max(Number(privateEnv.BFF_RATE_LIMIT_USER_WINDOW_MS),Number(privateEnv.BFF_RATE_LIMIT_IP_WINDOW_MS))+5000;
  if(!Number.isFinite(maxWait)||maxWait<=5000)throw Error('rate_window_unavailable');
  while(true) {
    const result=await request(route,body);
    if(result.status!==429||result.body?.error!=='Rate limit exceeded')return result;
    const seconds=result.body.retryAfter;
    r.throttles.push({route,at:result.finishedAt,status:429,retryAfterSeconds:seconds});
    if(!Number.isFinite(seconds)||seconds<=0||Date.now()-start+seconds*1000>maxWait)throw Object.assign(Error('rate_retry_exhausted'),{result});
    // 只有 BFF 明確在轉送前拒絕的限流回應可重送；遵循 retryAfter，不改限流設定。
    await new Promise(resolve=>setTimeout(resolve,seconds*1000));
  }
}
async function finishDay(point) {
  point.statesBefore=[];for(const t of point.threads)point.statesBefore.push(await pacedRequest(`/api/langgraph/threads/${t.threadId}/state`));
  const restartAt=Date.now();point.stop=must(docker([...configuration(),'stop','--timeout','15','runtime']));const loadAt=Date.now();point.start=must(docker([...configuration(),'up','--detach','--wait','--wait-timeout','90','runtime']));point.readyAfter=await waitReady();
  point.restartToReadyMs=Date.now()-restartAt;point.startToReadyMs=Date.now()-loadAt;
  point.statesAfter=[];for(const t of point.threads)point.statesAfter.push(await pacedRequest(`/api/langgraph/threads/${t.threadId}/state`));
  point.stateRetained=point.statesBefore.every((before,i)=>before.status===200&&point.statesAfter[i].status===200&&digest(safe(before.body.values))===digest(safe(point.statesAfter[i].body.values)));
  point.writeGap=longestWriteGap(point.samples);point.peakRssBytes=Math.max(...point.samples.map(s=>s.rssBytes));point.peakDirectoryBytes=Math.max(...point.samples.map(s=>s.directoryBytes));
  if(!point.stateRetained)throw Error('resource_restart_state_mismatch');
  record('v5-resources',{...safe(r),status:'in_progress'});console.log(JSON.stringify({day:point.day,rounds:point.runs.length,peakRssBytes:point.peakRssBytes,peakDirectoryBytes:point.peakDirectoryBytes,maxUnwrittenMs:point.writeGap.maximumMs,startToReadyMs:point.startToReadyMs,stateRetained:point.stateRetained}));
}
try {
  guard();if(JSON.parse(fs.readFileSync(`${runtime}/artifacts/v4-browser-apply-004.json`)).status!=='pass')throw Error('v4_not_passed');
  let firstDay=1;
  if(resumeSampler) {
    const old=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v5-resources-apply-004.json`)),point=old.days.at(-1);
    if(old.status!=='error'||old.error!=='sampler_not_clean:null'||old.project!==project||point.runs.length!==40||!point.samples?.length||Date.parse(point.samples.at(-1).at)<Date.parse(point.trafficEndedAt)||old.days.slice(0,-1).some(d=>!d.stateRetained||d.runs.length!==40))throw Error('unsafe_sampler_continuation');
    record('v5-sampler-attempt',{...old,diagnosis:'採樣器關閉等待 3 秒過短；已保留最後一天全部 40 輪及覆蓋 trafficEndedAt 的實際採樣，不重送已完成輪次。'});
    r={...old};for(const key of ['error','failed','unfinishedRounds'])delete r[key];
    r.resumeInfo={at:new Date().toISOString(),completedRounds:r.days.reduce((n,d)=>n+d.runs.length,0),method:'補最後完整採樣日的重啟驗證，再接續後續日；採樣器改為等待實際退出、上限 30 秒'};
    r.readyAfterContinuation=await waitReady();await finishDay(point);firstDay=point.day+1;
  } else {
  if(retryRate) {
    const old=JSON.parse(fs.readFileSync(`${runtime}/artifacts/v5-resources-apply-004.json`));
    if(old.status!=='error'||old.failed?.status!==429||old.failed?.body?.error!=='Rate limit exceeded')throw Error('unsafe_resource_retry');
    record('v5-initial-attempt',{...old,diagnosis:'第 142 輪在 BFF 轉送前被限流，未完成整週；改以同設定的新隔離環境重跑並遵循 retryAfter。'});
    r.commands.push(must(docker([...compose('chat-gun-runtime-spike-v5-004'),'--file','deploy/self-hosted-runtime/resource-004.yaml','down'])));
  }
  const privateFile='deploy/self-hosted-runtime/.env.spike.local';
  if(!/^SPIKE_FAKE_API_KEY=/m.test(fs.readFileSync(privateFile,'utf8')))fs.appendFileSync(privateFile,`\nSPIKE_FAKE_API_KEY=spike-fixture-${randomUUID()}\n`);
  r.commands.push(must(docker([...configuration(),'config','--quiet'])));
  r.commands.push(must(docker([...configuration(),'up','--detach','--wait','--wait-timeout','90','ledger','knowledge-postgres','fake-model'])));
  r.commands.push(must(docker([...configuration(),'run','--rm','--no-deps','runtime','npm','run','migrations:up'])));
  r.commands.push(must(docker([...configuration(),'up','--detach','--wait','--wait-timeout','90','runtime','bff'])));r.ready=await waitReady();
  record('v5-resources',{...r,status:'in_progress'});
  }
  for(let day=firstDay;day<=7;day++) {
    const point={day,startedAt:new Date().toISOString(),threads:[],runs:[]};r.days.push(point);
    sampler=await startSampler(project,day);point.samples=sampler.rows;
    for(let visitor=1;visitor<=4;visitor++) {
      const thread=await pacedRequest('/api/langgraph/threads',{metadata:{spike:'apply-004',day,visitor}}),id=thread.body.thread_id;if(thread.status!==200||!id)throw Object.assign(Error('resource_thread_failed'),{result:thread});point.threads.push({visitor,threadId:id});
      for(let turn=1;turn<=10;turn++) {
        const run=await pacedRequest(`/api/langgraph/threads/${id}/runs/wait`,{assistant_id:'chatbot',input:{messages:[{role:'user',content:`本機資源測量：第 ${day} 天、訪客 ${visitor}、第 ${turn} 輪。請直接回覆測試訊息。`}]},on_disconnect:'cancel'});
        const messages=run.body?.messages,answer=Array.isArray(messages)?messages.at(-1):null;
        if(run.status!==200||run.body?.__error__||answer?.content!=='V5 本機假模型資源測試回覆；此輸出不作模型語意驗收。')throw Object.assign(Error('resource_run_failed'),{result:run});
        point.runs.push({visitor,turn,threadId:id,startedAt:run.startedAt,finishedAt:run.finishedAt,status:run.status,bodySha256:digest(safe(run.body)),messageCount:messages.length});
      }
    }
    point.trafficEndedAt=new Date().toISOString();
    // 記錄持續活動之後實際落盤；不以 API polling 干擾 debounce。
    await new Promise(resolve=>setTimeout(resolve,3500));await sampler.stop();point.samples=sampler.rows;sampler=undefined;
    await finishDay(point);
  }
  const health=must(docker(['exec',`${project}-fake-model-1`,'node','--input-type=module','-e',"console.log(JSON.stringify(await (await fetch('http://127.0.0.1:8080/health')).json()))"]));r.fakeEndpoint=JSON.parse(health.stdout);
  r.peakRssBytes=Math.max(...r.days.map(d=>d.peakRssBytes));r.peakDirectoryBytes=Math.max(...r.days.map(d=>d.peakDirectoryBytes));r.longestUnwritten=longestWriteGap(r.days.flatMap(d=>d.samples));
  r.checks={rounds:r.days.reduce((n,d)=>n+d.runs.length,0)===280,fakeCalls:r.fakeEndpoint.calls===280,memory:r.peakRssBytes<=1024**3,directory:r.peakDirectoryBytes<=500*1024**2,restartRetention:r.days.every(d=>d.stateRetained),validSamples:r.days.every(d=>d.samples.length>0&&d.samples.every(s=>/^node(?:-MainThread)?$/.test(s.processName)&&s.rssBytes>0))};
  r.status=Object.values(r.checks).every(Boolean)?'pass':'fail';r.limitations='加速依序、以 thread 代表四位邏輯訪客，每天四個新 thread、每個十輪；不代表真實一週時間分布、瀏覽器 session 或模型語意。RSS 與檔案以 100ms 採樣，停止／載入的短暫記憶體峰值不包含在工作負載採樣中。';
  record('v5-resources',safe(r));if(r.status==='pass')markTask('4.1');else process.exitCode=1;
  console.log(JSON.stringify({status:r.status,checks:r.checks,peakRssBytes:r.peakRssBytes,peakDirectoryBytes:r.peakDirectoryBytes,longestUnwritten:r.longestUnwritten,fakeCalls:r.fakeEndpoint.calls}));
}catch(error){record('v5-resources',{...safe(r),status:'error',error:error.message,failed:safe(error.result||null),unfinishedRounds:280-r.days.reduce((n,d)=>n+d.runs.length,0)});console.log(JSON.stringify({status:'error',error:error.message,failed:safe(error.result||null)}));process.exitCode=1;}
finally{if(sampler)await sampler.stop();}
