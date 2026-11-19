import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
// 僅沿用無 mutation 的設定／遮蔽函式；002 的 guard／record 不在此輪使用。
import { root, runtime, changeId, privateEnv, redact, digest, compose as baseCompose } from "./validation.mjs";
export { root, runtime, changeId, privateEnv, redact, digest };
export const originalProject = "chat-gun-runtime-spike-004";
export function guard() {
  const state=JSON.parse(fs.readFileSync(path.join(root,runtime,"current-state.json"),"utf8"));
  const handoff=JSON.parse(fs.readFileSync(path.join(root,runtime,"artifacts/handoff-apply-change-004.json"),"utf8"));
  if(state.changeId!==changeId||state.runId!=="run-001"||state.currentOwner!=="Codex"
    ||!["READY_FOR_IMPLEMENTATION","IMPLEMENTING"].includes(state.currentPhase)
    ||state.latestHandoff.handoffId!=="handoff-apply-change-004"||handoff.to!=="Codex"
    ||!["PENDING","IN_PROGRESS"].includes(handoff.status))throw Error("role_gate_failed");
  return {state,handoff};
}
export function write(file,value) {
  guard();
  const target=path.resolve(root,file);
  if(!target.startsWith(path.join(root,runtime)+path.sep))throw Error("artifact_scope_failed");
  const text=typeof value==="string"?value:JSON.stringify(value,null,2)+"\n";
  if(redact(text)!==text)throw Error("private_value_in_artifact");
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);
}
export function record(name,value) {
  const {state}=guard();
  if(!/^[a-z0-9-]+$/.test(name))throw Error("invalid_artifact_name");
  const artifactId=`${name}-apply-004`,relativePath=`${runtime}/artifacts/${artifactId}.json`;
  const artifact={...value,schemaVersion:"1.0.0",artifactId,changeId,runId:"run-001",kind:"evidence",recordedAt:new Date().toISOString()};
  write(relativePath,artifact);
  state.latestArtifactRefs[`${name}-004`]={artifactId,changeId,runId:"run-001",kind:"evidence",relativePath};
  state.updatedAt=new Date().toISOString();write(`${runtime}/current-state.json`,state);
  return artifact;
}
export function claim(strict) {
  const {state,handoff}=guard();
  if(strict.exit_code!==0)throw Error("strict_gate_failed");
  handoff.status="IN_PROGRESS";write(`${runtime}/artifacts/handoff-apply-change-004.json`,handoff);
  state.currentPhase="IMPLEMENTING";state.latestHandoff.status="IN_PROGRESS";
  state.nextActions=["依序執行 V2～V5；硬性不變量失敗即交 CCR。"];
  state.updatedAt=new Date().toISOString();write(`${runtime}/current-state.json`,state);
  record("validation",{strict});
}
export function safe(value) {
  if(Array.isArray(value))return value.map(safe);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/token|secret|password|credential|capability/i.test(key)?"[OMITTED]":safe(item)]));
  return typeof value==="string"?redact(value):value;
}
export function docker(args,options={}) {
  guard();const startedAt=new Date().toISOString();
  const result=spawnSync("docker",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:180000,maxBuffer:16*1024*1024,...options});
  return {command:["docker",...args],startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,stdout:redact(result.stdout||""),stderr:redact(result.stderr||""),error:result.error?.code||null};
}
export function must(result) {if(result.exitCode!==0)throw Object.assign(Error("command_failed"),{result});return result;}
export function compose(project=originalProject,legacy=false) {
  const args=[...baseCompose,"--project-name",project];
  if(legacy)args.push("--file","deploy/self-hosted-runtime/legacy.yaml");
  return args;
}
export const runtimeContainer=project=>`${project}-runtime-1`;
export async function request(route,body,{method=body===undefined?"GET":"POST",timeout=120000}={}) {
  guard();const startedAt=new Date().toISOString(),requestId=randomUUID();
  const response=await fetch(`http://127.0.0.1:8124${route}`,{method,headers:{"content-type":"application/json","x-request-id":requestId,"connection":"close"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  return {route,requestId,startedAt,finishedAt:new Date().toISOString(),status:response.status,body:value};
}
export async function createThread() {
  const result=await request("/api/langgraph/threads",{metadata:{spike:"apply-004"}});
  if(result.status!==200||!result.body?.thread_id)throw Object.assign(Error("thread_create_failed"),{result});return result;
}
export async function waitReady(timeoutMs=30000) {
  const deadline=Date.now()+timeoutMs;const probes=[];
  while(Date.now()<deadline) {
    try { const probe=await request("/api/ready",undefined,{timeout:3000});probes.push(probe);if(probe.status===200)return probes; }
    catch(error) {probes.push({at:new Date().toISOString(),error:error.message,code:error.cause?.code});}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Object.assign(Error("host_ready_timeout"),{probes});
}
export function execNode(project,script,args=[]) {
  return must(docker(["exec","--interactive",runtimeContainer(project),"node","--input-type=module","-",...args],{input:script}));
}
export function environment(project,service="runtime") {
  guard();
  // 未遮蔽值只存在記憶體；命令列與 evidence 僅包含雜湊／變數名稱。
  const result=spawnSync("docker",["inspect","--format","{{json .Config.Env}}",`${project}-${service}-1`],{cwd:root,encoding:"utf8",windowsHide:true});
  if(result.status!==0)throw Error("environment_inspection_failed");
  const entries=JSON.parse(result.stdout).sort();
  return {sha256:digest(entries),names:entries.map(v=>v.split("=",1)[0])};
}
export function database(project) {
  const script=`import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const results={};for(const t of ['business_effects','tool_executions','tool_execution_attempts','order_operation_requests','authorization_confirmations'])results[t]=(await c.query('SELECT * FROM '+t)).rows;results.rejectedAudit=(await c.query("SELECT * FROM audit_events WHERE action='authorization.confirmation.rejected' ORDER BY created_at")).rows;await c.end();console.log(JSON.stringify(results));`;
  return safe(JSON.parse(execNode(project,script).stdout));
}
export function audits(project,since) {
  const output=must(docker(["logs","--timestamps","--since",since,runtimeContainer(project)]));
  const text=output.stdout+"\n"+output.stderr;
  const lines=text.split(/\r?\n/).filter(line=>line.includes("[audit] authorization.confirmation.rejected"));
  return {since,checkedAt:output.finishedAt,source:"ConsoleAuditLogger／完整指定時段 docker logs",rejectedCount:lines.length,lines,logSha256:digest(text),logs:output};
}
export function approvalCommand(state) {
  const pending=state.tasks?.flatMap(task=>task.interrupts||[]).find(i=>i.value?.type==="tool_authorization_confirmation")?.value;
  if(!pending)throw Error("approval_interrupt_not_found");
  return {resume:{type:pending.type,schemaVersion:pending.schemaVersion,approvalId:pending.approvalId,decisionId:pending.decisionId,decision:"approve"}};
}
export function markTask(id) {
  guard();const file=path.join(root,`openspec/changes/${changeId}/tasks.md`);
  fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace(`- [ ] ${id} `,`- [x] ${id} `));
}
