import {spawn} from 'node:child_process';
import {guard,originalProject as project,redact} from './validation-004.mjs';
export async function monitorLeases() {
  guard();const rows=[];
  // 僅輸出本 Change lease 鍵的指令；其他 Redis 指令留在程序記憶體，不保存。
  const code=`import Redis from 'ioredis';const client=new Redis(process.env.USAGE_LEDGER_REDIS_URI);const monitor=await client.monitor();monitor.on('monitor',(time,args)=>{if(args[1]==='spike-mit-langgraph-server:run-001:admission:leases'&&['ZADD','ZREM','ZREMRANGEBYSCORE','PEXPIRE'].includes(args[0].toUpperCase()))console.log(JSON.stringify({time,command:args[0].toUpperCase(),args:args.slice(1)}));});console.log(JSON.stringify({ready:true}));process.stdin.resume();process.stdin.on('end',()=>{monitor.disconnect();process.exit(0)});`;
  const child=spawn('docker',['exec','--interactive',`${project}-bff-1`,'node','--input-type=module','-e',code],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending='',stderr='';child.stderr.on('data',b=>{stderr+=redact(b.toString());});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('lease_monitor_timeout')),10000);
    child.stdout.on('data',b=>{pending+=b.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;const row=JSON.parse(line);if(row.ready){clearTimeout(timeout);resolve();}else rows.push(row);}});
    child.on('exit',code=>{clearTimeout(timeout);if(code!==0)reject(Error(`lease_monitor_exit:${code}:${stderr}`));});
  });
  return {rows,stop:async()=>{guard();child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000);});}};
}
