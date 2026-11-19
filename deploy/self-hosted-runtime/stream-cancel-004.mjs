import {randomUUID} from 'node:crypto';
import {guard,record,request,createThread,safe,docker,must,originalProject as project,markTask,runtime} from './validation-004.mjs';
import {leases,parseEvents} from './observations-004.mjs';
import {monitorLeases} from './lease-monitor-004.mjs';
import fs from 'node:fs';
const r={case:'V3',realModel:true,startedAt:new Date().toISOString()};let monitor;
async function stream(graphId,cancel) {
  const result={graphId,cancel,chunks:[],requestId:randomUUID(),startedAt:new Date().toISOString()};
  const thread=await createThread(),id=result.threadId=thread.body.thread_id;
  const controller=new AbortController();
  const response=await fetch(`http://127.0.0.1:8124/api/langgraph/threads/${id}/runs/stream`,{method:'POST',headers:{'content-type':'application/json','x-request-id':result.requestId,'connection':'close'},body:JSON.stringify({assistant_id:graphId,input:{messages:[{role:'user',content:cancel?'請研究資料備份與災難復原，整理三種方法並附來源。':'請用繁體中文分三段解釋資料備份的用途。'}]},stream_mode:['messages-tuple','values','updates','custom'],on_disconnect:'cancel',stream_resumable:false}),signal:controller.signal});
  result.http={status:response.status,location:response.headers.get('content-location'),contentType:response.headers.get('content-type')};
  if(response.status!==200)throw Object.assign(Error('stream_not_accepted'),{result:{...result,body:await response.text()}});
  const runId=result.runId=response.headers.get('content-location')?.split('/').at(-1);
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  while(true){const part=await reader.read();if(part.done)break;const chunk=decoder.decode(part.value,{stream:true});text+=chunk;result.chunks.push({at:new Date().toISOString(),bytes:part.value.length,text:safe(chunk)});
    if(cancel&&parseEvents(text).some(e=>e.event==='values')) {
      result.running=await request(`/api/langgraph/threads/${id}/runs/${runId}`);result.leaseDuring=leases();
      result.disconnectedAt=new Date().toISOString();await reader.cancel();controller.abort();break;
    }
  }
  result.events=parseEvents(text);result.streamEndAt=new Date().toISOString();result.polls=[];
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){const point=await request(`/api/langgraph/threads/${id}/runs/${runId}`);result.polls.push(point);if(['success','error','timeout','interrupted'].includes(point.body?.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
  result.finalState=await request(`/api/langgraph/threads/${id}/state`);
  return safe(result);
}
try {
  guard();if(JSON.parse(fs.readFileSync(`${runtime}/artifacts/v2c-after-apply-004.json`)).status!=='pass')throw Error('v2_not_passed');
  r.normal=await stream('chatbot',false);record('v3-stream-cancel',{...r,status:'normal_complete'});
  monitor=await monitorLeases();r.cancelled=await stream('deep_researcher',true);
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(monitor.rows.some(v=>v.command==='ZREM'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  await monitor.stop();r.leaseCommands=monitor.rows;monitor=undefined;r.finalLeases=leases();
  r.bffLogs=must(docker(['logs','--timestamps','--since',r.startedAt,`${project}-bff-1`]));
  const logLines=(r.bffLogs.stdout+'\n'+r.bffLogs.stderr).split(/\r?\n/);
  r.confirmationLines=logLines.filter(l=>l.includes(r.cancelled.requestId)&&l.includes('run_cancel_confirmed'));
  const adds=r.leaseCommands.filter(v=>v.command==='ZADD'),removed=r.leaseCommands.filter(v=>v.command==='ZREM');
  const addedId=adds[0]?.args[2];r.releaseCount=removed.filter(v=>v.args[1]===addedId).length;
  const confirmationAt=Date.parse(r.confirmationLines[0]?.split(' ',1)[0]);
  r.releaseAfterConfirmation=Number(removed[0]?.time)*1000>=confirmationAt;
  r.checks={normalSuccess:r.normal.polls.at(-1)?.body.status==='success',multipleSegments:r.normal.chunks.length>=2&&Date.parse(r.normal.chunks[1].at)<Date.parse(r.normal.streamEndAt),normalNoError:!r.normal.events.some(e=>e.event==='error'),cancelledWhileRunning:r.cancelled.running.body.status==='running',cancelTerminal:['success','error','timeout','interrupted'].includes(r.cancelled.polls.at(-1)?.body.status),leaseAcquired:r.cancelled.leaseDuring.members.length===2,confirmedBeforeRelease:r.confirmationLines.length===1&&r.releaseAfterConfirmation,releasedExactlyOnce:r.releaseCount===1,leaseEmpty:r.finalLeases.members.length===0};
  r.status=Object.values(r.checks).every(Boolean)?'pass':'fail';record('v3-stream-cancel',safe(r));if(r.status==='pass')markTask('3.1');else process.exitCode=1;
  console.log(JSON.stringify({status:r.status,checks:r.checks,normalSegments:r.normal.chunks.map(c=>({at:c.at,bytes:c.bytes})),disconnectedAt:r.cancelled.disconnectedAt,terminal:r.cancelled.polls.at(-1),confirmationLines:r.confirmationLines,leaseCommands:r.leaseCommands}));
}catch(error){record('v3-stream-cancel',{...safe(r),status:'error',error:error.message,failed:safe(error.result||null)});console.log(JSON.stringify({status:'error',error:error.message,failed:safe(error.result||null)}));process.exitCode=1;}
finally{if(monitor)await monitor.stop();}
