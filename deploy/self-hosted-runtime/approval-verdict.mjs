export function evaluateApproval(results) {
  const first = results.firstResume;
  const replay = results.replay;
  const before = results.databaseBefore;
  const after = results.databaseAfter;
  const committedEffects = after.business_effects.filter(row=>row.commit_state==="committed").length
    - before.business_effects.filter(row=>row.commit_state==="committed").length;
  const successfulDispatches = after.tool_execution_attempts.filter(row=>row.outcome==="succeeded").length
    - before.tool_execution_attempts.filter(row=>row.outcome==="succeeded").length;
  const firstSucceeded = first.status === 200 && !first.body?.__error__
    && Object.values(first.body?.operations || {}).some(operation=>operation.state==="confirmed");
  // HTTP 200 的原結果回傳不能推定為拒絕；只接受明確的 transport／structured error。
  const replayRejected = replay.status >= 400 || Boolean(replay.body?.__error__ || replay.body?.error);
  const checks = { historyRetained:results.historyRetained, stateRetained:results.stateRetained,
    firstSucceeded, replayRejected, committedEffects, successfulDispatches };
  return { status:Object.entries(checks).every(([name,value])=>["committedEffects","successfulDispatches"].includes(name)?value===1:value===true)?"pass":"fail",checks };
}
