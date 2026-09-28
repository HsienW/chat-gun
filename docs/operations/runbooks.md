# Runtime Operations Failure-Drill Runbooks

本文件定義 X10.2 failure drills 的最小操作契約。所有演練都必須在受控環境執行，使用 version-pinned policy、ExecutionManifest 與 safe resources；證據只能保存已遮罩的 Task／Run／Step references、reason code、時間與彙總 metrics，不得保存 raw prompt、credential、未遮罩 PII 或 unrestricted tool output。

## 共通停止條件

- side-effect 狀態為 unknown 時，先走 X8.6 reconciliation；不得 blind replay。
- ExecutionBudget 耗盡時標記 budget_exhausted，不得宣稱成功或重設 counters。
- ExecutionManifest incompatible 時 pin old environment 或 park_manual，不得直接 resume write Step。
- drain 或 recovery 無法在 versioned policy 的界限內安全完成時，保存 checkpoint 並 park_manual。
- 健康判定必須同時檢查 operations metrics、Audit／OTel evidence 與 terminal reason；單獨的 health HTTP 200 不構成成功證據。

## Release gate 與 canary 操作

執行 release gate 時，輸入必須引用同一個 version-pinned dataset 與 policy。任一 deterministic regression、business constraint、duplicate side-effect、recovery bound、cost/latency tolerance、manifest compatibility 或 Hard Negative 檢查失敗都必須停止發布。

Live canary 必須完成 create Task、Step、persist、memory-only safe mock tool、interrupt/checkpoint、resume、Audit／OTel 與 no-duplicate 驗證，並保存 cleanup trace。任何步驟失敗都將 deployment 標記為 unhealthy。

## Canonical incident query

事故調查一律先取得 X12 canonical `runId`，再以受 X13 identity／authorization 保護的 `GET /api/incidents/:runId` 查詢。同一份結構化、已遮罩投影會一次回傳：

- `events`：versioned runtime event 的 ID、sequence、type、時間與 Task／Step／ToolCall correlation。
- `audit`：可供後續查核的 redacted audit references。
- `traces`：OTel trace references。
- `toolExecutions`：Tool 名稱與結構化 outcome，不含輸入、輸出或 credential。
- `terminalResult`：Run terminal status，不含 raw terminal output。

查詢時必須使用完整 canonical `runId`，不得用顯示文字、prompt、使用者名稱或錯誤訊息反推 Run。`400` 表示 ID 不符合 canonical schema；`403` 表示 trusted principal／grant／tenant 不符；`404` 表示目前投影索引沒有該 Run。投影只用於定位 evidence，權威狀態仍以 durable Task／checkpoint／ledger／Audit 為準。

`GET /api/incidents/:runId` 與 `GET /api/operations/metrics` 是不同邊界：前者回單一 Run 的 structured JSON 並受 incident-read authorization 保護；後者只透傳低基數 Prometheus/OpenMetrics text。不得把 `runId` 加入 metrics label，也不得把 incident projection 當 metrics exposition。

### Manifest 與 parked 狀態處置

| 狀態 | Operator 動作 | 禁止事項 |
|---|---|---|
| `migration_pending` | 等待或重跑 versioned deployment hook；確認 bounded migration window 與可信 ledger 齊全後再判定 | 不得 dispatch、resume 或以空 manifest 補值 |
| `incompatible`／parked | 比對 `runtimeBuildId`、graph、prompt、model route、tool schema、policy version；能 pin 相容環境才 resume，否則保持 parked | 不得在新版 blind replay 或忽略 manifest 差異 |
| `manual_intervention_required` | 以 incident projection 定位 checkpoint、Audit、trace、ToolExecution 與 effect ledger；mutation 先 reconcile，再依證據選擇 resume、retry 或維持 parked | 不得猜測 prompt／Tool output、重設一次性 confirmation，或讓 terminal Run 回到 running |

任何人工處置都必須記錄 operator、reason code、使用的 `runId`、manifest/version evidence 與最終決策；ticket 或外部 exporter 只能保存 redacted references。

## Drill 1：graceful shutdown／drain

- **Trigger**：對舊版 worker 發出 deployment drain，並在演練期間提交一筆新 work 與保留一筆 in-flight work。
- **Expected behavior**：舊 worker 停止新 claim；safe in-flight work 完成或 checkpoint；ambiguous effect 先 reconcile；未分類 unsafe effect 時不得回報 shutdown success。
- **Recovery**：等待 bounded drain；逾時的 safe work 保存 recoverable checkpoint，unsafe 或資料不足的 work 轉為 park_manual，再允許程序退出。
- **Success evidence**：新 claim 數為零、每筆 in-flight work 有 completed／checkpointed／parked_manual 結果、沒有未分類 effect，且 drain terminal reason 可由 Audit 與 metrics 對照。

## Drill 2：worker restart

- **Trigger**：在 replay-safe Step checkpoint 後重啟 worker。
- **Expected behavior**：以同一 Run／thread checkpoint 與 ExecutionManifest 還原；whole-goal budget counters 不歸零；replay-safe work 可 requeue 或 resume。
- **Recovery**：驗證 manifest compatible 或 migratable 後才 resume；若不相容則依 Drill 10 處理。
- **Success evidence**：同一 goalId、monotonic budget usage、單一 terminal decision，且 duplicate side-effect count 為零。

## Drill 3：heartbeat loss

- **Trigger**：停止更新 native run signal，或停止 ActiveRunOwnership／last-progress 投影，使 heartbeat freshness 超過 policy threshold。
- **Expected behavior**：health projection 標記 stale／degraded，reaper 產生 heartbeat_expired finding；不得因缺少 native signal 以零值冒充健康。
- **Recovery**：依 worker recovery 分類處理：replay-safe 才 requeue；unknown effect 先 reconciliation；unsafe ambiguity park_manual。
- **Success evidence**：stuck-run 與 heartbeat metrics 可觀察，classification 與 terminal decision 一致，沒有建立第二 worker registry 或 scheduler。

## Drill 4：Redis unavailable

- **Trigger**：在測試環境阻斷 Redis 或使用明確的故障注入使 Redis 操作失敗。
- **Expected behavior**：Runtime 不把基礎設施錯誤誤報為 success；依既有 retry policy 有界重試，operations health 顯示 degraded，且不遺失 side-effect safety 狀態。
- **Recovery**：恢復 Redis 後重新檢查 ownership、checkpoint 與 effect ledger；只 resume 可證明 replay-safe 的工作，其餘 reconciliation 或 park_manual。
- **Success evidence**：錯誤與恢復時間可追蹤、重試未超界、無重複 effect，且恢復後 queue/run health 回到 policy 允許範圍。

## Drill 5：PostgreSQL unavailable

- **Trigger**：在 checkpoint／persist 邊界使 PostgreSQL 暫時不可用。
- **Expected behavior**：未成功持久化的 Step 不得宣稱完成；操作有界失敗並保留明確 reason code；不得以 process memory 取代 checkpoint source of truth。
- **Recovery**：資料庫恢復後先驗證最後一個 durable checkpoint、budget state、manifest 與 effect ledger，再決定 resume、reconcile 或 park。
- **Success evidence**：沒有遺失或重設 budget counters、沒有重複 terminal event、持久化與 Audit references 可相互對照。

## Drill 6：stream reconnect

- **Trigger**：在 Runtime stream 傳送期間中斷 client 連線，再以既有 thread／run identity reconnect。
- **Expected behavior**：BFF 傳遞 disconnect／abort，Runtime 不無界執行；reconnect 從 durable state 承接，重複或亂序事件不使 terminal Run 回到 running。
- **Recovery**：以 checkpoint 與 stable event identity 重建顯示；若執行狀態無法證明，查 operations/Audit，而非猜測成功。
- **Success evidence**：單一 terminal state、沒有重複 tool effect、stream buffer 有界，requestId／threadId／runId 可關聯。

## Drill 7：stuck-run recovery

- **Trigger**：製造 no-progress、orphaned ownership 或 waiting-too-long 的 Run／Task。
- **Expected behavior**：reaper 以明確 reason 分類，healthy 不採取 terminal action；requeue_safe 對應 requeued／resumed；park_manual 對應 parked_manual；already_completed 對應 completed_elsewhere；effect_unknown_requires_reconciliation 對應 reconciliation_required。
- **Recovery**：只對 replay-safe work requeue；exhausted budget、unsafe ambiguity 或不足證據一律 park_manual。
- **Success evidence**：finding、classification、decision 與 Task/Audit/operations view 一致，且每個 finding 僅產生一個安全決策。

## Drill 8：compensation failure

- **Trigger**：讓已核准的 compensation action 回傳失敗或逾時。
- **Expected behavior**：compensation failure 與原始 effect 狀態分開記錄；不得吞錯或將未完成 compensation 標記為 reconciled。
- **Recovery**：依 X8.6 policy 有界重試；超界或結果不明時 park_manual，保留 operator 可查的 evidence reference。
- **Success evidence**：compensation outcome metric、reason code 與 Audit 一致；沒有重複原始 effect，且 unresolved work 可由人工佇列定位。

## Drill 9：side-effect reconciliation after crash

- **Trigger**：在外部 effect 可能已發生、但 ledger 尚未記錄確定結果的時間點終止 worker。
- **Expected behavior**：恢復時分類為 effect_unknown_requires_reconciliation，terminal decision 為 reconciliation_required；不得直接 replay write Step。
- **Recovery**：以 X8.6 reconciliation 查明 applied／not_applied／unknown；只有可證明 not_applied 且 policy 允許時才重試，applied 視為已完成，仍 unknown 則 park_manual。
- **Success evidence**：reconciliation trace 完整、duplicate effect count 為零，最終狀態與 ledger／Audit 一致。

## Drill 10：incompatible-version resume

- **Trigger**：以舊 checkpoint 搭配不相容的 runtimeBuildId、graph、prompt、model route、tool schema 或 policy version 嘗試 resume。
- **Expected behavior**：manifest comparison 回 incompatible；write／side-effect Step 不執行，Run 不因新版部署而 blind replay。
- **Recovery**：優先 pin old compatible environment；無法 pin 時 park_manual 並附上 manifest 差異與 operator action。只有明確 migratable 且 migration 成功時才 migrate then resume。
- **Success evidence**：resume decision、manifest differences 與 Audit 可查；不相容環境沒有 tool invocation 或新 side effect。

## Durable HITL 與 conversation recovery 決策表

| Recovery 證據 | 安全動作 | Operator 要求 |
|---|---|---|
| `not_started`／`executing` 且 history 為 `valid` 或可安全 `sanitized` | 由 checkpoint 繼續執行 | 確認 ExecutionManifest 相容與 budget 未耗盡 |
| `waiting_user` 且 manifest 為 `waiting` | 驗證 response schema、scope 與 Run/Task correlation，完成一次性 consume 後 resume | 不得手動重設已消費的 manifest；重播請保留 Audit evidence |
| `committed`／`unknown` mutation | 必須先執行 SideEffectReconciler，依 `commit`／`retry`／`defer` 決策 | `unknown` 不得 blind retry；無 reconciler 時一律 park |
| sanitizer 回 `parked` | 轉 `manual_intervention_required` | 不得自行補寫或猜測 message；只依 redacted reason code 定位原始 checkpoint |
| ExecutionManifest incompatible／migration required | pin 相容版本、執行核准 migration，否則 park | 記錄 graph/config/schema version 差異，禁止在新版直接 replay |
| `terminal` | stop，不得回 `running` | 驗證 terminal event、Task 狀態與 checkpoint 收斂一致 |

### Parked／manual intervention 操作步驟

1. 以 `threadId`、`runId`、`taskId`、`interruptId` 與低基數 reason code 定位 Task、checkpoint、manifest、ledger 與 Audit；不得把 raw prompt、credential、PII 或 unrestricted tool output 複製到 ticket／外部 exporter。
2. 確認 manifest correlation、expiry、status、ExecutionManifest compatibility，以及 checkpoint 是否仍有 native interrupt。任一權威資料缺失或互相矛盾時維持 parked。
3. 若 mutation 為 `committed` 或 `unknown`，先執行對應 SideEffectReconciler。只有 `not_committed` 且 policy 明確允許 retry 時才可重試。
4. 若 sanitizer 僅刪除 partial assistant message、orphaned block、unmatched/duplicate tool result 等可安全片段，保存 dropped reason summary 後才可續跑；`UNPROVABLE_HISTORY`、incomplete tool arguments、already-terminal tool result 或 incompatible manifest 不得人工猜值補齊。
5. 只有在 response schema、trusted scope、原 Run/Task 與一次性消費均通過時才 resume。confirmation 以 X13 decision store 的 `approvalId` 為權威；clarification 以 manifest `waiting → resumed` 為權威，不建立第二個 token。
6. 完成後核對沒有重複 side effect、terminal 沒有回到 running，並保存 lint/test/build、checkpoint integration 與 redacted Audit evidence。

### Live restart 驗證狀態

目前 deterministic integration 使用實際 LangGraph `MemorySaver` checkpoint 驗證 native interrupt、sanitizer、one-time resume、reconcile routing 與 terminal 收斂；跨 process 的 live restart checkpoint 存活尚未驗證。發布或宣稱 durable restart 前，必須在具 durable checkpointer 的環境執行 worker termination／restart drill，否則驗證結果標記為「未驗證」。

## 演練結案紀錄

每次 drill 至少記錄 policy/version、runtimeBuildId、ExecutionManifest digest、開始與結束時間、預期與實際 terminal reason、相關低基數 metrics、已遮罩 evidence references、cleanup trace，以及未執行項目。任何 success evidence 缺失都視為演練未通過。
