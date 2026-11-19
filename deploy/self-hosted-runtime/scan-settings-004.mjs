import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {guard,root,runtime,privateEnv,record,digest} from "./validation-004.mjs";
const {state}=guard();
const listed=spawnSync("git",["ls-files","--cached","--others","--exclude-standard","--","deploy/self-hosted-runtime"],{cwd:root,encoding:"utf8",windowsHide:true});
if(listed.status!==0)throw Error("file_list_failed");
const files=[...listed.stdout.trim().split(/\r?\n/).filter(Boolean),"openspec/changes/spike-mit-langgraph-server/findings.md","openspec/changes/spike-mit-langgraph-server/tasks.md"];
const artifactFiles=Object.values(state.latestArtifactRefs).filter(ref=>ref.kind==="evidence"&&ref.artifactId.endsWith("-apply-004")).map(ref=>ref.relativePath);
const secrets=Object.entries(privateEnv).filter(([key,value])=>/API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL/.test(key)&&value.length>=8).map(([,value])=>value);
const script=`import json,sys,hashlib
from pathlib import Path
sys.path.insert(0,'deploy/self-hosted-runtime')
from inspect_candidates import describe
from scan_image import RULES
supplied=json.load(sys.stdin)
rows=[]
for name in supplied['files']:
 data=Path(name).read_bytes()
 hits=[{'rule':rule,'occurrences':describe(data,rule,supplied['secrets'])} for rule,pattern in RULES.items() if pattern.search(data)]
 rows.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'knownSecretHit':any(s.encode() in data for s in supplied['secrets']),'hits':hits})
artifactRows=[{'path':name,'knownSecretHit':any(s.encode() in Path(name).read_bytes() for s in supplied['secrets'])} for name in supplied['artifacts']]
print(json.dumps({'rows':rows,'artifactRows':artifactRows}))`;
const output=spawnSync("python",["-B","-X","utf8","-c",script],{cwd:root,encoding:"utf8",input:JSON.stringify({files,artifacts:artifactFiles,secrets}),windowsHide:true,maxBuffer:16*1024*1024});
if(output.status!==0)throw Error("scan_failed");
const result=JSON.parse(output.stdout);
const unresolved=[];
for(const row of result.rows) {
  let needsReview=row.knownSecretHit;
  for(const hit of row.hits) {
    for(const occurrence of hit.occurrences) {
      if(occurrence.verdict!=="false_positive")needsReview=true;
    }
  }
  if(needsReview)unresolved.push(row);
}
const passed=unresolved.length===0&&result.artifactRows.every(row=>!row.knownSecretHit);
record("settings-scan",{status:passed?"pass":"fail",...result,filesSha256:digest(files),scope:"公開 deployment／驗證檔案與 findings／tasks；另以已知私有值比對目前明確引用的 004 evidence。私有執行時設定不進映像或版本控制。"});
console.log(JSON.stringify({status:passed?"pass":"fail",files:files.length,artifacts:artifactFiles.length,unresolved}));
if(!passed)process.exitCode=1;
