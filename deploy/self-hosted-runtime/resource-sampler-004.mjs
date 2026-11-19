import {spawn} from 'node:child_process';
import {guard,redact} from './validation-004.mjs';
export async function startSampler(project,day) {
  guard();const rows=[];
  const code=`import fs from 'node:fs';const sample=()=>{const status=fs.readFileSync('/proc/1/status','utf8'),rss=Number(status.match(/^VmRSS:\\s+(\\d+)/m)?.[1])*1024;const files=fs.readdirSync('.langgraph_api').filter(n=>fs.statSync('.langgraph_api/'+n).isFile()).map(name=>{const s=fs.statSync('.langgraph_api/'+name);return {name,bytes:s.size,mtime:s.mtime.toISOString()}});console.log(JSON.stringify({at:new Date().toISOString(),processName:fs.readFileSync('/proc/1/comm','utf8').trim(),rssBytes:rss,directoryBytes:files.reduce((n,f)=>n+f.bytes,0),files}));};sample();const timer=setInterval(sample,100);process.stdin.resume();process.stdin.on('end',()=>{clearInterval(timer);sample();process.exit(0)});`;
  const child=spawn('docker',['exec','--interactive',`${project}-runtime-1`,'node','--input-type=module','-e',code],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending='',stderr='';child.stderr.on('data',b=>{stderr+=redact(b.toString());});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('sampler_start_timeout')),10000);
    child.stdout.on('data',b=>{pending+=b.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;rows.push({...JSON.parse(line),day});clearTimeout(timer);resolve();}});
    child.on('exit',code=>{clearTimeout(timer);if(!rows.length)reject(Error(`sampler_exit:${code}:${stderr}`));});
  });
  return {rows,stop:async()=>{guard();child.stdin.end();await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>reject(Error('sampler_shutdown_timeout')),30000);child.once('exit',()=>{clearTimeout(timer);resolve();});});if(child.exitCode!==0)throw Error(`sampler_not_clean:${child.exitCode}`);}};
}
export function longestWriteGap(rows) {
  const files=new Map();let maximumMs=0,largest=null;
  for(const row of rows)for(const file of row.files.filter(f=>/checkpointer|ops/.test(f.name))) {
    const key=`${row.day}:${file.name}`,at=Date.parse(row.at),mtime=Date.parse(file.mtime),last=files.get(key);
    if(!Number.isFinite(at)||!Number.isFinite(mtime))throw Error('invalid_sample_time');
    if(last&&mtime!==last.mtime){const gap=mtime-last.mtime;if(gap>maximumMs){maximumMs=gap;largest={day:row.day,file:file.name,from:new Date(last.mtime).toISOString(),to:file.mtime,kind:'observed_write_to_write'};}}
    const open=at-mtime;if(open>maximumMs){maximumMs=open;largest={day:row.day,file:file.name,from:file.mtime,to:row.at,kind:'observed_no_write_interval'};}
    files.set(key,{mtime});
  }
  return {maximumMs,largest,samplingIntervalMs:100,note:'限量測中的 checkpoint／ops 檔；初始閒置、執行與結尾落盤等待均計入。最長間隔為觀察值，不是資料遺失時間硬上限。'};
}
