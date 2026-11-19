import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessActivityWindow} from './activity-window-004.mjs';
const row=(id,second)=>({checkpoint:{checkpoint_id:id},created_at:`2026-11-18T00:00:${second}.000Z`});
const base={before:[row('old','01'),row('new','10')],after:[row('old','01')],lastWriteAt:'2026-11-18T00:00:05.000Z',killAt:'2026-11-18T00:00:20.000Z',durableBaselinePreserved:true};
test('持續活動超過三秒仍在最新閒置寫檔邊界內',()=>{const r=assessActivityWindow(base);assert.equal(r.status,'pass');assert.equal(r.oldestLostAgeMs,10000);});
test('已落盤 checkpoint 遺失不得放行',()=>assert.equal(assessActivityWindow({...base,after:[]}).status,'fail'));
test('durable 基準損壞不得放行',()=>assert.equal(assessActivityWindow({...base,durableBaselinePreserved:false}).status,'fail'));
test('未知寫檔時間不得推定通過',()=>assert.equal(assessActivityWindow({...base,lastWriteAt:'invalid'}).status,'fail'));
