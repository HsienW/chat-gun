import test from "node:test";
import assert from "node:assert/strict";
import { assessCrash } from "./crash-verdict-003.mjs";
const base={beforeRun:{run_id:"same",status:"success"},afterRun:{run_id:"same",status:"success"},stateStatus:200,historyStatus:200,successfulDispatches:1};
test("同一 run 已 terminal 後不能在重啟時回 running",()=>assert.equal(assessCrash({...base,afterRun:{run_id:"same",status:"running"}}).terminalRegressed,true));
test("不同 run 的正常 running 不冒充 terminal 倒退",()=>assert.equal(assessCrash({...base,afterRun:{run_id:"other",status:"running"}}).terminalRegressed,false));
test("寫檔窗口內 run 遺失仍可讀取不等於倒退",()=>assert.equal(assessCrash({...base,afterRun:undefined,stateStatus:404,historyStatus:404,successfulDispatches:0}).status,"pass"));
test("讀回 500 或兩次成功 dispatch 必須失敗",()=>{
  assert.equal(assessCrash({...base,stateStatus:500}).status,"fail");
  assert.equal(assessCrash({...base,successfulDispatches:2}).status,"fail");
});
