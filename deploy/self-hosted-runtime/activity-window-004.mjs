// 判定最近一次已完成的閒置寫檔之後，是否僅遺失尚未落盤的活動。
export function assessActivityWindow({before,after,lastWriteAt,killAt,durableBaselinePreserved}) {
  const write=Date.parse(lastWriteAt),kill=Date.parse(killAt);
  const afterIds=new Set(after.map(row=>row.checkpoint?.checkpoint_id));
  const lost=before.filter(row=>!afterIds.has(row.checkpoint?.checkpoint_id)).map(row=>({
    checkpointId:row.checkpoint?.checkpoint_id,createdAt:row.created_at,ageMs:kill-Date.parse(row.created_at)
  }));
  const valid=Number.isFinite(write)&&Number.isFinite(kill)&&write<=kill
    &&lost.every(row=>row.checkpointId&&Number.isFinite(row.ageMs)&&row.ageMs>=0);
  const exceedsBoundary=lost.some(row=>Date.parse(row.createdAt)<=write);
  return {status:valid&&!exceedsBoundary&&durableBaselinePreserved?'pass':'fail',valid,
    lastWriteAt,killAt,durableBaselinePreserved,exceedsBoundary,lost,
    oldestLostAgeMs:lost.length?Math.max(...lost.map(row=>row.ageMs)):0,
    criterion:'僅可遺失最近一次充分閒置寫檔之後的活動；不是三秒資料年齡上限'};
}
