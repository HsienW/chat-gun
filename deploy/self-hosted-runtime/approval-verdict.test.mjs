import test from "node:test";
import assert from "node:assert/strict";
import { evaluateApproval } from "./approval-verdict.mjs";

function fixture(replay) {
  return { historyRetained:true,stateRetained:true,firstResume:{status:200,body:{operations:{call:{state:"confirmed"}}}},replay,
    databaseBefore:{business_effects:[],tool_execution_attempts:[]},
    databaseAfter:{business_effects:[{commit_state:"committed"}],tool_execution_attempts:[{outcome:"succeeded"}]} };
}
test("原結果的 HTTP 200 回傳仍使重放拒絕驗證失敗",()=>{
  const result=evaluateApproval(fixture({status:200,body:{operations:{call:{state:"confirmed"}}}}));
  assert.equal(result.status,"fail");
  assert.equal(result.checks.replayRejected,false);
});
test("明確拒絕、歷史保留且執行一次才通過",()=>{
  assert.equal(evaluateApproval(fixture({status:409,body:{error:{code:"RESUME_ALREADY_CONSUMED"}}})).status,"pass");
});
test("出現兩次成功 dispatch 不得通過",()=>{
  const input=fixture({status:409,body:{error:{code:"RESUME_ALREADY_CONSUMED"}}});
  input.databaseAfter.tool_execution_attempts.push({outcome:"succeeded"});
  assert.equal(evaluateApproval(input).status,"fail");
});
