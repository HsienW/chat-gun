// 分開量測 last-write debounce 與遺失資料年齡；不把兩者當成同一個上限。
export function assessLossWindow({before,after,killAt,windowMs}) {
  const retained=new Set(after.map(snapshot=>snapshot.checkpoint?.checkpoint_id).filter(Boolean));
  const lost=before.filter(snapshot=>snapshot.checkpoint?.checkpoint_id&&!retained.has(snapshot.checkpoint.checkpoint_id))
    .map(snapshot=>({checkpointId:snapshot.checkpoint.checkpoint_id,createdAt:snapshot.created_at,ageMs:Date.parse(killAt)-Date.parse(snapshot.created_at)}));
  const valid=Number.isFinite(Date.parse(killAt))&&Number.isFinite(windowMs)&&windowMs>0&&lost.every(row=>Number.isFinite(row.ageMs)&&row.ageMs>=0);
  const maximumAgeMs=valid?Math.max(0,...lost.map(row=>row.ageMs)):null;
  return {status:valid&&maximumAgeMs<=windowMs?"pass":"fail",windowMs,killAt,maximumAgeMs,lost,valid,
    criterion:"依 D-3 將約三秒寫檔延遲視為遺失資料範圍上限；debounce 在每次存取後重設，實際上不提供此年齡硬上限，需 CCR 仲裁。"};
}
