import {execNode,originalProject as project,docker,must,safe,request} from './validation-004.mjs';
export function files(threadId) {
  const script=`import fs from 'node:fs';import crypto from 'node:crypto';const id=process.argv[2];console.log(JSON.stringify(fs.readdirSync('.langgraph_api').filter(p=>fs.statSync('.langgraph_api/'+p).isFile()).map(name=>{const p='.langgraph_api/'+name,b=fs.readFileSync(p);return {path:p,bytes:b.length,mtime:fs.statSync(p).mtime.toISOString(),sha256:crypto.createHash('sha256').update(b).digest('hex'),containsThread:b.includes(Buffer.from(id))}})));`;
  const output=execNode(project,script,[threadId]);
  return {at:output.finishedAt,files:JSON.parse(output.stdout)};
}
export function leases() {
  const key='spike-mit-langgraph-server:run-001:admission:leases';
  const rows=must(docker(['exec',`${project}-ledger-1`,'redis-cli','--json','ZRANGE',key,'0','-1','WITHSCORES']));
  const ttl=must(docker(['exec',`${project}-ledger-1`,'redis-cli','PTTL',key]));
  const rawMembers=JSON.parse(rows.stdout);
  if(!Array.isArray(rawMembers))throw Error('unexpected_redis_reply');
  return {at:rows.finishedAt,members:rawMembers.flat(),rawMembers,ttlMs:Number(ttl.stdout)};
}
export async function snapshot(id) {
  return safe({state:await request(`/api/langgraph/threads/${id}/state`),history:await request(`/api/langgraph/threads/${id}/history`,{limit:100}),runs:await request(`/api/langgraph/threads/${id}/runs?limit=100`)});
}
export function parseEvents(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(block=>{
    const event=block.split(/\r?\n/).find(line=>line.startsWith('event:'))?.slice(6).trim();
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
    let value;try{value=JSON.parse(data);}catch{value=data;}
    return {event,data:safe(value)};
  });
}
