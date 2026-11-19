import {test} from 'node:test';import assert from 'node:assert/strict';import {longestWriteGap} from './resource-sampler-004.mjs';
const r=(at,mtime,day=1)=>({at:`2026-11-19T00:00:${at}.000Z`,day,files:[{name:'checkpointer',mtime:`2026-11-19T00:00:${mtime}.000Z`}]});
test('長期未寫檔的開放區間必須計入',()=>assert.equal(longestWriteGap([r('01','00'),r('20','00')]).maximumMs,20000));
test('兩次實測寫檔間隔不能被新 mtime 清零',()=>assert.equal(longestWriteGap([r('01','00'),r('21','20')]).maximumMs,20000));
test('重啟日的間隔不跨日聯集',()=>assert.equal(longestWriteGap([r('01','00'),r('51','50',2)]).maximumMs,1000));
