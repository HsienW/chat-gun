import {spawn} from 'node:child_process';
import {guard,execNode,originalProject as project,runtimeContainer,redact} from './validation-004.mjs';
export function counts(db,id) {
  const rows=db.tool_executions.filter(row=>row.thread_id===id),ids=new Set(rows.map(r=>r.tool_execution_id));
  const effectIds=new Set(rows.filter(r=>r.status==='committed').map(r=>r.business_effect_id));
  return {successfulDispatches:db.tool_execution_attempts.filter(r=>ids.has(r.tool_execution_id)&&r.outcome==='succeeded').length,
    committedEffects:db.business_effects.filter(r=>effectIds.has(r.business_effect_id)&&r.commit_state==='committed').length};
}
export function query(sql,args=[]) {
  const script=`import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(${JSON.stringify(sql)},${JSON.stringify(args)});await c.end();console.log(JSON.stringify(r.rows));`;
  return JSON.parse(execNode(project,script).stdout);
}
export async function holdConfirmation(approvalId) {
  guard();
  const worker=spawn('docker',['exec','--interactive',runtimeContainer(project),'node','--input-type=module','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  worker.stdin.end(`import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');await c.query('SELECT approval_id FROM authorization_confirmations WHERE approval_id=$1 FOR UPDATE',[${JSON.stringify(approvalId)}]);console.log(JSON.stringify({pid:c.processID,approvalId:${JSON.stringify(approvalId)}}));await new Promise(()=>{});`);
  let stdout='',stderr='';worker.stderr.on('data',b=>{stderr+=redact(b.toString());});
  const lock=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('confirmation_lock_timeout')),10000);
    worker.stdout.on('data',b=>{stdout+=b.toString();if(stdout.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(stdout.trim()));}});
    worker.on('exit',code=>{clearTimeout(timeout);if(!stdout.includes('\n'))reject(Error(`confirmation_lock_exit:${code}:${stderr}`));});
  });
  return {worker,lock};
}
export function compareTerminals(before,after) {
  const terminal=new Set(['success','error','timeout','interrupted']);
  const active=new Set(['pending','running']);
  return before.map(row=>({runId:row.run_id,before:row.status,after:after.find(v=>v.run_id===row.run_id)?.status||'not_retained'}))
    .map(row=>({...row,regressed:terminal.has(row.before)&&active.has(row.after)}));
}
