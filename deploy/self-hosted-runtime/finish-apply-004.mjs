import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
import {guard,record,write,root,runtime,changeId,redact,digest,markTask} from './validation-004.mjs';
if(!process.argv.includes('--execute'))throw Error('explicit_execute_required');
guard();
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const evidence=name=>read(`${runtime}/artifacts/${name}-apply-004.json`);
for(const name of ['v2-summary','v3-stream-cancel','v4-browser','v5-resources','cleanup'])if(evidence(name).status!=='pass')throw Error(`required_evidence_failed:${name}`);
const initial=evidence('start');
for(const [file,sha] of Object.entries(initial.inputHashes))if(!file.endsWith('/tasks.md')&&digest(fs.readFileSync(file,'utf8'))!==sha)throw Error(`protected_input_changed:${file}`);
function run(program,args,accepted=[0]) {
  guard();const startedAt=new Date().toISOString(),o=spawnSync(program,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:32*1024*1024});
  const r={command:[program,...args],startedAt,finishedAt:new Date().toISOString(),exitCode:o.status,stdout:redact(o.stdout||''),stderr:redact(o.stderr||''),error:o.error?.code||null};
  if(!accepted.includes(r.exitCode)){record('finalization-error',{status:'error',result:r});throw Error('final_command_failed');}return r;
}
const requireBackend=createRequire(path.join(root,'backend/package.json')),Ajv=requireBackend('ajv/dist/2020.js').default;
const ajv=new Ajv({strict:false,allErrors:true});requireBackend('ajv-formats')(ajv);
const validators=Object.fromEntries([['result','agent-result-contract/agent-result.schema.json'],['state','current-state-contract/current-state.schema.json'],['handoff','handoff-contract/handoff.schema.json']].map(([k,file])=>[k,ajv.compile(read(`openspec/specs/${file}`))]));
function validate(k,value){if(!validators[k](value))throw Error(JSON.stringify(validators[k].errors));}
const ref=(artifactId,relativePath,kind='evidence')=>({artifactId,relativePath,kind,changeId,runId:'run-001'});
function checkRefs(refs){for(const r of refs)if(r.changeId!==changeId||(r.runId&&r.runId!=='run-001')||path.isAbsolute(r.relativePath)||r.relativePath.split(/[\\/]/).includes('..')||!/^(openspec\/changes\/|\.agent-runtime\/)/.test(r.relativePath)||!fs.existsSync(r.relativePath))throw Error('reference_gate_failed');}
const reportPath=`openspec/changes/${changeId}/findings.md`,tasksPath=`openspec/changes/${changeId}/tasks.md`,report=fs.readFileSync(reportPath,'utf8');
if(redact(report)!==report||/帳戶方案|授權結論/.test(report))throw Error('report_content_failed');
for(const [name,n]of [['durable-hitl-conversation-recovery',7],['langgraph-runtime-boundary',7],['multi-instance-operation',7],['demo-deployment-profile',6]]){const part=report.split(`### ${name}\n`)[1]?.split(/\n### |\n## /)[0];if(!part||part.split('\n').filter(l=>l.startsWith('| ')).length!==n+2)throw Error('report_matrix_failed');}
markTask('5.1');
const commands=[],listed=run('git',['ls-files','--cached','--others','--exclude-standard','--','deploy/self-hosted-runtime']);
const deployFiles=listed.stdout.trim().split(/\r?\n/).filter(Boolean);
commands.push(run('python',['-B','-X','utf8','-m','unittest','discover','-s','deploy/self-hosted-runtime','-p','test_*.py']));
commands.push(run(process.execPath,['--test',...deployFiles.filter(p=>p.endsWith('.test.mjs'))]));
for(const file of deployFiles.filter(p=>p.endsWith('.mjs')))commands.push(run(process.execPath,['--check',file]));
commands.push(run(process.execPath,['deploy/self-hosted-runtime/scan-settings-004.mjs']));
markTask('5.2');
commands.push(run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-Command',`openspec validate ${changeId} --strict`]));
const diff=run('git',['diff']);if(digest(diff.stdout)!==initial.baseline.trackedDiffSha256)throw Error('tracked_workspace_delta_outside_scope');
const stat=run('git',['diff','--stat']),check=run('git',['diff','--check']),status=run('git',['status','--short','--untracked-files=all']);
const ignore=run('git',['check-ignore','deploy/self-hosted-runtime/.env.spike.local']);
const ownedFiles=[...deployFiles,reportPath,tasksPath],hashes=Object.fromEntries(ownedFiles.map(p=>[p,digest(fs.readFileSync(p,'utf8'))]));
const changedThisAttempt=ownedFiles.filter(p=>p.includes('004.')||[reportPath,tasksPath].includes(p)||hashes[p]!==initial.baseline.filesSha256[p]);
const newDiffs=[],newStats=[],newChecks=[];
const untracked=new Set(run('git',['ls-files','--others','--exclude-standard','--','deploy/self-hosted-runtime',reportPath,tasksPath]).stdout.trim().split(/\r?\n/));
for(const file of ownedFiles.filter(p=>untracked.has(p))){newDiffs.push(run('git',['-c','core.autocrlf=false','diff','--no-index','--','/dev/null',file],[0,1]));newStats.push(run('git',['-c','core.autocrlf=false','diff','--no-index','--stat','--','/dev/null',file],[0,1]));newChecks.push(run('git',['-c','core.autocrlf=false','diff','--no-index','--check','--','/dev/null',file],[0,1]));}
if(newChecks.some(v=>v.stdout.trim()||v.stderr.trim()))throw Error('owned_file_whitespace_failed');
const tasks=fs.readFileSync(tasksPath,'utf8');if((tasks.match(/^- \[x\]/gm)||[]).length!==11||/^- \[ \]/m.test(tasks))throw Error('tasks_incomplete');
const notExecuted=['產品套件完整 lint／test／build：本輪沒有產品程式變更，沿用既有映像 build；本輪執行部署工具測試與指定 live 驗證。','完整 RecoverySanitizer／LastExecutionPointClassifier／CrashTerminalPolicy 的全部產品矩陣；本次只驗證指定 crash 不變量。','多實例 takeover／完整事件 sequence、session revocation／匿名 session 隔離及完整 demo 准入矩陣：逐 Requirement 已標示偏離、不適用或未驗證。','V5 真實模型負載：依 OD-2 使用本機假模型，只驗證資源，不作語意驗收。'];
const v5=evidence('v5-resources');
const verification={executed:['前置與最後 openspec validate --strict','沿用 apply-003 V2(a) 原始證據，依 attempt 6 邊界重判','V2(b) 真實 running 串流 SIGKILL、BFF 上游錯誤、Redis lease TTL','V2(c) 審批 side-effect 前／後 SIGKILL、磁碟回退後再次核准及 DB 計數／audit','V3 真實串流、深度研究斷線 terminal 與 Redis MONITOR 唯一一次釋放','V4 CUA 實際瀏覽器 Gun Chat、研究 switch 與回答、Gun Shop UI 審批','V5 假模型 280 輪，7 天依序、日間重啟、RSS／檔案時間序列、載入與最長未寫檔間隔','部署目錄所有 Node 判定測試、Python 掃描測試與 MJS 語法檢查','秘密掃描、映像 digest 沿用比對、起始工作區基準／diff／whitespace 與 schema 驗證','四套隔離容器清理，保留 volumes／映像'],passed:['V2 三個指定時點均無重複 side-effect、terminal 倒退或 deserialize 失敗，遺失均在新標準邊界內','執行後回到等待審批再核准，由 durable confirmation 單次消費擋下，成功 dispatch／effect 維持 1','V3 terminal 確認後只釋放一次 lease；V4 實際瀏覽器完成三條路徑','V5 280 次假端點呼叫；RSS／目錄在門檻內，七次重啟當日 state 相同','OpenSpec strict、部署工具測試／語法、秘密／範圍／schema 檢查'],failed:[],notExecuted};
const evidenceFiles=[];
for(const [name,file,content]of [['changed-files','changed-files-apply-004.txt',changedThisAttempt.join('\n')+'\n'],['git-diff','git-diff-apply-004.patch',diff.stdout+newDiffs.map(v=>v.stdout).join('')],['git-diff-stat','git-diff-stat-apply-004.txt',stat.stdout+newStats.map(v=>v.stdout).join('')],['git-diff-check','git-diff-check-apply-004.txt',check.stdout+newChecks.map(v=>v.stdout).join('')],['validation-summary','validation-summary-apply-004.json',{verification,v5:{fakeEndpoint:true,rounds:280,peakRssBytes:v5.peakRssBytes,peakDirectoryBytes:v5.peakDirectoryBytes,longestUnwrittenMs:v5.longestUnwritten.maximumMs}}]]){const p=`${runtime}/evidence/${file}`;write(p,content);evidenceFiles.push(ref(`${name}-apply-004`,p));}
record('final-checks',{status:'pass',commands,ownedFiles,changedThisAttempt,sha256:hashes,trackedDiff:diff,diffStat:stat,diffCheck:check,statusOutput:status,ignoreCheck:ignore,newFileDiffChecks:newChecks,baselineTrackedDiffUnchanged:true,scopeNote:'既有 docker-compose.yml 修改與起始 tracked diff 完全相同；本次差異只在 deployment 與本 Change findings/tasks。',notExecuted,reportRequirementRows:27,cleanup:evidence('cleanup').status});
const {state,handoff}=guard();if(handoff.onSuccess.nextOwner!=='Qwen'||handoff.onSuccess.nextStage!=='review-result')throw Error('success_route_changed');
const resultRef=ref('implementation-result-apply-004',`${runtime}/artifacts/implementation-result-apply-004.json`,'implementation_result'),handoffRef=ref('handoff-review-result-from-apply-004',`${runtime}/artifacts/handoff-review-result-from-apply-004.json`,'handoff');
const findingsRef=ref('findings-apply-004',reportPath),tasksRef=ref('tasks-apply-004',tasksPath,'tasks'),schemaRef=ref('schema-validation-apply-004',`${runtime}/artifacts/schema-validation-apply-004.json`);
const evidenceRefs=Object.values(state.latestArtifactRefs).filter(r=>r.kind==='evidence'&&r.artifactId.endsWith('-apply-004'));
const reason='V0／V1 沿用核准證據；V2～V5 指定驗證完成，交 Qwen 獨立 review-result；V5 為本機假模型資源量測。';
const result={schemaVersion:'1.0.0',artifactId:resultRef.artifactId,changeId,runId:'run-001',producer:'Codex',stage:'apply-change',kind:'implementation_result',status:'success',rolePolicyVersion:'2',createdAt:new Date().toISOString(),summary:reason,inputRefs:[...handoff.requiredInputRefs,state.latestArtifactRefs.handoff],outputRefs:[findingsRef,tasksRef,...evidenceRefs,...evidenceFiles,schemaRef],verification,risks:[{severity:'High',description:'持續活動重設 debounce；SIGKILL 可遺失最近充分閒置寫檔後的整段活動。',mitigation:'單一實例 demo 明示偏離；下游加入停止緩衝、記憶體上限及監控。'},{severity:'Medium',description:'審批消費與 side-effect 非原子；執行前案例最終零次、operation failed，執行後回退可被 durable confirmation 安全拒絕。',mitigation:'保留實測限制，不把安全拒絕當作訂單成功；後續產品改動另行規劃。'},{severity:'Medium',description:'既有 no-op resume 無 rejected audit，且 V5 使用假端點、加速與 100ms 採樣。',mitigation:'F003 維持後續產品 Change；資源數值只代表本機指定負載。'}],nextHandoff:{handoffId:handoffRef.artifactId,stage:'review-result',to:'Qwen',reason},payload:{completedTasksThisAttempt:['2.2','3.1','3.2','4.1','5.1','5.2'],previouslyCompleteTasks:['0.1','0.2','1.1','2.0','2.1'],incompleteTasks:[],changedFiles:changedThisAttempt,allTasksComplete:true,v5Executed:true,v5FakeEndpointUsed:true,v5:{rounds:280,peakRssBytes:v5.peakRssBytes,peakDirectoryBytes:v5.peakDirectoryBytes,longestUnwrittenMs:v5.longestUnwritten.maximumMs},initialAttemptsPreserved:true,acceptance:'指定實作驗證完成；不是 readiness 或最終驗收，交獨立 Reviewer。',noCommitOrPush:true}};
const nextHandoff={schemaVersion:'1.0.0',handoffId:handoffRef.artifactId,changeId,runId:'run-001',from:'Codex',to:'Qwen',stage:'review-result',reason,requiredInputRefs:[resultRef,findingsRef,tasksRef,state.latestArtifactRefs.proposal,state.latestArtifactRefs.design,state.latestArtifactRefs.spec_self_hosted_runtime_feasibility,state.latestArtifactRefs['v2-summary-004'],state.latestArtifactRefs['v2c-after-004'],state.latestArtifactRefs['v3-stream-cancel-004'],state.latestArtifactRefs['v4-browser-004'],state.latestArtifactRefs['v5-resources-004'],state.latestArtifactRefs['final-checks-004']],expectedOutputKind:'review_result',onSuccess:{nextStage:'readiness-check',nextOwner:'CCR',reason:'獨立審查通過後交協調者執行 readiness Gate。'},onFailure:{nextStage:'fix-from-review',nextOwner:'Codex',reason:'依 Qwen 結構化 Finding 修正。'},onConflict:{strategy:'coordinator_arbitration',nextOwner:'CCR'},requiresHumanApproval:false,status:'PENDING',createdAt:new Date().toISOString(),rolePolicyVersion:'2'};
validate('result',result);validate('handoff',nextHandoff);checkRefs([...evidenceRefs,...evidenceFiles]);write(resultRef.relativePath,result);write(handoffRef.relativePath,nextHandoff);
record('schema-validation',{status:'pass',schemas:['agent-result.schema.json','handoff.schema.json','current-state.schema.json'],resultId:result.artifactId,handoffId:nextHandoff.handoffId,note:'以下 CurrentState 使用相同 validator 通過後才移交；owner 為最後一筆寫入。'});
const next=guard().state;next.latestArtifactRefs.implementation_result=resultRef;next.latestArtifactRefs.findings=findingsRef;next.latestArtifactRefs.tasks=tasksRef;next.latestArtifactRefs.handoff=handoffRef;for(const r of evidenceFiles)next.latestArtifactRefs[r.artifactId]=r;
next.currentPhase='READY_FOR_REVIEW';next.currentOwner='Qwen';next.latestHandoff={handoffId:nextHandoff.handoffId,stage:'review-result',from:'Codex',to:'Qwen',status:'PENDING'};next.blockers=[];next.nextActions=['Qwen 依新 handoff 獨立審查指定證據與範圍，經 qwen-capture-adapter 保存結果。','V5 為假模型資源量測；持續活動資料遺失、F003 與未驗證完整矩陣均在報告中。'];next.gateStatus.implementationVerified=false;next.gateStatus.readinessConfirmed=false;next.updatedAt=new Date().toISOString();
validate('state',next);checkRefs(Object.values(next.latestArtifactRefs));checkRefs(result.outputRefs);checkRefs(nextHandoff.requiredInputRefs);
handoff.status='COMPLETED';write(`${runtime}/artifacts/handoff-apply-change-004.json`,handoff);
// 最後一筆檔案寫入才轉移 owner；之後只有 stdout 與唯讀驗證。
fs.writeFileSync(path.join(root,runtime,'current-state.json'),JSON.stringify(next,null,2)+'\n');
console.log(JSON.stringify({status:result.status,phase:next.currentPhase,owner:next.currentOwner,schemas:'pass',tasks:'11/11',changedFiles:changedThisAttempt.length}));
