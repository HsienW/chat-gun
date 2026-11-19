const TERMINAL=new Set(["success","error","timeout","interrupted"]);
const ACTIVE=new Set(["pending","running"]);

export function assessCrash({beforeRun,afterRun,stateStatus,historyStatus,successfulDispatches}) {
  const terminalRegressed=Boolean(beforeRun&&afterRun&&beforeRun.run_id===afterRun.run_id&&TERMINAL.has(beforeRun.status)&&ACTIVE.has(afterRun.status));
  const stateReadable=[200,404].includes(stateStatus)&&[200,404].includes(historyStatus);
  const duplicatedSideEffect=successfulDispatches>1;
  return {status:terminalRegressed||!stateReadable||duplicatedSideEffect?"fail":"pass",
    terminalRegressed,stateReadable,duplicatedSideEffect,
    observedTransition:beforeRun&&afterRun?`${beforeRun.status} → ${afterRun.status}`:"run 未保留／沒有可比較前後值"};
}
