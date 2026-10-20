# X28 私有 LangGraph adapter Scenario 證據

驗收範圍依 2026-10-20 已核准裁定：backend 私有 composition／adapter，使用 deterministic、mock、recorded 與本機 PostgreSQL integration。四 Graph production publication、正式 Agent Server drills、rollout 與 live isolation 屬延期 T2.2b／T5.1／T5.2。

下列路徑以 `backend/src/` 為起點。測試成功及 build 通過後才能勾選 Task；本表不是 Qwen review 或 CCR readiness 結論。

| Task／Requirement | Scenario 與可重現證據 |
| --- | --- |
| T3.1：Graph／runtime 身分映射 | `runtime/execution-context/graph-entry.test.ts`：新 invocation 配發獨立產品 UUID，偽造 canonical identity 不採用；同 thread 並行 invocation 隔離；缺身分／持久化、admission timeout／cancel 不進入 node。 |
| T3.1：產品 Run ID／native correlation 分離 | `graph-entry.langgraph.integration.test.ts`：真實 `MemorySaver` interrupt/resume，在 native run_id 改變時仍由 admission binding 恢復產品 runId；nativeRunId 僅 correlation。`graph-task-admission.test.ts`：thread／principal／tenant／scope、缺 binding、未知 correlation version typed park，原資料不變。 |
| T3.1：node／step／attempt | `runtime/framework-adapters/langgraph-task-observer.test.ts`：真實多 node 對應受信 Step port；`instrumentLangGraphNode` 在真實 native retry 的 node 內安裝相同產品 run/task/step 與遞增 attempt；取消不產生 completed Step，completion store failure 不再寫第二次完成結果。 |
| T3.2：Graph Tool 同一受治理路徑 | `runtime/tool-dispatch/pipeline.test.ts` 的 Graph／非 Graph 八組配對：success、schema、authorization、egress、sandbox、timeout、cancel、ambiguous。使用同一 canonical descriptor registry 與 dispatcher，保留 manifestVersion、correlation、typed outcome；拒絕發生在 runner 前，source executor 不被直呼。`tools/sdk/current-weather-dispatch-parity.test.ts` 保留 canonical manifest／legacy 配對；Weather／Web／Calculator／MCP 回歸由全量測試涵蓋。 |
| T3.3：有效 approval／單次 resume | `runtime/authorization/confirmation-graph.test.ts`：真實 `MemorySaver` 在 confirm node 保存等待 checkpoint，approval 前零次 physical dispatch，有效 consume 後一次；既有 `confirmation.test.ts` 驗證 actor／scope／run／resource／policy 與單次原子 consume。 |
| T3.3：無權／過期／重複／取消 | `confirmation-graph.test.ts` 覆蓋 unauthorized、approval timeout、expired、resumed、superseded 與 approval 期間 supersede。已終止 manifest 在 approval consume 前拒絕；approval 通過後仍須既有 manifest `consume` 成功才能派送。`conversation-recovery.integration.test.ts` 保留重複回覆、terminal／park 與 reconciliation 證據。 |
| T3.4：共用 metadata／compatibility | `runtime/persistence/checkpoint-adapter-metadata.test.ts` 的 langgraph/reference 共用矩陣：私有 schema、既有 manifest/runtime 版本機制、未知／缺欄位、身分衝突、compatible／migratable／incompatible、legacy migration／park。 |
| T3.4：安全 graph state／原 checkpoint | `adapter-checkpoint-boundary.test.ts`：不可序列化、secret、未知欄位、cycle、accessor、大小／深度與 schema transformation 拒絕；append 保留 parent，部署版本不支援會 park。`langgraph-adapter-checkpoint.integration.test.ts`：由真實 native checkpoint 投影宣告 state；共用 gate 成功後才 resume，等待前副作用不重播，原 checkpoint 保留。 |
| T3.4：store timeout／cancel | `adapter-checkpoint-boundary.test.ts`：寫入嘗試後 timeout／cancel 回報 indeterminate／reconcile，不能假設未提交或自動重播；read／bounded operation 保留 typed timeout／cancel。 |
| T3.5：單次 X19 正規化／ordering | `runtime/framework-adapters/langgraph-stream-adapter.test.ts`：真實 LangGraph custom stream 使用既有 `emitEnvelope` producer 正規化一次，adapter 不重配 eventId／sequence；run.terminal identity 在 producer 持久化一次。覆蓋 duplicate、bounded reordering、gap、identity／payload conflict、event／byte limits、未知 additive `run.execution` 事件與晚到 progress。 |
| T3.5：中斷／node exception／step limit | 同測試：缺 terminal 不偽造成功；初始化失敗、`guardLangGraphNode` node failure、真實 recursion limit 保留不同 private typed cause。`readStatus`／outcome 來自受信 host，native graph 結束不等於產品完成，interrupt 仍可為 needs_user。 |
| T3.6：取消／deadline／terminal 競態 | 同測試：實際 graph child 接收同一 AbortSignal，cancel／timeout 後無 late observation；completed／cancelled 任一先成為既有 host terminal guard 的勝者時，只投影一次終態，較晚 terminal／progress 不改寫。reference adapter 的相同終態競態矩陣仍保留。 |
| T3.6：framework retry／副作用不重播 | `runtime/side-effect/business-effect-ledger.integration.test.ts` 新增真實 PostgreSQL＋native retry：第一次已 committed 或 ambiguous 後 native node 重試，產品 attempt 1→2，實體副作用只有一次；已提交走 cache，不確定提交維持 manual_intervention_required。既有 retry／idempotency／ledger／interaction 測試由全量回歸涵蓋。 |

## 私有 host 邊界

- `createLangGraphStreamAdapter` 使用共用 reference adapter 的 capability、checkpoint compatibility、timeout／cancel 邊界；不新增 scheduler、executor、ledger 或 terminal owner。
- `open` 只能開啟已由受信 host 組裝的 LangGraph custom stream；同一 X19 producer 負責 model/tool/graph event 正規化及持久 identity。不得同時把原始 native stream 再投影為第二份產品事件。
- `authorizeResume` 必須接既有 durable approval／resume gate；`readStatus`／outcome 必須來自產品權威證據，不能由 native status、checkpoint ID 或模型內容推測。
- `initialSequence` 取已持久的 producer sequence；多 node 的 `contextForEvent` 由受信 Step owner 查詢。adapter 仍逐筆核對產品 run/task、principal／tenant／scope，不讓 event 自行更換權威身分。
- `instrumentLangGraphNode` 的 native correlation reference 與 Step port 由受信 host 提供；Step ID／attempt 由既有 owner 配發。Task stream observation 與 node instrumentation 是兩種接入方式，host 不得同時對同一 node 重複建立 Step。
- 本輪新增錯誤碼僅屬 backend 私有 `FrameworkAdapterError`，未新增公開 harness export、BFF route、Graph ID 或 event schema。

## 驗證及限制

實際命令、數量、輸出與 Patch 存於 CurrentState 引用的本機 validation summary。backend 全量回歸包含所有上述相鄰測試；BFF、frontend、owning repo 與 clean consumer 的前輪證據仍有效，本輪未修改這些套件／公開面。

Opik 等 opt-in live 測試略過；正式四 Graph、正式 PostgreSQL／Redis checkpoint 拓撲、Linux/macOS host 與 live isolation 未驗證。上述限制不由私有 fixture 或本機 PostgreSQL 結果取代。
