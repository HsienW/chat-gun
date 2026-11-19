// 本輪失敗交接的可重現封裝；必須由目前 Handoff 的 Primary Implementer 執行。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { guard, record, root, runtime, changeId, redact, digest } from "./validation.mjs";

if (!process.argv.includes("--execute")) throw Error("explicit_execute_required");
guard();
const read = file => JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
const evidence = name => read(`${runtime}/artifacts/${name}-apply-002.json`);
if (evidence("v1-verdict").status !== "fail") throw Error("failure_route_not_applicable");
const requireBackend = createRequire(path.join(root,"backend/package.json"));
const Ajv = requireBackend("ajv/dist/2020.js").default;
const ajv = new Ajv({strict:false,allErrors:true});
requireBackend("ajv-formats")(ajv);
const validators = Object.fromEntries([
  ["result","agent-result-contract/agent-result.schema.json"],
  ["handoff","handoff-contract/handoff.schema.json"],
  ["state","current-state-contract/current-state.schema.json"],
].map(([name,file])=>[name,ajv.compile(read(`openspec/specs/${file}`))]));
function validate(name,value) {
  if (!validators[name](value)) throw Error(`schema_${name}:${JSON.stringify(validators[name].errors)}`);
}
function run(program,args,accepted=[0]) {
  guard();
  const startedAt=new Date().toISOString();
  const output=spawnSync(program,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:180000,maxBuffer:32*1024*1024});
  const result={command:[program,...args],startedAt,finishedAt:new Date().toISOString(),exitCode:output.status,stdout:redact(output.stdout||""),stderr:redact(output.stderr||""),error:output.error?.code||null};
  if (!accepted.includes(result.exitCode)) throw Object.assign(Error("final_command_failed"),{result});
  return result;
}
function writeRuntime(file,value) {
  guard();
  const target=path.resolve(root,file);
  if (!target.startsWith(path.join(root,runtime)+path.sep)) throw Error("runtime_write_out_of_scope");
  const content=typeof value==="string"?value:JSON.stringify(value,null,2)+"\n";
  if (redact(content)!==content) throw Error("private_value_in_output");
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
}
function ref(artifactId,relativePath,kind="evidence") { return {artifactId,changeId,runId:"run-001",kind,relativePath}; }
function markTask(id) {
  guard();
  const file=`openspec/changes/${changeId}/tasks.md`;
  const text=fs.readFileSync(path.join(root,file),"utf8");
  fs.writeFileSync(path.join(root,file),text.replace(`- [ ] ${id} `,`- [x] ${id} `));
}
function checkRefs(refs) {
  for(const item of refs) {
    if(item.changeId!==changeId || (item.runId && item.runId!=="run-001") || path.isAbsolute(item.relativePath)
      || item.relativePath.split(/[\\/]/).includes("..") || !/^(openspec\/changes\/|\.agent-runtime\/)/.test(item.relativePath)
      || !fs.existsSync(path.join(root,item.relativePath))) throw Error("invalid_output_reference");
  }
}

const reportFile=`openspec/changes/${changeId}/findings.md`;
const report=fs.readFileSync(path.join(root,reportFile),"utf8");
if(redact(report)!==report || /帳戶方案|授權結論/.test(report)) throw Error("report_content_gate_failed");
for(const [section,count] of [["durable-hitl-conversation-recovery",7],["langgraph-runtime-boundary",7],["multi-instance-operation",7],["demo-deployment-profile",6]]) {
  const part=report.split(`### ${section}\n`)[1]?.split(/\n### |\n## /)[0];
  if(!part || part.split("\n").filter(line=>line.startsWith("| ")).length!==count+2) throw Error(`report_matrix_incomplete:${section}`);
}
markTask("5.1");
const commands=[];
commands.push(run("python",["-B","-X","utf8","-m","unittest","discover","-s","deploy/self-hosted-runtime","-p","test_*.py"]));
commands.push(run(process.execPath,["--test","deploy/self-hosted-runtime/approval-verdict.test.mjs"]));
const listed=run("git",["ls-files","--cached","--others","--exclude-standard","--","deploy/self-hosted-runtime"]);
const deploymentFiles=listed.stdout.trim().split(/\r?\n/).filter(Boolean);
for(const file of deploymentFiles.filter(p=>p.endsWith(".mjs"))) commands.push(run(process.execPath,["--check",file]));
commands.push(run(process.execPath,["deploy/self-hosted-runtime/scan-settings.mjs"]));
const strict=()=>run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-Command",`openspec validate ${changeId} --strict`]);
commands.push(strict());
const protectedDiff=run("git",["diff","--exit-code","--","frontend","bff","backend/src","Dockerfile","docker-compose.yml"]);
const trackedFiles=run("git",["diff","--name-only"]);
if(trackedFiles.stdout.trim().split(/\r?\n/).filter(Boolean).some(p=>!p.startsWith("deploy/self-hosted-runtime/")&&!p.startsWith(`openspec/changes/${changeId}/`))) throw Error("unrelated_tracked_diff");
const ignored=run("git",["check-ignore","deploy/self-hosted-runtime/.env.spike.local"]);
const stat=run("git",["diff","--stat"]);
const diffCheck=run("git",["diff","--check"]);
markTask("5.2");
commands.push(strict());
const ownedFiles=[...deploymentFiles,reportFile,`openspec/changes/${changeId}/tasks.md`];
const hashes=Object.fromEntries(ownedFiles.map(file=>[file,digest(fs.readFileSync(path.join(root,file),"utf8"))]));
const previous=read(`${runtime}/artifacts/evidence-apply-change-001.json`).finalChecks.sha256;
const changedThisAttempt=ownedFiles.filter(file=>hashes[file]!==previous[file]);
for(const file of ["Dockerfile","Dockerfile.dockerignore","runtime-entrypoint.sh","start-runtime.mjs","scan_image.py","test_scan_image.py"]) {
  const full=`deploy/self-hosted-runtime/${file}`;
  if(previous[full]!==hashes[full]) throw Error(`carried_over_file_changed:${file}`);
}
const diff=run("git",["diff","--","deploy/self-hosted-runtime",`openspec/changes/${changeId}`]);
const status=run("git",["status","--short","--untracked-files=all"]);
const untracked=new Set(run("git",["ls-files","--others","--exclude-standard","--","deploy/self-hosted-runtime",reportFile,`openspec/changes/${changeId}/tasks.md`]).stdout.trim().split(/\r?\n/));
const extraDiffs=[],extraStats=[],extraChecks=[];
for(const file of ownedFiles.filter(file=>untracked.has(file))) {
  extraDiffs.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--","/dev/null",file],[0,1]));
  extraStats.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--stat","--","/dev/null",file],[0,1]));
  extraChecks.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--check","--","/dev/null",file],[0,1]));
}
if(extraChecks.some(item=>item.stdout.trim()||item.stderr.trim())) throw Error("new_file_diff_check_failed");
const notExecuted=[
  "task 2.1：同次 V1 重啟後的 Gun Chat history 未額外比對；mock provider 私有物理計數器未直接讀取",
  "task 2.2／V2：interrupt 後立即、串流中、resume side-effect 前後的 SIGKILL 均未執行",
  "task 3.1／V3：串流段時間、斷線 terminal reason 與 lease 釋放恰好一次未驗證",
  "task 3.2／V4：瀏覽器 Gun Chat、深度研究開關、Gun Shop 審批與降級畫面未執行",
  "task 4.1／V5：280 輪流量、記憶體、檔案成長與重啟載入時間未執行；未使用假模型端點",
  "產品套件完整 lint／test／build 回歸未執行：本輪未修改產品；沿用前輪映像建置中的 frontend／BFF build",
];
const reason="V1 相同 resume 重放未拒絕，與核准 Scenario 不符；範圍禁止產品／套件修補，依 Handoff onFailure 交 CCR，未繼續依賴仲裁的驗證。";
const verification={executed:["前置與最後 OpenSpec strict","同環境缺金鑰 custom／legacy 對照","原 87／13 筆映像命中逐筆重現與判讀","設定與工具秘密掃描","真實 Qwen Gun Chat／V0／退款 routing","V0 SIGTERM 與 state／history／檔案內容","V1 interrupt、SIGTERM、resume、重放與隔離資料庫計數","Docker 重開後既有 run 補查","13 個 Python 與 3 個 Node 測試、驗證腳本語法檢查","tracked／新增檔案 diff、secret 與範圍檢查","本次容器清理，保留 volumes"],passed:["task 1.1：啟動／ready／run、同環境缺金鑰對照、100 筆疑似命中均判讀且無確認 secret","task 2.0：兩個 graph 由 server checkpoint 保存，SIGTERM 後 values／history 保留","V1 已量測部分：首次 resume 成功、一次 committed effect／成功 dispatch attempt","13 個 Python 與 3 個 Node 測試及腳本語法檢查","task 5.1、5.2：技術報告、完整 D-4 表、最後 strict 與範圍檢查"],failed:["task 2.1：第二次相同 resume 仍 HTTP 200，body 與首次相同；補查兩個 run 均 success，沒有明確拒絕"],notExecuted};
const refs=[];
for(const [name,file,content] of [
  ["changed-files","changed-files-apply-002.txt",ownedFiles.join("\n")+"\n"],
  ["git-diff","git-diff-apply-002.patch",diff.stdout+extraDiffs.map(r=>r.stdout).join("")],
  ["git-diff-stat","git-diff-stat-apply-002.txt",stat.stdout+extraStats.map(r=>r.stdout).join("")],
  ["git-diff-check","git-diff-check-apply-002.txt",diffCheck.stdout+extraChecks.map(r=>r.stdout).join("")],
  ["validation-summary","validation-summary-apply-002.json",{verification,notExecutedReason:reason}],
]) {
  const relativePath=`${runtime}/evidence/${file}`;
  writeRuntime(relativePath,content);
  refs.push(ref(`${name}-apply-002`,relativePath));
}
const finalChecks=record("final-checks",{status:"pass",commands,protectedDiff,trackedFiles,statusOutput:status,diffStat:stat,diffCheck,privateFixtureIgnoreCheck:ignored,ownedFiles,changedThisAttempt,sha256:hashes,newFileDiffChecks:extraChecks,notExecuted,notExecutedReason:reason,scopeNote:"tracked diff 為空；新增檔案另以 no-index diff、完整清單及 SHA-256 保存。未接觸其他既有未追蹤工作。",reportPrivateDecisionSearch:{patterns:["帳戶方案","授權結論"],matches:0},cleanup:evidence("cleanup").status});
const {state,handoff}=guard();
const resultRef=ref("implementation-result-apply-002",`${runtime}/artifacts/implementation-result-apply-002.json`,"implementation_result");
const findingsRef=ref("findings-apply-002",reportFile);
const failureRef=ref("handoff-plan-change-from-apply-002",`${runtime}/artifacts/handoff-plan-change-from-apply-002.json`,"handoff");
const evidenceKeys=["validation","comparison","candidate-inspection","positive","settings-scan","task-1-1","v0","v1","v1-initial-attempt","v1-verdict","v1-supplement","v0-file-contents","cleanup","closeout-initial-attempt","final-checks"];
const outputRefs=[findingsRef,...evidenceKeys.map(key=>state.latestArtifactRefs[key]),...refs];
const result={schemaVersion:"1.0.0",artifactId:resultRef.artifactId,changeId,runId:"run-001",producer:"Codex",stage:"apply-change",kind:"implementation_result",status:"partial",createdAt:new Date().toISOString(),rolePolicyVersion:"2",summary:"完成 task 1.1、2.0、5.1、5.2；V1 相同 resume 重放未明確拒絕，2.1 不通過，V2～V5 未執行。依 onFailure 交 CCR。",inputRefs:[...handoff.requiredInputRefs,state.latestArtifactRefs.handoff],outputRefs,verification,risks:[{severity:"High",description:"第二次 resume 仍 success，與核准拒絕要求不符。",mitigation:"CCR 仲裁原生 no-op 語意與拒絕契約，未自行修改產品或套件。"},{severity:"High",description:"V2～V5 未驗證，不能宣稱 crash 恢復、取消、UI 與資源門檻成立。",mitigation:"保持 tasks 未勾選，仲裁後依序續作。"},{severity:"Medium",description:"深度研究的自帶 MemorySaver 被 server 覆蓋；單一程序加檔案不能滿足多實例前提。",mitigation:"報告記錄實測優先順序與部署限制。"}],nextHandoff:{handoffId:failureRef.artifactId,stage:"plan-change",to:"CCR",reason},payload:{completedTasksThisAttempt:["1.1","2.0","5.1","5.2"],previouslyCompleteTasks:["0.1","0.2"],incompleteTasks:["2.1","2.2","3.1","3.2","4.1"],changedFiles:changedThisAttempt,carriedOverFiles:ownedFiles.filter(file=>!changedThisAttempt.includes(file)),modelRunsCreated:true,v5Executed:false,v5FakeEndpointUsed:false,findings:[{id:"F003",severity:"Blocker",file:"deploy/self-hosted-runtime/restart-approval.mjs",symbol:"BFF runs/wait command.resume 鏈路",trigger:"SIGTERM 後核准退款，再送相同 resume",issue:"HTTP 200 原結果與 run success，沒有明確拒絕",impact:"task 2.1 必要條件不符；未觀察到第二次 side-effect",suggestedFix:"CCR 仲裁既有 no-op 與拒絕要求差異，決定後續核准範圍",requirement:"self-hosted-runtime-feasibility／正常重啟後等待中的審批可恢復",evidence:["v1-apply-002","v1-verdict-apply-002","v1-supplement-apply-002"]}],acceptance:"部分實作與實測結果，不是 readiness 或最終驗收",noCommitOrPush:true}};
const failure={schemaVersion:"1.0.0",handoffId:failureRef.artifactId,changeId,runId:"run-001",from:"Codex",to:"CCR",stage:"plan-change",reason,requiredInputRefs:[resultRef,findingsRef,state.latestArtifactRefs.design,state.latestArtifactRefs.tasks,state.latestArtifactRefs.spec_self_hosted_runtime_feasibility,state.latestArtifactRefs["v1-verdict"],state.latestArtifactRefs["v1-supplement"],state.latestArtifactRefs["candidate-inspection"],state.latestArtifactRefs["final-checks"]],expectedOutputKind:"coordinator_result",onSuccess:{nextStage:"review-plan",nextOwner:"Qwen",reason:"CCR 仲裁或修訂後依影響重新 review-plan。"},onFailure:{nextStage:"plan-change",nextOwner:"CCR",reason:"保留失敗與未驗證項目，不推定通過。"},onConflict:{strategy:"coordinator_arbitration",nextOwner:"CCR"},requiresHumanApproval:false,status:"PENDING",createdAt:new Date().toISOString(),rolePolicyVersion:"2"};
validate("result",result);validate("handoff",failure);
checkRefs(outputRefs);
writeRuntime(resultRef.relativePath,result);
writeRuntime(failureRef.relativePath,failure);
const schemaEvidence=record("schema-validation",{status:"pass",schemas:["agent-result.schema.json","handoff.schema.json","current-state.schema.json"],resultId:result.artifactId,handoffId:failure.handoffId,note:"所有 Reference 均在本 Change／run 範圍且存在；CurrentState owner 轉移為最後一筆寫入。"});
const latest=guard().state;
latest.latestArtifactRefs.implementation_result=resultRef;
latest.latestArtifactRefs.findings=findingsRef;
latest.latestArtifactRefs.handoff=failureRef;
for(const item of refs) latest.latestArtifactRefs[item.artifactId]=item;
latest.currentPhase="PLAN_DRAFT";
latest.currentOwner="CCR";
latest.latestHandoff={handoffId:failure.handoffId,stage:failure.stage,from:"Codex",to:"CCR",status:"PENDING"};
latest.blockers=[{severity:"Blocker",description:"F003：相同 resume 重放未明確拒絕，task 2.1 不符合核准 Scenario。",source:"implementation-result-apply-002#F003",status:"unresolved"}];
latest.nextActions=["CCR 仲裁 F003：原生 no-op 與第二次 resume 必須拒絕之差異。","保持 task 2.1 與 V2～V5 未完成；核准後再交 Codex 依序續作。"];
latest.gateStatus.implementationVerified=false;
latest.gateStatus.readinessConfirmed=false;
latest.updatedAt=new Date().toISOString();
validate("state",latest);checkRefs(Object.values(latest.latestArtifactRefs));checkRefs(failure.requiredInputRefs);
// 此後只執行兩筆已驗證的交接寫入。關閉原 Handoff，最後才移交 owner。
handoff.status="FAILED";
writeRuntime(`${runtime}/artifacts/handoff-apply-change-002.json`,handoff);
fs.writeFileSync(path.join(root,runtime,"current-state.json"),JSON.stringify(latest,null,2)+"\n");
console.log(JSON.stringify({result:resultRef.relativePath,status:result.status,schemaValidation:"pass",phase:latest.currentPhase,owner:latest.currentOwner,completed:result.payload.completedTasksThisAttempt,incomplete:result.payload.incompleteTasks}));
