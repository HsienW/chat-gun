# Tasks：commerce-assistant-and-approved-side-effects

> lite profile（ADR-FL-001）。每個 Task 可獨立驗證；只有程式、測試與驗證都實際完成並通過後才能勾選。live 驗證（真實模型）與 deterministic 測試分開記錄，mock 通過不得當作 live 通過。日程對應 `second-stage-plan-en-v7.md`：D3 Shopping Assistant Graph、D4 Refund Under Approval。實作基底為 `feat/4.6.5-feat/lane-knowledge-retrieval`（含 X42），不得只建立在 `master`。證據存於 `.agent-runtime/commerce-assistant-and-approved-side-effects/evidence/`。

## T0 唯讀盤點與命名對齊（D3 開始前）

> 前置：無。T1–T13 皆引用本盤點結果。對應 design §2。第 4 版的 apply-change 已由 CCR 完成一次 T0（`evidence/t0-inventory.md`，發現 S1–S4 並退回 PLAN_DRAFT）；本次實作者必須重新確認該紀錄仍成立，並補上下列第 5 版新增項目。

- [x] 以 `master` 實際比對 design §2 的每一列假設（confirmation 節點組裝、X20 durable 審批、dispatch pipeline 依來源 flag 建立、runner 重用與 claim 結果映射、拒絕錯誤碼、既有 `cancel` 輸入與審批紀錄、逾期判定時機、審批狀態 CHECK、resume 的 run 綁定、tool 全量載入、前端審批 UI、BFF 透傳、ledger 是否寫入 decisionId、等待 tool 審批時 `cancel` 的分類與處理路徑、未取得 claim 時寫入的執行紀錄狀態、重用結果的 payload 內容、部署環境的 active scope 粒度、已核准但尚未 ledger claim 時的取消中止訊號是否在 claim 前被檢查），記錄結論與差異。中止訊號若不會在 claim 前被檢查，停止並回報 CCR（影響「已核准但尚未執行時取消」的成立）。scope 若不是 tenant 層級，停止並回報 CCR 重新評估 design §13 Q2。
- [x] 盤點所有讀取或寫入 `business_effects.commit_state` 的元件（取消判定、recovery、補償／saga、狀態查詢、資料治理、運維查詢），逐一記錄新增「已釋放」後的處理方式（等同沒有任何效果；第 7 版改以 `released_at` 欄位表達，盤點結果仍適用，見 design §6.8、§6.11）。
- [x] 盤點所有同時寫入 `business_effects` 與 `tool_executions` 的交易及其加鎖順序（design §6.9、§19 SI-1）。
- [ ] 對齊命名：authorization action、approval policy key、資料分級 key、data inventory 分級值、typed failure 碼（design §9）、`confirmationOutcome` 欄位、去重 outcome 形狀；語意不得改變。
- [x] 確認 `card.emit` 的發出機制與前端解析點，以及 interrupt resume 經 BFF 的既有路徑。
- [x] 產出盤點紀錄 `evidence/t0-inventory.md`。

驗證命令：

```bash
cd backend
npm run build
```

## T1 Confirmation：結果區分、撤回與寫入路徑的逾期判定（additive）

> 前置：T0。對應 `approved-order-operations`「訂單變更只在 durable 人工審批後執行」「取消只在生效前有效」。

- [x] confirmation 節點 factory 新增 opt-in 選項（預設關閉），開啟時在 tool message 與 state 加入機器可讀的審批結果（denied／expired／withdrawn）；`mcp_agent` 不開啟，其 tool message 逐位元組不變。
- [x] runtime migration（additive，design §6.11）：`authorization_confirmations` 以 `ADD COLUMN IF NOT EXISTS` 新增 nullable `withdrawn_at`、`withdrawn_by_principal_id`；不修改既有 CHECK；更新 `migration-runner` 清單與 `migration-additive.test.ts` 的預期數量，並通過 additive 檢查。
- [x] 審批儲存新增撤回轉移（design §6.2 步驟 4）：以單列 CAS 把 `pending` 轉為既有的 `denied`，同時寫入 `withdrawn_at`、`withdrawn_by_principal_id`；綁定 approvalId、decisionId、tenant、scope 與允許的審批人，**不要求 runId 相同**；同時把 interrupt manifest 由 `waiting` 轉為 `superseded`、task 與 step 轉為 cancelled、`permission_decisions` 記 `deny`／`CONFIRMATION_CANCELLED`。已逾期轉 `expired`；已決定回傳 `CONFIRMATION_ALREADY_DECIDED`；寫入失敗回傳 `CONFIRMATION_WITHDRAW_FAILED`。撤回後的 resume 回傳既有 `CONFIRMATION_REPLAYED_OR_EXPIRED`。
- [x] 審批儲存新增依 approvalId 讀取目前狀態（唯讀，含 `withdrawn_at`），供 opt-in 節點把 resume 失敗映射為 `withdrawn`（`denied` 且 `withdrawn_at` 有值）。
- [x] interrupt manifest repository 新增 additive 查詢：依 thread 與 scope 查等待中的 `confirmation` manifest。
- [x] interaction orchestrator 新增 opt-in 設定（預設關閉）：取消輸入在沒有 active run 時，若該 thread 有等待中的 confirmation manifest，改為以新 run 送進 graph，而非 `NOTHING_TO_CANCEL`。只由 `shopping_assistant` 的 orchestrator 開啟（掛載於 T4／T6）。
- [x] 測試：拒絕、逾期、撤回三者可區分（撤回為 `denied` 且 `withdrawn_at` 有值）；既有 `consume` 對已撤回的審批視為不可消費；`migration-additive` 檢查通過；撤回綁定不要求 runId 相同、但 principal 不在允許清單時拒絕；撤回後 resume 不 dispatch；撤回與核准並行時只有一個生效；撤回時已決定回傳 typed 結果；撤回寫入失敗回傳 `CONFIRMATION_WITHDRAW_FAILED` 且審批維持 `pending`；opt-in 轉送在有等待中 confirmation manifest 時送進 graph、沒有時仍為 `NOTHING_TO_CANCEL`；未開啟 opt-in 的 orchestrator 行為不變；`mcp_agent` 既有 confirmation 與取消測試全數通過且 tool message snapshot 不變；重放已消費審批回傳 typed failure 且不 dispatch。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## TH harness 契約新增去重結果類型（在 harness repo 執行，第 8 版）

> 前置：無，可與 T2a 並行。對應 `side-effect-tool-execution-runtime`「去重結果 MUST 在 governed outcome 中可觀察」；design §6.12、§19 SI-4。Master 授權直接修改 harness、不另開 change。本 repo 的 CCR 寫入檢查不允許寫入 workspace 以外的路徑，因此本 Task MUST 由以 harness repo 為工作目錄的 session 執行，依該 repo 的規則與 Master 在該處的授權；本 repo 只記錄結果。

- [ ] 在 `@gun-ai/harness-contracts` 新增 `deduplicated` 類型（`reason`、`original`、`result?`，design §6.12），三處定義同步（`tool.ts` 的 zod schema 與 `GovernedOutcome`、`side-effect.ts` 的 `GovernedToolOutcome`）；`ToolExecutionTerminationCause` 新增 `deduplicated`。不加入任何業務語意。
- [ ] 測試：三種 reason 皆可通過 envelope 驗證；`committed_result_reused` 缺 `result` 被拒絕；其他 reason 帶 `result` 被拒絕；`original` 多出欄位被拒絕；既有 7 個類型的驗證結果不變。
- [ ] 更新 `api-surface.json`、CHANGELOG；harness 自身的 build 與 test 通過。
- [ ] Master 發布新版（預設 `0.1.0-alpha.3`；其他 `@gun-ai/*` 是否同步發版依 harness repo 的版本規則）。發版是對外動作，由 Master 執行或明確授權。
- [ ] 在本 repo 的 evidence 記錄 harness 的 commit、發布版本與驗證結果（`evidence/th-harness.md`）。

驗證：依 harness repo 的 build 與 test 命令；結果記錄於 `evidence/th-harness.md`。

## T2a Side-effect runtime：審批決策傳遞、claim 釋放與加鎖順序（additive）

> 前置：T0。不依賴 TH。對應 `side-effect-tool-execution-runtime`「確定未提交即結束的執行 MUST 釋放 business effect claim」「已預先完成的授權 MUST 攜帶已消費的決策識別」「已釋放與未取得 claim 的表達 MUST 與舊版 runtime 並存」「同時寫入 business effect 與執行紀錄的路徑 MUST 以一致順序加鎖」；design §6.8、§6.9、§6.10、§6.11。

- [x] **S1 審批決策傳遞**（第 9 版依實作更正文字，design §6.10）：gate 允許與審批通過時把 decisionId 寫入 `activeToolCall.authorizationDecisionId`，`physical_dispatch` 以 `executeAuthorizedTyped` 的型別參數交給 pipeline（不經 execution config）；pipeline 在 `authorizationAlreadyEvaluated` 時以 `{ type: "authorized", decisionId }` 交給 runner；runner 以既有 `linkAuthorizationDecision` 寫入；缺 decisionId 時在 claim **之前**以 typed failure 拒絕。decisionId 只來自已消費的審批紀錄。
- [x] **decisionId server 端驗證**（第 9 版補記，Master 指示）：有副作用的預先授權 dispatch 以 `PgConsumedAuthorizationVerifier` 對照 `permission_decisions` 與 `authorization_confirmations` 驗證後才進 runner；不通過、拋錯或沒有驗證器即 dispatch 前拒絕並記 audit。已於 T2a 期間實作並以 pipeline 單元測試與真實 Postgres 整合測試驗證（`evidence/t2a-summary.md`）。
- [x] **S3 claim 前檢查中止**：runner 在 `prepare` 前檢查中止訊號，已中止則回傳 dispatch 前取消且不 claim。
- [x] **S2 未提交即釋放**：runtime migration（additive，design §6.11）以 `ADD COLUMN IF NOT EXISTS` 為 `business_effects` 新增 nullable `released_at`、為 `tool_executions` 新增 nullable `claim_disposition`（新欄位自帶 CHECK，只允許 `not_claimed`）；不修改既有 CHECK 與 `BusinessEffectCommitState` 值域。runner 在單一集中出口，於確定未提交的結果（授權拒絕、dispatch 前拒絕、dispatch 前取消、`failed_not_committed`、reconciliation `not_committed`、dispatch 前逾時）以 CAS 在 `prepared` 且 `released_at IS NULL` 的效果上寫入 `released_at`；未知、已提交、持久化不確定絕不釋放。
- [x] **重新占用**：`prepare` 遇到「`prepared` 且 `released_at` 有值」時以 CAS 清空 `released_at` 並建立新的 tool execution；並行重新占用只有一個成功，另一個為 `in_flight_duplicate`。
- [x] **加鎖順序一致**：提交、釋放、重新占用三條路徑在同一交易內皆先鎖 `business_effects` 再鎖 `tool_executions`；調整既有 `commitExecutionAndBusinessEffect` 的順序（行為不變）。
- [x] 依 T0 盤點，更新需要辨識「已釋放」的讀取方（ledger 的 `prepare`、`mapBusinessEffect`）；取消判定、備份、資料治理依 design §6.8 不需修改，以測試確認。
- [x] 未取得 claim 時寫入的執行紀錄改為 `status = 'failed'` 加 `claim_disposition = 'not_claimed'`（不再寫 `unknown`），可與「已 dispatch 但結果未知」區分；只有實際 dispatch 過的執行能觸發 reconciliation。此項不改變 outcome 映射（映射屬 T2b）。
- [x] 測試：
  - 審批後執行連結 decisionId；缺 decisionId 在 claim 前拒絕且無 claim；claim 前已中止則無 claim。
  - 釋放：未提交失敗、dispatch 前取消、已 claim 未 dispatch 的取消、reconciliation `not_committed`、dispatch 前逾時皆釋放；未知、已提交不釋放。
  - 重新占用：釋放後新提交執行一次；並行重新占用只有一個成功。
  - 加鎖順序：真實 Postgres 上提交、釋放、重新占用對同一 business effect 並行，不發生死鎖且每個轉移只有一個成功；結果寫入 evidence 並更新 design §19 SI-1 狀態。
  - 未取得 claim 的執行紀錄為 `failed` 加 `not_claimed`，重播時不觸發 reconciliation、不建立 reconciliation task。
  - 新舊版本並存：以未辨識新欄位的讀取路徑（既有 `mapBusinessEffect`、`PgCancellationLedgerReader`）讀取已釋放的效果與 `not_claimed` 執行紀錄不會 throw、不會判定為已提交；`migration-additive` 檢查通過。
  - 既有 dispatch、runner、ledger、取消判定、recovery、saga 測試全數回歸。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T2b Side-effect runtime：去重結果（第 8 版）

> 前置：T2a、TH（harness 新版已發布）。對應 `side-effect-tool-execution-runtime`「去重結果 MUST 在 governed outcome 中可觀察」；design §6.5、§6.12。

- [x] `backend/package.json` 與 lockfile 的 `@gun-ai/*` 升到 TH 發布的版本；只改版本，不升級其他依賴。
- [x] dispatch 設定新增去重 opt-in（預設關閉）；開啟的來源：重用已提交結果 → `deduplicated`／`committed_result_reused`（帶原結果與原 business effect 參照）；未取得 claim 依原效果狀態 → `in_flight_duplicate` 或 `original_outcome_unknown`；同一 replay key 重播時依原 business effect 的目前狀態決定。未開啟的來源維持既有映射與錯誤碼。
- [x] 窮舉消費者明確處理 `deduplicated`：circuit breaker 不計為失敗；audit 記錄類型與原因；`tool-governance.ts` 的 legacy 映射帶 `result` 時回傳原結果、否則回傳與既有 `SIDE_EFFECT_CLAIM_NOT_ACQUIRED` 相同的錯誤字串；未處理時 fail-closed。
- [x] 測試：
  - 開啟 opt-in：重用、進行中重複、原效果未知三種 reason；進行中重複被重播（原效果已提交／仍進行／未知三種）依目前狀態回傳且不建立 reconciliation task；原效果已釋放時不判定為去重；replay conflict 不變；ledger 不可用 fail-closed；外部系統無呼叫。
  - 未開啟 opt-in：重用與進行中重複的結果與錯誤碼與變更前一致（以既有測試與新增對照測試證明）。
  - 去重不使 circuit 開啟；legacy 映射對 `deduplicated` 的輸出與既有值一致。
  - 既有 dispatch、runner、ledger、取消判定、recovery、saga 測試全數回歸。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## TS BFF：客戶端不得直接寫入 graph state（第 9 版）

> 前置：T0（§13）。不依賴其他 Task，可先做。對應 `client-graph-state-boundary`「客戶端 MUST NOT 經 BFF 直接寫入 graph state」；design §6.13。需要 `bff/src/` 寫入授權。

- [x] 實作前核對：以安裝中的 `@langchain/langgraph-api` 版本重新列出會寫入 state 的路由與欄位、以 POST 實作的唯讀路由，確認與 design §6.13 表格一致；不一致即停止回報。
- [x] 在 BFF 既有本文檢查旁新增客戶端 state 寫入檢查（轉送前執行）：拒絕 `POST /threads/{id}/state`、本文帶 `supersteps` 的 `POST /threads`、任何本文（含批次陣列與 crons）中 `command` 含 `resume` 以外欄位的請求；回 HTTP 400 與 `CLIENT_STATE_WRITE_FORBIDDEN`，不轉送，記 audit（不記本文）。路由樣式與欄位清單集中於單一具型別常數，不寫死實際 ID。
- [x] 測試（bff 既有測試入口）：上述每一種拒絕且上游未被呼叫；`command` 同時含 `resume` 與 `update`／`goto` 仍拒絕；批次中一筆違反即整批拒絕；只含 `resume` 的 `command` 照常轉送；唯讀 POST（history、state/checkpoint、search、count）照常轉送；prompt（含 deep_researcher 設定欄位）與取消輸入照常轉送且回應不變；本文無法解析時沿用既有行為；既有 BFF 測試全數回歸。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T3 訂單 tool、模擬 provider 與 manifest

> 前置：T0、T2a。對應 `approved-order-operations` 的 manifest、失敗分類、ledger、無 undo Requirement；`commerce-assistant`「只經統一 dispatch 且只取得 agent manifest 授予的 tool」。

- [x] 合成訂單 fixture（provenance header 標註 synthetic；含可退款、不符資格、他人訂單、多明細訂單）。
- [x] 模擬訂單 provider（in-memory）：業務規則、依 business effect key 或操作識別查詢、可設定的故障注入（dispatch 前不可用、提交後回應遺失、查詢無法判定、逾時）。故障注入只在測試與評測設定中啟用。
- [x] `order_refund_request`、`order_cancel`（SideEffectToolDescriptor：business effect key 推導依 design §6.3，含 server 端申請者 principal；宣告 reconciler；output 為只含效果事實的 `order_effect_result@1`，不含操作識別與狀態，design §5.5）、`order_operation_status`（唯讀）。
- [x] 三個 tool 經 X27 SDK manifest 註冊（design §5.1–5.3），manifest 缺欄位 fail-closed；input strict，夾帶身分或審批欄位 schema error。
- [x] `shopping_assistant` X27 agent manifest；tool runtime 依 agent manifest 篩選；`shopping_assistant` 強制建立 dispatch pipeline，不依 feature flag。
- [x] 測試：business effect key 不含 attempt／toolCallId／runId／理由文字；business effect key 含申請者 principal，不同申請者對同一訂單為不同 key；不同明細為不同 key；他人訂單與查無訂單結果相同；provider error 不轉為 not found；`mcp_agent` 的 tool 清單不含訂單 tool；ledger 不可用時訂單 tool typed deny 且 provider 無呼叫。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T4 `shopping_assistant` graph 與意圖路由（D3）

> 前置：T0、T3。對應 `commerce-assistant`「意圖路由」「商品查詢」「不可信內容」。

- [x] graph 註冊於 `langgraph.json`；execution manifest 使用自己的 graphId；以既有 execution context、interaction governance 與 Opik instrumentation 包裝。
- [x] State 欄位依 design §4.2（owner、write timing、default、checkpoint 行為）實作；無不可序列化物件。
- [x] 輸入 schema（第 9 版，design §6.13）：graph 宣告獨立輸入 schema，只含 `messages`、`kind`、`targetRunId`；測試 run 輸入夾帶 `pendingAuthorization`、`activeToolCall`、`toolQueue`、`operations`、`runtimeEventCursor` 時不寫入 state，一般訊息與取消輸入照常處理。
- [x] 新增 backend `card.emit` producer（design §8.1）：node 以 state update 回傳 `runtimeEvents`（每次 update 取代、不累積）；envelope 的 `context` 取自 server 端 execution context；`runtimeEventCursor` 使每個 run 的 `sequence` 從 1 開始連續、runId 改變時重設，`eventId` 由 runId 與 sequence 推導；沿用既有 envelope 與前端解析，不改 `runtime-event-contract`。以測試證明事件形狀與序號通過前端既有的解析與緩衝（同一 run 連續、新 run 從 1 開始、replay 時 eventId 相同）。
- [x] `shopping_intent@1` 結構化輸出、strict schema、有界重試、schema invalid 進入澄清並記錄 typed failure；不以模型名稱分支。
- [x] 商品分支：只綁 `kb_search`，經 gate／dispatch，`product_present` 驗證 `kb_search_result@1` 後，每個 sourceId 發出一張 `product_result@1` card（取排序最前的 chunk）。
- [x] prompt 先建立 golden case 再撰寫；記錄模型與生成參數。
- [x] 測試（deterministic）：三種意圖與不支援請求的路由；schema invalid；路由逾時與取消不呼叫 tool；商品卡片欄位只來自結構化結果；同一商品多個 chunk 只有一張卡片；no source found 不發卡片；檢索失敗明確無法查詢。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T5 政策問答、拒答與跨輪隔離（D3）

> 前置：T4。對應 `commerce-assistant`「政策問答必須帶可驗證引用或明確拒答」「每輪檢索證據互相隔離」。

- [x] `policy_answer`：evidence found → 合成 → X42 citation 驗證；no source found → 拒答且無 citation；驗證失敗 → 無法提供經驗證答案並發出驗證失敗事件；檢索失敗 → 明確無法回答。
- [x] `turnEvidence` 每輪重設；citation 驗證只接受本輪結果。
- [x] 測試：上述四種結果；商品查詢後接政策問答時引用前一輪 citation 判定失敗；checkpoint 恢復後新一輪證據為空；注入 chunk 不觸發訂單 tool。

**D3 Gate**：同一 session 完成「商品查詢 → 政策問答」，政策引用正確且無跨輪污染（live，記錄於 `evidence/d3-live-smoke.json`）。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T6 審批、取消與訂單分支（D4）

> 前置：T1、T2b、T3、T4。對應 `approved-order-operations`「durable 人工審批」「取消只在生效前有效」。

- [x] 訂單分支：只綁訂單 tool，經 dispatch 就緒預檢 → gate → confirmation interrupt → dispatch；`operations` state 為以 toolCallId 為鍵的 map，同一則訊息的多個訂單 tool call 各自獨立，reducer 依 design §4.2 規則（依 toolCallId 合併、只接受較新 `stateVersion`、terminal 後忽略非 terminal）。`order_present` 依 graph state、`confirmationOutcome` 與 governed outcome 組成 `order_operation_status@1` card（`operationRef` 一律為本次提交；`stateVersion` 單調；`requested` 起即發出；審批後帶 `operationId = approvalId` 與 server 提供的期限；去重時原操作只在 `dedup.of`）。`dedup.of` 以唯讀查詢依 `deduplicated.original` 經 decisionId 連結解析為原 approvalId，只限目前 tenant 與 principal；查不到時省略 `dedup.of` 並記錄 typed observation，仍為 `deduplicated`（design §6.5）。
- [x] dispatch 就緒預檢：pipeline、ledger 或審批儲存不可用時 `ORDER_DISPATCH_NOT_READY`，不建立審批。
- [x] 取消（design §6.2）：shopping graph state 宣告 `kind`、`targetRunId` channel；START 依 `kind` 分流；`cancel_pending_operation` 只依 checkpoint 中的審批描述撤回（`targetRunId` 只比對），成功時發出 `cancelled_before_effect` card 並清除等待狀態，`toolQueue` 中尚未建立審批的訂單 tool call 一併結束為 `cancelled_before_effect`；沒有等待中的審批時回覆無可取消；撤回失敗時保留可重試狀態；shopping orchestrator 開啟 T1 的 opt-in 轉送。測試須涵蓋 governance 未啟用與已啟用兩種設定，並以真實 checkpointer 驗證取消後舊 interrupt 不再被 resume。
- [x] 取消（其餘狀態）：已核准未 claim 時取消為 `cancelled_before_effect` 且無 ledger claim；已 claim 未送出時取消為 `cancelled_before_effect` 且 claim 被釋放（T2a）；執行中取消不中止效果、不呈現為取消。
- [x] 版本化審批逾時設定（預設 15 分鐘）；測試使用短逾時。
- [x] 測試：核准執行一次；拒絕、逾期、撤回無 provider 呼叫且結果可區分；預檢失敗不建立審批；核准後 ledger 失效 fail-closed；重放審批不重複執行；等待審批時重啟後仍可決定、不重複建立審批，且前後事件的 tool call 參照與操作識別相同；同一則訊息兩筆訂單產生兩個獨立操作且互不覆蓋；`operations` reducer 拒絕較舊 `stateVersion` 與 terminal 後的非 terminal 更新；重用已提交結果時狀態的識別屬於本次提交、原操作卡片不變；檢索內容聲稱已預先核准仍需審批；已確認後要求撤銷不呼叫任何補償。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T7 冪等、並行重複與未知結果（D4）

> 前置：T2a、T2b、T3、T6。對應 `approved-order-operations`「冪等鍵」「未知結果進入 reconciliation」「ledger 紀錄」。

- [x] reconciliation task：runtime Postgres 新 migration（只建立新表，以 business effect 唯一）；登記 data inventory；只存識別碼。
- [x] 未知結果流程依 design §6.6：reconciler committed → confirmed（reconciled）；not committed → failed 不重試；unknown → `outcome_unknown` + task；task 寫入失敗仍為 `outcome_unknown` 並發出 audit。
- [x] **並行**重複提交整合測試：真實 Postgres ledger，同一使用者在同一 tenant 的**兩個 thread** 各自提交並核准同一邏輯退款，兩次提交以並行方式同時進入 dispatch（對應使用者實際能觸發的路徑，design §13 Q2）；斷言 provider 提交一次、ledger 一筆已提交 business effect、另一次為 `in_flight_duplicate` 或 `committed_result_reused` 去重。測試必須證明兩次提交實際重疊（例如以 provider 的阻塞閘門讓第一次停在提交中）。
- [x] 其他測試：provider 在 dispatch 前不可用而失敗後，同一使用者重新申請並重新核准時實際執行一次、不是去重；已確認後以不同理由重複申請為去重；同一使用者在不同 thread 重複申請為去重；同 tenant 的他人對已退款訂單申請相同退款時為 `ORDER_NOT_FOUND` 而非去重，回應不含原操作的任何識別，provider 無提交；不同明細獨立執行；回應遺失三種 reconciler 結果；task 不重複建立；確認後 ledger 連結審批決策與 externalOperationId。

**D4 Gate**：並行重複提交只提交一次，第二次可觀察為去重。**Human：確認測試為並行**（記錄於 `evidence/d4-concurrency.md`）。Master 已於 2026-10-25 確認：以兩個 pipeline 模擬兩個 instance 的並行重複提交測試，符合「確認測試為並行」的意圖。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T8 訂單狀態查詢

> 前置：T1、T3、T7。對應 `approved-order-operations`「訂單狀態查詢只讀取權威狀態」「操作識別從申請起即存在且可連結至 ledger」。

- [x] 操作摘要（design §6.7 第 11 版，Master 決策 A1）：additive migration 新增 `order_operation_requests` 表（通過 `migrations:check`）並登記 data inventory；授權 gate 新增 opt-in 的「建立審批前記錄」掛點，只有 `shopping_assistant` 開啟、只記錄訂單變更 tool；摘要先於審批紀錄寫入，寫入失敗時不建立審批與 interrupt，以 `ORDER_DISPATCH_NOT_READY` 結束並記 audit；不存 note、reasonCode 或數量。
- [x] `order_operation_status` 以 `operationId`（= approvalId）或 orderId 查詢：從操作摘要取得 toolCallId、kind、orderId，審批前與審批中讀審批紀錄（`pending` 且已過期限時計算並回報為逾期，**不寫入**），dispatch 後經 decisionId 連結讀 ledger 與 reconciliation task，狀態對照依 design §5.3；只回傳目前 tenant、scope 與 principal 的操作；production 以 Pg reader 取代 fail-closed 的暫時 reader。
- [x] 確認 ledger 的 tool execution 確實寫入 decisionId；若未寫入，於 T2a 以 additive 方式補上。
- [x] 測試：審批中查詢回傳等待審批；過期未決的審批查詢回傳逾期且審批紀錄未被修改，之後的核准 resume 仍判定為逾期；確認後連結 business effect 與 externalOperationId；未知結果回傳 task 識別；他人操作 typed not found；不讀取對話文字；摘要寫入失敗時沒有審批紀錄與 interrupt、操作為 `failed`／`ORDER_DISPATCH_NOT_READY`；只有摘要沒有審批紀錄時查詢為 not found；未開啟掛點的 graph 行為不變。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## TR 審批 resume 以伺服器端記錄的等待中 run 綁定（第 12 版，S9；第 13 版修訂）

> 前置：T1、T6。對應以下 Requirement：
> - `trusted-tool-authorization`「resume MUST 為一次性、scoped，且 Agent MUST NOT 自我批准」（MODIFIED）
> - `durable-hitl-conversation-recovery`「resume 只回到預期 waiting Task 且最多消費一次」（MODIFIED）
> - `approved-order-operations`「訂單變更只在 durable 人工審批後執行」
>
> 依據 design §6.14。修改位於共用授權節點與審批儲存，`shopping_assistant` 與 `mcp_agent` 同時生效（Master 決策：`mcp_agent` 直接納入），不另設 opt-in。只需 `backend/src/` 寫入授權；不改 BFF、frontend、harness 與 migration。
>
> 第 13 版（Master 2026-10-26 決策：方案 1，`evidence/tr-inventory-and-stop.md` §2）：節點新增的 `waiting` 與 thread 檢查改為 typed failure＋audit；production 補接 confirmation audit sink。施工順序依 Master 指示：先把既有斷言與測試替身調整為新契約並補上 `shopping_assistant` 與 `mcp_agent` 的不同 run 測試，再實作，之後才進入隔離 Postgres integration；T9 第 2 項的 live smoke 最後執行。

- [x] 實作前唯讀盤點 `mcp_agent` 實際會進入審批的 tool（risk tier 為 `sensitive`／`communication` 或宣告 `requireConfirmation`），記入 evidence，作為下方 `mcp_agent` 測試的涵蓋依據。（2026-10-26：只有 MCP `filesystem` 的 `write_file`、`edit_file`、`create_directory`、`move_file`；`evidence/tr-inventory-and-stop.md` §1）
- [x] **先調整既有測試為新契約**（實作前，記錄修改前的失敗證據）：（2026-10-26，HEAD 程式＋新測試 25 項失敗；`evidence/tr-summary.md` §3）
  - 既有測試替身中依 runId 相等判定綁定的部分（例如 `order-branch.test.ts` 的 `MemoryConfirmations.consume`）改為 threadId 相等；其他綁定不得放寬。
  - `order-branch.test.ts`「does not run a replayed approval again」維持既有斷言（`failed`、`CONFIRMATION_REPLAYED_OR_EXPIRED`、訂單系統只呼叫一次），並補上新契約的斷言：重放不呼叫 `consume`、記有 `authorization.confirmation.rejected` audit。不得刪除或放寬既有斷言。
  - 既有「interrupt 與 resume 共用 `run-1`」的測試保留（作為「resume 的 run 等於原 run」的情境），新測試另用不同 run 識別。
- [x] **補上不同 run 的測試**（interrupt 與 resume MUST 使用不同的 run 識別，模擬 Agent Server），`shopping_assistant` 與 `mcp_agent`（以 filesystem 的 `write_file` 代表，依第 1 項盤點）各一組，涵蓋：
  - 由新 run 承載的核准只 dispatch 一次；
  - 承載 resume 的 run 等於或不等於原 run，結果相同；
  - 不同 thread 的 resume 回傳 `CONFIRMATION_BINDING_MISMATCH` 且不 consume、不 dispatch；
  - manifest 非 `waiting` 時回傳 `CONFIRMATION_REPLAYED_OR_EXPIRED` 且不 consume、不 dispatch；
  - 重放回傳 `CONFIRMATION_REPLAYED_OR_EXPIRED` typed failure（不是 run 錯誤）；
  - 撤回後、由新 run 承載的核准被拒且不 dispatch（`mcp_agent` 沒有圖內撤回，以審批儲存的 `withdraw` 撤回後再 resume）；
  - 逾期後、由新 run 承載的核准回傳 `CONFIRMATION_TIMEOUT` 且不 dispatch；
  - principal 不在允許清單時被拒；
  - 夾帶的 active-run hint 不影響結果；
  - 核准與每一種拒絕（含節點層）的 audit 都帶 `waitingRunId` 與 `resumeRunId`，且不含 `approvalId`。
  這些測試在實作前應失敗（至少「由新 run 承載的核准」必定回 `CONFIRMATION_BINDING_MISMATCH`），記錄為修改前證據。
  （2026-10-26：情境對照見 `evidence/tr-summary.md` §6；HEAD 上 12 項 Postgres 整合全部失敗，新 run 核准回 `CONFIRMATION_BINDING_MISMATCH`）
- [x] confirmation 節點（design §6.14 第 1 點，第 13 版）：既有 manifest 結構比對不符時維持拋錯；新增的 manifest 非 `waiting` 與 thread 不一致改為 typed failure（`CONFIRMATION_REPLAYED_OR_EXPIRED`／`CONFIRMATION_BINDING_MISMATCH`）並記 audit，不 consume、不 dispatch、不轉移 manifest；檢查在 `interrupt()` 之前；`confirmationOutcome` 沿用 `resolveConfirmationOutcome`。
- [x] `consume` 綁定：移除「execution context 的 runId 等於審批描述的 runId」，改為 `threadId` 相等。SQL 單列 CAS 仍以審批描述的 runId 比對 `run_id`，這是等待中 Run 的資料庫層綁定，MUST NOT 移除或改為比對承載 resume 的 run；approvalId、decisionId、scope、tenant、resource tenant 與允許審批人的檢查不變。`authorization.confirmation.consumed`／`rejected` audit 新增 `waitingRunId` 與 `resumeRunId`，不作 metric label。撤回與天氣澄清 resume 的綁定不變。
- [x] audit 接線（design §6.14 第 3 點，第 13 版）：`createToolAuthorizationGraphNodes` 新增選填 confirmation audit sink（未提供時 no-op）；production 組裝的 `PgAuthorizationConfirmationStore` 與 `mcp_agent`、`shopping_assistant` 的 confirmation 節點注入既有 `auditLogger`；節點層 audit 失敗不改變結果。以測試證明 production 組裝不再是 no-op。（2026-10-26：production 審批儲存以測試證明，修改前失敗；`mcp_agent` 節點的 production 注入只以原始碼與 tsc 核對，沒有執行期測試；`evidence/tr-summary.md` §7）
- [x] 隔離的真實 Postgres 整合測試（需要 Docker，開始前先告知 Master；使用獨立 schema 或資料庫，測試後清除）：以 `PgAuthorizationConfirmationStore`、`PgInterruptManifestRepository` 與 `PostgresSaver` 跑一次「interrupt → 以不同 run 識別 resume → 核准 → dispatch 一次」，並驗證重放與跨 thread 為 typed failure；補上階段性 review m3 的 `mcp_agent` 審批路徑 Postgres 回歸（確認 T7 的 manifest 時間參數修正沒有引入回歸）。（2026-10-26：`confirmation-resume.integration.test.ts` 12 passed，隨機 schema 測試後 DROP；T8 同範圍＋TR 共 11 files、168 passed、0 skipped；另修正撤回 `updatedAt` 序列化缺陷，`evidence/tr-summary.md` §4–§5）
- [x] 回歸：既有 confirmation、撤回、逾期、澄清 resume 測試與 `mcp_agent` tool message snapshot 全數通過。（2026-10-26：回歸 15 files、110 passed；完整測試 1998 passed，只有 2 個既有環境失敗，已在 HEAD 重現；`evidence/tr-summary.md` §4）

驗證命令（整合測試需要 Docker 的 Postgres）：

```bash
cd backend
npm run lint
npm run test
npm run build
SIDE_EFFECT_INTEGRATION_DATABASE_URL=<本機 Postgres> npx vitest run <TR 新增與受影響的 integration test>
```

## TE Graph 入口登記 task、resume 接回原 task，核准後 dispatch 以確定性 stepId 執行（第 14 版 S10；第 15 版 S11）

> 前置：TR。對應以下 Requirement：
> - `durable-hitl-conversation-recovery`「resume 只回到預期 waiting Task 且最多消費一次」（MODIFIED，Scenario「resume 回到預期 Task」：MUST resume 到原 Task、MUST NOT 另建新 Task）
> - `approved-order-operations`「訂單變更只在 durable 人工審批後執行」
>
> 依據 design §6.15 與 §6.16。沿用 `deep_researcher` 的 graph 入口機制（`createGraphEntryContextResolver`、`PgGraphTaskAdmission`），`shopping_assistant` 與 `mcp_agent` 都修正（Master 2026-10-26 決策：mcp_agent 納入，用相同做法）；共用 `physicalDispatch` 以 `createToolCallContext` 的確定性摘要產生 `stepId`，gate 不設定（第 15 版，Master 決策：方案 A，mcp_agent 一併適用）。不新增資料表或 migration，不改 BFF、harness、pipeline、task-step adapter 與 §6.14 的審批綁定。寫入範圍只需 `backend/src/`。
>
> 停止條件：外鍵（`interrupt_manifests.step_id` → `task_steps`）在真實入口路徑下不成立、需要 §6.16 以外的 step 建立點、需要 migration，或需要修改 `backend/src/` 以外的檔案時，停止並回報 Master，不得以預先插入資料、放寬外鍵或另造 task 登記方式處理。

- [x] 實作前唯讀盤點並記入 evidence：(1) shopping 與 `mcp_agent` 審批路徑上 `stepId` 的來源，以及寫入 `interrupt_manifests` 前是否已有對應的 `task_steps`；(2) `createGraphEntryContextResolver` 與 `resolveShoppingExecutionContext`、`resolveMcpExecutionContext` 在開發路徑上的差異；(3) 兩個 graph 的既有測試中預先帶入 `taskId` 或預先插入 `agent_tasks`／`task_steps` 的位置。（2026-10-26，`evidence/te-inventory-and-stop.md`：審批 interrupt 前的寫入在 `stepId` 為空時可成立，外鍵不是問題；但核准後的 dispatch 要求 `stepId`，production 沒有任何地方提供，觸發停止條件，待 Master 決定）
- [x] **先寫失敗測試**（記錄修改前的失敗證據）：不帶 `taskId` 的 trusted header 經 shopping 與 `mcp_agent` 入口時，修改前 MUST 以缺 `taskId` 失敗；修改後 MUST 登記一筆 `graph_execution` task 且 execution context 帶該 taskId。另寫 S11 的失敗測試：context 不帶 `stepId` 時，經 pipeline 核准的 shopping 訂單 tool 修改前 MUST 以 `TOOL_EXECUTION_CONTEXT_UNAVAILABLE` 被拒、訂單 provider 不被呼叫。（2026-10-26，`evidence/te-summary.md` §2：S10 的修改前證據為 live 實測〔shopping 與 `mcp_agent` 入口皆缺 `taskId`〕，新入口測試依賴新 API、在 HEAD 只會載入失敗；S11 以 HEAD 匯出加測試變體重現，核准後訂單 provider 呼叫 0 次）
- [x] `createGraphEntryContextResolver` 新增選填的 context reader 參數，未提供時維持現行判斷；以測試證明 `deep_researcher` 的入口行為不變。（既有 7 項入口測試不變，新增 1 項）
- [x] `shopping_assistant` 入口改用 `createGraphEntryContextResolver(已編譯的 graph, new PgGraphTaskAdmission())`，context reader 沿用 `TOOL_AUTHORIZATION_PROFILE` 的判斷；入口登記失敗時請求 fail-closed。
- [x] shopping state 新增 `executionTaskId`（design §4.2）：由 `route_intent` 每輪開始寫入；不加入輸入 schema；cancel 輸入不覆寫。測試涵蓋：run 輸入夾帶 `executionTaskId` 不影響 state、cancel 不覆寫。
- [x] resume 測試：由新 run 承載的 resume 取得與等待中相同的 taskId；thread、principal、tenant 或 scope 不一致時拒絕；checkpoint 缺 `executionTaskId` 時 fail-closed；`TOOL_AUTHORIZATION_PROFILE=development` 的行為與修改前相同。（2026-10-26：新 run 接回原 task、不同 principal 被拒、開發路徑以 shopping 與 `mcp_agent` 測試證明；thread 與 scope 不一致由既有 `graph-task-admission.test.ts` 涵蓋，thread 另在真實 Postgres 上觸發；tenant 不一致由 `PgGraphTaskAdmission` 的綁定比對處理，沒有獨立測試；缺 `executionTaskId` 由既有 `graph-entry.test.ts` 涵蓋，未另寫 graph 專屬案例；`evidence/te-summary.md` §3、§6）
- [x] `mcp_agent`（design §6.15 第 6 點）：入口改用 `createGraphEntryContextResolver(已編譯的 graph, new PgGraphTaskAdmission())`，context reader 沿用 `resolveMcpExecutionContext` 的判斷；state 新增 `executionTaskId`，由 `call_model` 寫入。測試涵蓋：新輸入登記 task、run 輸入夾帶的 `executionTaskId` 在進入審批前被覆寫、由新 run 承載的 resume 接回原 task、跨 thread 或不同 principal 的 resume 被拒、開發路徑行為不變。
- [x] 確定性 `stepId`（design §6.16）：`tool-call-context.ts` 新增輔助函式，以與 `createToolCallContext` 相同的 `createRawInputReference` 摘要 `{ taskId, nodeName: "physical_dispatch", toolName, toolCallId, input }` 產生 `step-<digest>`；`createToolCallContext` 本身不修改。共用 `physicalDispatch` 在 dispatch 前寫入此 `stepId`，`toolCallId` 維持 `call.toolCallId`；gate 不設定 `stepId`；context 缺 taskId 時 fail-closed，不產生隨機識別。測試涵蓋：同一 task／tool call／輸入得到相同 `stepId`；輸入相同但 `toolCallId` 不同得到不同 `stepId`；`toolCallId` 不被覆寫；審批紀錄與 manifest 的 `step_id` 為 null；`createToolCallContext` 與 `deep_researcher` 既有測試不變。
- [x] 隔離的真實 Postgres 整合測試（使用獨立 schema，測試後清除）：以 `PgGraphTaskAdmission`、`PostgresSaver`、`PgAuthorizationConfirmationStore` 與 `PgInterruptManifestRepository` 跑「入口登記 → 審批 interrupt → 新 run 承載 resume → dispatch 一次」，`shopping_assistant` 與 `mcp_agent`（以 filesystem 的 `write_file` 代表）各一組，**不預先插入** `agent_tasks`／`task_steps`、context **不帶** `stepId`，同時驗證 manifest 外鍵與 taskId 一致。shopping 經真實 pipeline 與 task-step adapter：dispatch 時建立對應 `task_steps`、訂單 provider 只被呼叫一次、重放不再 dispatch。`mcp_agent` 在 `TOOL_DISPATCH_PIPELINE_MCP_ENABLED` 開啟與關閉兩種情況下，核准後都 dispatch 一次。（2026-10-26，`graph-entry.integration.test.ts` 3 passed；shopping 走 production `loadShoppingAssistantToolRuntime`；step lock 以 `REDIS_URI=""` 使用 `NoopStepLock`，Redis lock 未驗證；`evidence/te-summary.md` §3、§6）
- [x] 回歸：TR 的測試與整合測試、既有 shopping、`mcp_agent`、confirmation、撤回、逾期、澄清 resume、dispatch pipeline、`createToolCallContext` 與 `deep_researcher` 入口測試全數通過；lint、test、build 通過。（2026-10-26：lint、build 通過；整合與回歸 38 files、359 passed、0 skipped；完整測試 2009 passed，只有 2 個既有環境失敗；並行執行時曾出現的計時逾時在單獨重跑時通過，`evidence/te-summary.md` §4）
- [x] live 確認：重建 image 後，經 BFF 對 `mcp_agent` 送出一次請求，確認不再於入口失敗（對照 `evidence/s10-mcp-agent-probe.json`）；shopping 的 live 驗證由 T9 第 2 項執行。記錄為 live，與 deterministic 分開。（2026-10-26T12:15Z，live：`call_model` 執行、寫入 `executionTaskId`、無 error；`mcp_agent` 的審批路徑未 live 執行，因 filesystem MCP 在容器內未載入；`evidence/t9-live-summary.md` §2）

驗證命令（整合測試需要 Docker 的 Postgres）：

```bash
cd backend
npm run lint
npm run test
npm run build
SIDE_EFFECT_INTEGRATION_DATABASE_URL=<本機 Postgres> npx vitest run <TE 新增與受影響的 integration test>
```

## T9 BFF 透傳證明（先證明，再宣稱無變更）

> 前置：T0、T1；第 2 項另需 TR 與 TE（第 14 版 S10、第 15 版 S11）。T6 的前端串接與 T10 依賴本 Task 結論。對應 design §12、§6.14、§6.15、§6.16。
>
> 停止條件：傳輸證明失敗，或需要 TS 以外的 bff 正式程式碼或 `package.json` 修改時，停止並回報 CCR，退回 PLAN_DRAFT 補 BFF delta，不得直接修改。審批綁定屬 backend，由 TR 處理（第 12 版，S9）。

- [x] 在 bff 既有測試目錄新增測試檔（以既有 vitest／node test 入口執行；BFF 正式程式只有 TS 的變更），證明 BFF 的傳輸行為：tool 審批 resume 與 `cancel` 輸入的本文及 active-run header 原樣送到原 thread；`shopping_assistant` 串流透傳，含 backend 新增的 `card.emit` 事件原樣到達前端；client 注入的身分 header 被 strip；取消與斷線透傳不變。（2026-10-25，`bff/test/shopping-passthrough.test.mjs`，commit `9154377`；`evidence/t9-summary.md`）
- [x] TR 全部完成後（第 13 版，Master 指示：在隔離 Postgres integration 之後最後執行），經 BFF 與真實 Agent Server（含 Postgres 的審批儲存與 checkpointer）執行一次審批 resume smoke：核准由新 run 承載、通過綁定，且訂單系統只被呼叫一次；同時確認 update chunk 帶有 `runtimeEvents`（design §8.1）。記錄為 live／integration，與 deterministic 分開。需要 Docker。（2026-10-26T12:16Z，live：resume run 與第一次的 run 不同、審批 `approved` 且綁定第一次的 run、business effect `committed` 對應 1 筆執行、`task_steps` 以確定性 `stepId` 為 `succeeded`、兩次 update 都帶 `card.emit`；audit 因 `AUDIT_BACKEND` 預設 `console` 寫在 console 而非資料庫；`evidence/t9-live-summary.md`）
  - 前置（2026-10-26，Master 擴大 writeScope 至 `Dockerfile`）：手寫 Dockerfile 與 `backend/langgraph.json` 不一致，修正後才能執行 smoke：(1) `LANGSERVE_GRAPHS` 缺 `shopping_assistant`；(2) 缺 `LANGGRAPH_HTTP`，`configurable_headers` 未生效，BFF 的身分與 active-run header 不會進入 graph config；(3) frontend build stage 未複製 `contracts/`，型別檢查的測試檔找不到 fixture，image 無法 build。三者都依 `langgraph.json` 補齊，並以腳本比對一致；Master 重建 image 後已確認 `shopping_assistant` 載入、`LANGGRAPH_HTTP` 生效（2026-10-26）。graph 清單與 http 設定目前仍在 Dockerfile 與 `langgraph.json` 各寫一次，改為由 `langgraph.json` 產生列為後續建議。
  - 第一次執行（2026-10-26T10:46Z）：未到審批即在 graph 入口以缺 `taskId` 失敗（S10，`evidence/t9-live-smoke-stop.md`），由 TE 修正後重新執行。
- [x] 以 Git Diff 確認 bff 正式程式只有 TS 的變更，其餘為新增測試檔。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T10 Frontend：卡片、審批與狀態

> 前置：T0、T6、TR、T9。對應 `order-operation-status-surface` 全部 Requirement。

- [x] agent 清單新增 `shopping_assistant`（`showActivityTimeline: true`，design §8.1、§11）；`OrderOperationState` Transport Enum 與 card payload 以 runtime validation 解析；卡片從既有事件處理路徑取得 payload，不另建傳輸。
- [x] `ProductResultCard`、`OperationApprovalCard`（核准／拒絕經 resume 並帶原 run 識別；取消申請經既有 `cancel` 輸入；顯示 server 提供的期限；送出期間防重複；resume 失敗顯示 typed 錯誤）、`OperationStatusCard`（全部狀態的繁中標籤與說明；標註 mock）。
- [x] 狀態 reducer 以 `(operationRef.toolCallId, stateVersion)` 單調前進；terminal 後忽略非 terminal；未知 card、未知 schema 版本、未知狀態值安全降級且不中斷串流。
- [x] 期限已過但未收到 server 逾期事件時只顯示提示，不改變狀態。
- [x] 測試：全部狀態可區分；requested／approved 不顯示為已確認；亂序與重複事件；連續點擊只送一次；重新載入後等待審批仍可操作；期限已過不自行改為逾期；confirmed 與 executing 卡片無撤銷、復原或取消控制項；未知 card 降級。

> 2026-10-26 實作紀錄（`evidence/t10-summary.md`）：第 1、3、4 項完成並驗證（frontend lint／test／build 通過）。第 2 項依 Master 2026-10-26 裁定勾選：前端已知 active-run hint 時才帶、未知不帶，最終結果以服務端為更高優先的事實來源（審批綁定依 design §6.14 由伺服器端等待中 run 決定；卡片狀態只依後端事件與 thread state）；design §11 的文字待協調者同步。第 5 項依 Master 2026-10-26 裁定勾選：「重新載入後等待審批仍可操作」的驗收範圍為「同一 thread 從 server 狀態重建」（已測試）；瀏覽器重新整理回到原對話依賴待辦 A（server 端 thread 擁有者檢查）＋B（前端 `/chat/<threadId>` 路由），另行處理。

驗證命令：

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## TB1 鏈路評測案例（D3，Lane B）

> 前置：T0 的 evaluation case 契約 minor 版本欄位定案。對應 `retrieval-evaluation` ADDED Requirement。

- [ ] 約 15 題：商品查詢、政策問答（含拒答）、退款與取消、多輪（商品 → 政策 → 退款）、審批拒絕、審批逾期、生效前取消、並行重複提交、提交後回應遺失、注入聲稱已預先核准。
- [ ] 新預期結果種類（每輪預期意圖、預期操作 terminal 狀態）以 evaluation case 契約的 additive minor 版本表達；舊載入器 typed failure 拒絕。
- [ ] 每題帶合成 provenance 與資料分級；dev／test split 固定並版本化。

驗證：由 T11 的 schema 驗證與題型分布檢查覆蓋。

## T11 鏈路評測執行（D4，Lane B）

> 前置：T5、T7、T10、TB1。對應 `retrieval-evaluation` ADDED Requirement。

- [ ] 評測 harness 以測試 principal 經 resume 送出人工審批決定，不由受測模型產生。
- [ ] 輸出路由準確率與混淆矩陣、操作 terminal 狀態正確率、引用與拒答指標；誤分流計為失敗。
- [ ] 在鏈路設定上執行完整資料集（X42 40 題 + 鏈路案例），記錄 dataset 版本、模型識別、prompt 版本、門檻版本、執行次數、日期與合成資料聲明。
- [ ] deterministic 與 live 分開回報；未完成的執行標記 incomplete。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
npm run eval:opik
```

## T12 條件任務：knowledge migration 交易化（承接 X42 Minor）

> 前置：無。只有在本 Change 任一 Task 新增 knowledge store migration 時才執行；預設設計（design §10、§13 Q3）不新增 knowledge migration。

- [ ] 若需要新增 knowledge migration：先將 knowledge migration runner 的每個 migration（up 內容與 ledger 寫入）包在同一交易中，並以測試證明 migration 中途失敗時不留下部分 schema 且 ledger 無紀錄。
- [ ] 若未新增：在完成回報中註明「未觸發，X42 Minor 維持承接」。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T13 完整回歸與完成回報

> 前置：TH、TS、TR、T1–T11（含 T2a、T2b）、TB1、T12（若觸發）。

- [ ] backend、frontend 全部驗證命令通過；bff build 與 test 通過；以 Git Diff 確認無無關修改。
- [ ] Non-Waivable Invariants 1、2、5、6、8、9、10、11 逐條附證據；repository-wide 檢查應用程式碼無模型名稱條件判斷。
- [ ] README／對外描述遵守 v7 External Description Boundary（合成語料、mock 訂單 tool、無 OS sandbox、數字僅示範方法效果、未滿足 X41）。
- [ ] 依 `AGENTS.md` §14 產出完成回報與 `artifacts/implementation-result.json`，列出未執行的 live 驗證與 Retrofit Debt（design §14）。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
cd ../frontend
npm run lint
npm run test
npm run build
cd ../bff
npm run build
npm run test
```
