import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {guard,record,write,root,runtime,changeId,redact,digest,markTask} from "./validation-003.mjs";

if(!process.argv.includes("--execute"))throw Error("explicit_execute_required");
guard();
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
const evidence=name=>read(`${runtime}/artifacts/${name}-apply-003.json`);
if(evidence("v1-comparison").status!=="pass"||evidence("v2-verdict").status!=="fail")throw Error("wrong_closeout_route");
const initial=evidence("start");
for(const [file,sha] of Object.entries(initial.inputHashes)) {
  if(file===`openspec/changes/${changeId}/tasks.md`)continue;
  if(digest(fs.readFileSync(path.join(root,file),"utf8"))!==sha)throw Error(`protected_input_changed:${file}`);
}
const requireBackend=createRequire(path.join(root,"backend/package.json"));
const Ajv=requireBackend("ajv/dist/2020.js").default;
const ajv=new Ajv({strict:false,allErrors:true});requireBackend("ajv-formats")(ajv);
const validators=Object.fromEntries([["result","agent-result-contract/agent-result.schema.json"],["state","current-state-contract/current-state.schema.json"],["handoff","handoff-contract/handoff.schema.json"]].map(([name,file])=>[name,ajv.compile(read(`openspec/specs/${file}`))]));
function validate(name,value){if(!validators[name](value))throw Error(JSON.stringify(validators[name].errors));}
function run(program,args,accepted=[0]) {
  guard();const startedAt=new Date().toISOString();
  const output=spawnSync(program,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:180000,maxBuffer:32*1024*1024});
  const result={command:[program,...args],startedAt,finishedAt:new Date().toISOString(),exitCode:output.status,stdout:redact(output.stdout||""),stderr:redact(output.stderr||""),error:output.error?.code||null};
  if(!accepted.includes(result.exitCode)){record("finalization-error",{status:"error",result});throw Error("final_command_failed");}
  return result;
}
const makeRef=(artifactId,relativePath,kind="evidence")=>({artifactId,changeId,runId:"run-001",kind,relativePath});
function checkRefs(refs) {
  for(const ref of refs)if(ref.changeId!==changeId||(ref.runId&&ref.runId!=="run-001")||path.isAbsolute(ref.relativePath)||ref.relativePath.split(/[\\/]/).includes("..")||!/^(openspec\/changes\/|\.agent-runtime\/)/.test(ref.relativePath)||!fs.existsSync(path.join(root,ref.relativePath)))throw Error("reference_gate_failed");
}
const reportPath=`openspec/changes/${changeId}/findings.md`;
const report=fs.readFileSync(path.join(root,reportPath),"utf8");
if(redact(report)!==report||/帳戶方案|授權結論/.test(report))throw Error("report_content_failed");
for(const [name,count]of [["durable-hitl-conversation-recovery",7],["langgraph-runtime-boundary",7],["multi-instance-operation",7],["demo-deployment-profile",6]]) {
  const part=report.split(`### ${name}\n`)[1]?.split(/\n### |\n## /)[0];
  if(!part||part.split("\n").filter(line=>line.startsWith("| ")).length!==count+2)throw Error("report_matrix_failed");
}
markTask("5.1");
const commands=[];
const listed=run("git",["ls-files","--cached","--others","--exclude-standard","--","deploy/self-hosted-runtime"]);
const deployFiles=listed.stdout.trim().split(/\r?\n/).filter(Boolean);
commands.push(run("python",["-B","-X","utf8","-m","unittest","discover","-s","deploy/self-hosted-runtime","-p","test_*.py"]));
commands.push(run(process.execPath,["--test",...deployFiles.filter(file=>file.endsWith(".test.mjs"))]));
for(const file of deployFiles.filter(file=>file.endsWith(".mjs")))commands.push(run(process.execPath,["--check",file]));
commands.push(run(process.execPath,["deploy/self-hosted-runtime/scan-settings-003.mjs"]));
const strict=()=>run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-Command",`openspec validate ${changeId} --strict`]);
commands.push(strict());
const protectedDiff=run("git",["diff","--exit-code","--","frontend","bff","backend/src","Dockerfile","docker-compose.yml"]);
const trackedNames=run("git",["diff","--name-only"]);
if(trackedNames.stdout.trim().split(/\r?\n/).filter(Boolean).some(file=>!file.startsWith("deploy/self-hosted-runtime/")&&!file.startsWith(`openspec/changes/${changeId}/`)))throw Error("unrelated_tracked_change");
const stat=run("git",["diff","--stat"]),diff=run("git",["diff"]),check=run("git",["diff","--check"]);
const status=run("git",["status","--short","--untracked-files=all"]);
const ignore=run("git",["check-ignore","deploy/self-hosted-runtime/.env.spike.local"]);
markTask("5.2");commands.push(strict());
const ownedFiles=[...deployFiles,reportPath,`openspec/changes/${changeId}/tasks.md`];
const hashes=Object.fromEntries(ownedFiles.map(file=>[file,digest(fs.readFileSync(path.join(root,file),"utf8"))]));
const oldHashes=read(`${runtime}/artifacts/final-checks-apply-002.json`).sha256;
const changedThisAttempt=ownedFiles.filter(file=>hashes[file]!==oldHashes[file]);
const untracked=new Set(run("git",["ls-files","--others","--exclude-standard","--","deploy/self-hosted-runtime",reportPath,`openspec/changes/${changeId}/tasks.md`]).stdout.trim().split(/\r?\n/));
const newDiffs=[],newStats=[],newChecks=[];
for(const file of ownedFiles.filter(file=>untracked.has(file))) {
  newDiffs.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--","/dev/null",file],[0,1]));
  newStats.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--stat","--","/dev/null",file],[0,1]));
  newChecks.push(run("git",["-c","core.autocrlf=false","diff","--no-index","--check","--","/dev/null",file],[0,1]));
}
if(newChecks.some(item=>item.stdout.trim()||item.stderr.trim()))throw Error("new_file_whitespace_failed");
const notExecuted=["V2b：串流進行中 SIGKILL／BFF 上游錯誤及 lease TTL","V2c：resume side-effect 執行前 SIGKILL","V2c：resume side-effect 執行後 SIGKILL","V3：串流段時間、斷線 terminal 與 lease 確認後釋放一次","V4：瀏覽器 Gun Chat、深度研究開關、Gun Shop 審批及降級畫面","V5：280 輪流量、記憶體、目錄成長、重啟載入時間；沒有使用假模型端點","產品套件完整 lint／test／build（本輪產品未改；沿用既有映像 build）"];
const reason="V2(a) 遺失資料年齡下界 4733ms／實際退出時 4824ms，與 D-3 約三秒遺失範圍前提不符；native debounce 重設不提供此年齡硬上限，依 onFailure 交 CCR 仲裁。三項硬性不變量在此案例未失敗。";
const verification={executed:["前置與最後 OpenSpec strict","沿用 apply-002 自建 V1，補同一已消費 interrupt 的 audit 查核","相同環境 CLI 真實退款 interrupt／SIGTERM／首次 resume／相同第二次 resume","兩邊 Config.Env 指紋、HTTP／run／rejected audit、一次 committed effect 與成功 dispatch 對照","V2(a) 真實模型 interrupt 後 815ms 送 SIGKILL，exit 137，重啟讀取檔案、state、history、run、帳本","唯讀查核實際 API 1.4.5 persistence／checkpoint 來源","SIGKILL 後舊 V0 thread 可讀性檢查","13 個 Python 掃描測試、11 個 Node 判定測試及全部驗證腳本語法檢查","公開設定／工具與本輪 evidence 的秘密掃描、範圍及新增檔案 diff 檢查","兩套隔離容器清理，保留 volumes／映像"],passed:["task 2.1：兩邊同環境，history／state 保留，首次 resume 成功，第二次皆 200 success/no-op、rejected audit 皆 0、side-effect／成功 dispatch 各 1","V2(a) 局部：無重複成功 dispatch、無同一 run terminal 倒退、舊 state 可讀；不將 404 冒充 deserialize 失敗","13 個 Python 與 11 個 Node 測試及腳本語法檢查","task 5.1／5.2：報告、完整 D-4、strict、secret 與範圍檢查"],failed:["task 2.2／V2(a)：七個 checkpoint 與新 thread／run 遺失，最老資料已存在 4824ms；D-3 的遺失窗口須 CCR 仲裁"],notExecuted};
const outputFiles=[];
for(const [name,file,content]of [["changed-files","changed-files-apply-003.txt",ownedFiles.join("\n")+"\n"],["git-diff","git-diff-apply-003.patch",diff.stdout+newDiffs.map(item=>item.stdout).join("")],["git-diff-stat","git-diff-stat-apply-003.txt",stat.stdout+newStats.map(item=>item.stdout).join("")],["git-diff-check","git-diff-check-apply-003.txt",check.stdout+newChecks.map(item=>item.stdout).join("")],["validation-summary","validation-summary-apply-003.json",{verification,notExecutedReason:reason}]]) {
  const relativePath=`${runtime}/evidence/${file}`;write(relativePath,content);outputFiles.push(makeRef(`${name}-apply-003`,relativePath));
}
const recovery=evidence("scanner-recovery");const {schemaVersion,artifactId,changeId:unusedChange,runId,kind,recordedAt,...recoveryBody}=recovery;
record("scanner-recovery",{...recoveryBody,status:"corrected",verification:"node --check、13 個 Python 測試與實際逐檔掃描已通過；未放寬規則。"});
record("final-checks",{status:"pass",commands,protectedDiff,trackedNames,statusOutput:status,diffStat:stat,diffCheck:check,ignoreCheck:ignore,ownedFiles,changedThisAttempt,sha256:hashes,newFileDiffChecks:newChecks,notExecuted,notExecutedReason:reason,reportPrivateDecisionSearch:{patterns:["帳戶方案","授權結論"],matches:0},cleanup:evidence("cleanup").status,scopeNote:"tracked diff 為空；因尚未追蹤，另保存 owned files 的 no-index diff 與 SHA-256。其他既有未追蹤工作未列為本次修改。"});
const {state,handoff}=guard();
if(handoff.onFailure.nextOwner!=="CCR"||handoff.onFailure.nextStage!=="plan-change")throw Error("handoff_failure_route_changed");
const resultRef=makeRef("implementation-result-apply-003",`${runtime}/artifacts/implementation-result-apply-003.json`,"implementation_result");
const findingsRef=makeRef("findings-apply-003",reportPath);
const taskRef=makeRef("tasks-apply-003",`openspec/changes/${changeId}/tasks.md`,"tasks");
const failureRef=makeRef("handoff-plan-change-from-apply-003",`${runtime}/artifacts/handoff-plan-change-from-apply-003.json`,"handoff");
const schemaRef=makeRef("schema-validation-apply-003",`${runtime}/artifacts/schema-validation-apply-003.json`);
const evidenceRefs=Object.values(state.latestArtifactRefs).filter(ref=>ref.kind==="evidence"&&ref.artifactId.endsWith("-apply-003"));
const result={schemaVersion:"1.0.0",artifactId:resultRef.artifactId,changeId,runId:"run-001",producer:"Codex",stage:"apply-change",kind:"implementation_result",status:"partial",createdAt:new Date().toISOString(),rolePolicyVersion:"2",summary:"補完新版 V1／task 2.1；V2(a) 三項硬性不變量未失敗，但七個 checkpoint 遺失、最老資料年齡 4824ms，需 CCR 仲裁 D-3 的約三秒遺失範圍。其餘 V2 與 V3～V5 未執行，依 onFailure 交回。",inputRefs:[...handoff.requiredInputRefs,state.latestArtifactRefs.handoff],outputRefs:[findingsRef,taskRef,...evidenceRefs,...outputFiles,schemaRef],verification,risks:[{severity:"High",description:"三秒 debounce 可反覆重設，不能保證只遺失最近三秒資料；V2(a) 已量測較大範圍。",mitigation:"CCR 明訂容許窗口與範圍；本次不修改套件、儲存層或產品。"},{severity:"High",description:"其他 V2、V3、V4、V5 未驗證，不能宣稱 crash／取消／瀏覽器／資源驗收完成。",mitigation:"保留 tasks 未勾選並在仲裁後依序續作。"},{severity:"Medium",description:"兩邊重放 resume 都 no-op 且無 rejected audit；V1 對照通過不等於符合完整 durable HITL 產品規格。",mitigation:"記錄既有產品缺口，交後續產品 Change。"}],nextHandoff:{handoffId:failureRef.artifactId,stage:"plan-change",to:"CCR",reason},payload:{completedTasksThisAttempt:["2.1","5.1","5.2"],previouslyCompleteTasks:["0.1","0.2","1.1","2.0"],incompleteTasks:["2.2","3.1","3.2","4.1"],changedFiles:changedThisAttempt,v5Executed:false,v5FakeEndpointUsed:false,modelRunsCreated:true,v1AuditLimitation:"002 原容器 console logs 已清理；自建完整 V1 沿用原證據，本輪只重放同一已消費 interrupt 補查 audit，沒有回溯捏造原日誌。",findings:[{id:"F004",severity:"Blocker",file:"deploy/self-hosted-runtime/kill-interrupt-003.mjs",symbol:"API FileSystemPersistence.schedulePersist／with",trigger:"真實 interrupt 後 815ms SIGKILL",issue:"新 thread／run 與七個 checkpoint 遺失，最老資料於退出時 4824ms；三秒 debounce 不是遺失年齡硬上限。",impact:"D-3 的允許窗口前提需仲裁；本次沒有觀察到三項硬性不變量失敗。",suggestedFix:"CCR 仲裁資料年齡上限或整批 debounce 未落盤資料的容許範圍。",requirement:"self-hosted-runtime-feasibility／重啟與異常終止；design D-3，task 2.2",evidence:["v2-interrupt-apply-003","v2-verdict-apply-003","persistence-source-apply-003"]}],acceptance:"部分實作與實測證據；不是 readiness 或最終驗收",noCommitOrPush:true}};
const failure={schemaVersion:"1.0.0",handoffId:failureRef.artifactId,changeId,runId:"run-001",from:"Codex",to:"CCR",stage:"plan-change",reason,requiredInputRefs:[resultRef,findingsRef,taskRef,state.latestArtifactRefs.design,state.latestArtifactRefs.spec_self_hosted_runtime_feasibility,state.latestArtifactRefs["v1-comparison-003"],state.latestArtifactRefs["v2-interrupt-003"],state.latestArtifactRefs["v2-verdict-003"],state.latestArtifactRefs["persistence-source-003"],state.latestArtifactRefs["final-checks-003"]],expectedOutputKind:"coordinator_result",onSuccess:{nextStage:"review-plan",nextOwner:"Qwen",reason:"CCR 仲裁／修訂後依語意影響重新 review-plan。"},onFailure:{nextStage:"plan-change",nextOwner:"CCR",reason:"維持未通過與未驗證狀態，不自行擴充容許窗口。"},onConflict:{strategy:"coordinator_arbitration",nextOwner:"CCR"},requiresHumanApproval:false,status:"PENDING",createdAt:new Date().toISOString(),rolePolicyVersion:"2"};
validate("result",result);validate("handoff",failure);
checkRefs([...evidenceRefs,...outputFiles]);write(resultRef.relativePath,result);write(failureRef.relativePath,failure);
record("schema-validation",{status:"pass",resultId:result.artifactId,handoffId:failure.handoffId,schemas:["agent-result.schema.json","handoff.schema.json","current-state.schema.json"],note:"Result／Handoff 已驗證；下方 CurrentState 以相同 validator 驗證，owner 轉移為最後一筆檔案寫入。"});
const next=guard().state;
next.latestArtifactRefs.implementation_result=resultRef;next.latestArtifactRefs.findings=findingsRef;next.latestArtifactRefs.tasks=taskRef;next.latestArtifactRefs.handoff=failureRef;
for(const ref of outputFiles)next.latestArtifactRefs[ref.artifactId]=ref;
next.currentPhase="PLAN_DRAFT";next.currentOwner="CCR";
next.latestHandoff={handoffId:failure.handoffId,stage:"plan-change",from:"Codex",to:"CCR",status:"PENDING"};
next.blockers=[{severity:"Blocker",description:"F004：V2(a) 遺失範圍最老 4824ms；三秒 debounce 不提供三秒資料年齡上限，D-3 需仲裁。",source:"implementation-result-apply-003#F004",status:"unresolved"}];
next.nextActions=["CCR 仲裁 D-3 的寫檔窗口究竟是資料年齡上限或整批尚未 debounce 的資料，明訂可接受範圍。","新版 V1 已完成；保持 task 2.2、3.1、3.2、4.1 未完成，核准後續作。","既有 replayed resume no-op／audit 缺口維持後續產品 Change。"];
next.gateStatus.implementationVerified=false;next.gateStatus.readinessConfirmed=false;next.updatedAt=new Date().toISOString();
validate("state",next);checkRefs(Object.values(next.latestArtifactRefs));checkRefs(result.outputRefs);checkRefs(failure.requiredInputRefs);
handoff.status="FAILED";write(`${runtime}/artifacts/handoff-apply-change-003.json`,handoff);
// 最後一筆檔案寫入：移交 owner，之後只回傳 stdout。
fs.writeFileSync(path.join(root,runtime,"current-state.json"),JSON.stringify(next,null,2)+"\n");
console.log(JSON.stringify({status:result.status,schemaValidation:"pass",phase:next.currentPhase,owner:next.currentOwner,completed:result.payload.completedTasksThisAttempt,incomplete:result.payload.incompleteTasks}));
