import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { root, privateEnv, guard, record, digest } from "./validation.mjs";
guard();
const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "deploy/self-hosted-runtime"], {cwd:root,encoding:"utf8",windowsHide:true});
if (listed.status !== 0) throw Error("settings_list_failed");
const files = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
const secrets = Object.entries(privateEnv).filter(([name,value])=>/API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL/.test(name)&&value.length>=8).map(([,value])=>value);
const script = `import sys,json,hashlib
sys.path.insert(0,'deploy/self-hosted-runtime')
from pathlib import Path
from inspect_candidates import describe
from scan_image import RULES
supplied=json.load(sys.stdin)
rows=[]
for name in supplied['files']:
 data=Path(name).read_bytes()
 hits=[{'rule':rule,'occurrences':describe(data,rule,supplied['secrets'])} for rule,pattern in RULES.items() if pattern.search(data)]
 rows.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'knownSecretHit':any(s.encode() in data for s in supplied['secrets']),'hits':hits})
print(json.dumps(rows))`;
const result = spawnSync("python", ["-B", "-X", "utf8", "-c", script], {cwd:root,encoding:"utf8",input:JSON.stringify({files,secrets}),windowsHide:true});
if (result.status !== 0) throw Error("settings_scan_failed");
const rows = JSON.parse(result.stdout);
const passed = rows.every(row=>!row.knownSecretHit&&row.hits.every(hit=>hit.occurrences.every(o=>o.verdict==="false_positive")));
record("settings-scan", {status:passed?"pass":"fail",rows,scope:"Git 未忽略的本次 deployment／驗證檔案；私有執行時環境檔不進映像或公開證據。",filesSha256:digest(files)});
console.log(JSON.stringify({status:passed?"pass":"fail",files:rows.length,unresolved:rows.filter(row=>row.knownSecretHit||row.hits.some(hit=>hit.occurrences.some(o=>o.verdict!=="false_positive")))}));
if (!passed) process.exitCode=1;
