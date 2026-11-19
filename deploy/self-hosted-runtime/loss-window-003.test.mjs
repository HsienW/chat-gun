import test from "node:test";
import assert from "node:assert/strict";
import {assessLossWindow} from "./loss-window-003.mjs";
const snapshot=(id,at)=>({checkpoint:{checkpoint_id:id},created_at:at});
const killAt="2026-11-18T10:00:05.000Z";
test("最後更新很新不能掩蓋較早 checkpoint 遺失",()=>{
  const value=assessLossWindow({before:[snapshot("old","2026-11-18T10:00:00.000Z"),snapshot("new","2026-11-18T10:00:04.000Z")],after:[],killAt,windowMs:3000});
  assert.equal(value.status,"fail");assert.equal(value.maximumAgeMs,5000);
});
test("只遺失窗口內 checkpoint 時通過此項",()=>assert.equal(assessLossWindow({before:[snapshot("new","2026-11-18T10:00:04.000Z")],after:[],killAt,windowMs:3000}).status,"pass"));
test("未知時間不得推定在窗口內",()=>assert.equal(assessLossWindow({before:[snapshot("unknown",undefined)],after:[],killAt,windowMs:3000}).status,"fail"));
test("已保留的較早 checkpoint 不計入遺失",()=>{
  const old=snapshot("retained","2026-11-18T10:00:00.000Z");
  assert.equal(assessLossWindow({before:[old],after:[old],killAt,windowMs:3000}).status,"pass");
});
