import {test} from 'node:test';import assert from 'node:assert/strict';
import {assessEffectCounts} from './side-effect-verdict-004.mjs';
const c=n=>({successfulDispatches:n,committedEffects:n});
test('執行前終止且安全拒絕後續核准，零次不是重複執行',()=>assert.deepEqual(assessEffectCounts(c(0),c(0),0),{noDuplicate:true,countRetained:true,appropriateKillBoundary:true}));
test('執行後再次核准仍僅一次',()=>assert.deepEqual(assessEffectCounts(c(1),c(1),1),{noDuplicate:true,countRetained:true,appropriateKillBoundary:true}));
test('第二次 side-effect 必須失敗',()=>assert.equal(assessEffectCounts(c(1),c(2),1).noDuplicate,false));
test('遺失帳本計數或沒打到執行後時點不得放行',()=>{assert.equal(assessEffectCounts(c(1),c(0),1).countRetained,false);assert.equal(assessEffectCounts(c(0),c(0),1).appropriateKillBoundary,false);});
