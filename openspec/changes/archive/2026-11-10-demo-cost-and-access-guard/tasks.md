## 0. 前置 Gate（實作前必須完成）

- [x] 0.1 Master 定案 design.md 的 Open Decisions N-1、N-2、N-3（2026-11-02 已定案並寫回 design「Master 決策紀錄（2026-11-02）」與受影響 Scenario）。驗證：design 不再有未定案決策點；`openspec validate demo-cost-and-access-guard --strict` 通過。
- [x] 0.2 Qwen 完成 review-plan（review-result-review-plan-004：evidenceGate 通過、COMMENT_ONLY、0 Blocker、0 Major，4 Minor 已由 CCR 仲裁修進），Blocker 清零、Major 已處理或有接受理由。驗證：review_result 已保存並由 CCR 更新 CurrentState。
- 0.3 已依 Master 決策 M-5（2026-11-02）改為部署前 Gate，並依 Master 決策 M-6（2026-11-04）移到獨立的部署前 Change；本 Change 的程式碼不依賴實際單價。

## 1. 通用層：client IP 解析（bff）

- [x] 1.1 新增信任代理設定與啟動驗證（合法位址／CIDR、trim／去空值／去重、拒絕全開值）。對應 Requirement：「信任代理設定在啟動時驗證」。驗證：全開清單、格式錯誤、預設空清單測試；`cd bff && npm run build` 與 BFF 測試入口通過。
- [x] 1.2 實作 client IP 解析並讓限流、審計、轉發共用同一結果。對應 Requirement：「只在對端為信任代理時採用轉發的 client IP」「限流、審計與轉發共用同一個 client IP 解析結果」。驗證：偽造標頭、信任代理轉發、多層代理、格式錯誤、全部為信任代理（取最左邊、不回退對端、審計標示）、三處一致、非 demo 限流鍵不變測試。

## 2. 通用層：模型用量與成本帳本（backend）

- [x] 2.1 單價表設定、驗證與整數金額換算；帳本幣別由單價表推得，讀取介面回報帳本幣別，不換匯。對應 Requirement：「以設定的單價表換算帳單幣別金額」。驗證：缺單價入帳 `unpriced`、格式錯誤拒絕啟動、混用幣別拒絕啟動、讀取介面回報帳本幣別、整數累加精確測試。單元測試的單價使用測試 fixture，不依賴部署前 Change 的單價核實結果。
- [x] 2.2 `UsageLedgerStore` 介面、記憶體預設實作與 Redis 實作（時區日期分區、TTL、BFF 唯讀介面）。對應 Requirement：「帳本儲存介面與日期分區」。驗證：未設定共用儲存不連線、跨日重置、BFF 讀取一致測試。
- [x] 2.3 LLM Gateway 逐次入帳（fallback、重試、結構化輸出修復每次嘗試、串流），並修正修復路徑只保留最後一次用量。對應 Requirement：「每一次 provider 呼叫都在 provider 出口入帳」。新增 backend 本地 `UsageAttribution` 型別、「已註冊 graph ID」封閉常數集合（`SHOPPING_ASSISTANT_GRAPH_ID` 改為引用它）、歸因包裝（套在 5 個已註冊 graph export 的最外層，不依賴既有包裝與 Opik 名稱；移除用戶端同名 key 後寫入 trusted key）與單一 reader；`ChatModelInvokeOptions` 新增可選 `attribution` 並在 fallback／修復／串流 invoker 鏈原樣傳遞；5 個已註冊 graph 中所有可達的 Gateway 呼叫點（含 helper function，至少 `chatbot` 的 `chat_response` 與 `deep_researcher` 的 5 處 `llm.invoke(prompt)`）傳入 attribution，完整清單寫入 implementation_result；不修改 `deep_researcher` 的 Opik 名稱；不修改共用 `ExecutionContext` 契約；`ModelPurpose` → `callKind` 對應集中於單一函式。驗證：一般呼叫、vision 用途記 `vision`、其餘用途記 `chat`、run 內呼叫（含 fallback 與修復）全部帶正確 graphId 且無 `unattributed`、用戶端偽造歸因被覆蓋、`langgraph.json` 每個 graph 都有歸因包裝且 ID 一致、常數集合與 `langgraph.json` 一致、`deep_researcher` 入帳為 `deep_researcher` 而非 `weather`、5 個 graph 各一個 fake provider run 測試且全部入帳無 `unattributed`、修復 C1+C2、Graph 可見 `usage_metadata` 維持最後一次、修復耗盡、fallback、串流不重複、取消後仍入帳、缺 execution context 測試；既有 Opik tracing 與指標測試不放寬。
- [x] 2.4 knowledge model gateway（embedding、rerank）入帳；`KnowledgeCallOptions` 新增可選 `attribution`，與既有 `context` 分開。對應同上 Requirement。驗證：`callKind` 分別入帳、run 內 knowledge 呼叫帶正確 graphId 測試；既有 knowledge 測試通過。
- [x] 2.5 缺用量與寫入失敗語意。對應 Requirement：「provider 未回報用量時不得以 0 入帳」「帳本寫入失敗不影響模型回應」。驗證：有／無估算值、寫入錯誤、寫入逾時不延遲回應交付、失敗計數、逾時設定超出範圍測試；`cd backend && npm run lint && npm run test && npm run build`。

## 3. 通用層：run 准入介面、錯誤碼與 frontend 降級（bff + frontend）

- [x] 3.1 BFF 集中定義五個准入錯誤碼與 HTTP 語意；准入政策介面與預設 `AllowAll`；限流 subject 介面與預設 principal 實作。對應 Requirement：「預設准入政策不設上限且不改變既有行為」「准入拒絕使用通用穩定錯誤碼」。驗證：非 demo 部署不讀帳本、未定義錯誤碼安全降級測試。
- [x] 3.2 全部建立 run 的路徑（單一 run、stream、wait、batch、crons、resume）在轉發前呼叫政策；讀取請求不呼叫；准入檢查期間取消時釋放 lease（轉發後的釋放見 3.5）；准入輸入包含 run 生命週期參數（`on_disconnect`、`after_seconds`、`stream_resumable`，不存在與無法判定分開標示）。對應 Requirement：「BFF 在建立 run 前呼叫准入政策」。驗證：放行、拒絕、全路徑、讀取不受影響、限流先於准入、准入拒絕不退限流額度、取消測試，並斷言上游未收到被拒請求。
- [x] 3.3 帳本讀取器與 fail-closed；啟用金額上限時的啟動驗證（共用儲存、全部啟用模型有單價）。對應 Requirement：「預算檢查讀取帳本失敗時 fail-closed」。驗證：不可用、逾時、啟用上限但缺單價測試。
- [x] 3.4 frontend 依五個錯誤碼與未知錯誤碼渲染降級狀態，深度研究範圍耗盡只停用深度研究。對應 Requirement：「frontend 依錯誤碼呈現准入降級狀態」。驗證：預算耗盡保留輸入、只有深度研究耗盡、並行受限不自動重送、未知錯誤碼元件測試；`cd frontend && npm run lint && npm run test && npm run build`。
- [x] 3.5 持有 lease 的請求生命週期（通用層，Master 決策 N-4）：先依本專案的 LangGraph server 版本查證 run 識別的來源（stream 與 wait 路徑各自）與 run cancel／terminal 確認 API，以及 cancel 的 action 與 `on_disconnect: "cancel"` 相同，結果寫入 evidence；查不到可用 API 時停止並依 onFailure 回到 plan-change，不得猜測 URL。再實作：從准入時點起算、涵蓋所有上游位址嘗試與 headers 前後的絕對期限；正常完成與上游 4xx 時立即釋放；異常結束時中止上游、發出 run cancel、確認後才釋放；取不到識別、cancel 失敗或未確認時由 TTL 回收並記錄審計事件；不持有 lease 的請求維持既有逾時與取消行為。對應 Requirement：「持有 lease 的請求以絕對期限與終止確認管理 lease」。驗證：headers 晚到、多上游位址共用期限、正常完成不發 cancel、上游 4xx、斷線且確認、cancel 失敗、無 run 識別、確認逾時、lease 只釋放一次、不持有 lease 的請求逾時行為不變測試；以假時鐘或可控上游驗證期限，不以固定延遲作為證據。

## 4. 層間依賴邊界

- [x] 4.1 新增自動化邊界測試：通用層模組的 import 圖不得指向 demo 模組、通用層不得讀取 demo 開關（bff 與 backend 各一）。對應 Requirement：「Demo 設定層只能單向依賴通用層」。驗證：測試在故意加入違規 import 時失敗、移除後通過（記錄兩次結果）。
- [x] 4.2 以測試用假政策與假 subject resolver 取代 demo 實作，證明通用層可替換。對應同上 Requirement。驗證：通用層與 BFF 准入測試通過且通用層無修改。

## 5. Demo 設定層（bff + backend）

- [x] 5.1 demo 開關與組裝點條件注入（BFF、backend 相同語意）。對應 Requirement：「demo 模式以單一開關啟用全部 demo 政策」。驗證：開啟即全部啟用、關閉即通用層預設測試。
- [x] 5.2 BFF 與 backend 的 demo 嚴格啟動檢查與 ready 檢查（含時區／鍵前綴一致性、單價表完整性、Gun Shop 思考模式）。對應 Requirement：「demo 模式缺少必要設定時拒絕啟動」。驗證：缺共用儲存、Origin 不安全、信任代理 key 不存在被拒與 key 存在但值為空被接受、數值不合法、lease 寬限短於 30 秒、長於 120 秒與恰為邊界值、分入口總和超過全站、缺核實單價、思考模式未關、secret 不外洩、連線逾時、時區不一致、上限幣別與帳本幣別不一致測試。
- [x] 5.3 匿名訪客 session cookie 與 session 限流鍵。對應 Requirement：「demo 模式以匿名訪客 session 作為限流 user 維度」。驗證：首次造訪（`SameSite=Strict` 且不可由設定改變）、同站後續請求帶回 cookie、跨站時每次重新簽發且 IP 維度仍生效、竄改或過期重新簽發、兩訪客互不影響、丟棄 cookie 受 IP 限制、限流儲存不可用 fail-open 測試。
- [x] 5.4 demo 准入政策：全站與分入口上限、深度研究每 IP 配額、並行 lease（只發給 stream、wait 與 resume 串流路徑）、預留範圍只計入全站總額。對應 Requirement：「demo 准入政策套用全站與分入口每日上限」。驗證：全站用完、只有深度研究用完、預留範圍超額不擋任何 graph、IP 配額、並行上限、斷線的 run 在確認前不讓出名額、長時間 run（含 headers 晚到）期間 lease 不過期、BFF 當機後 TTL 回收、lease 釋放一次、帳本不可用測試。lease 釋放沿用 3.5 的通用層行為，demo 不另寫釋放邏輯。
- [x] 5.5 crons、未開放 graph、run 生命週期參數與審批 resume（Master 決策 N-5）。對應 Requirement：「demo 模式關閉非開放功能並放行審批 resume」。驗證：crons 被拒、`math_agent`／`mcp_agent` 被拒、背景單一 run 與 batch 被拒且不取得 lease、以背景路徑提交的 resume 被拒、`on_disconnect` 為 `continue` 或不存在被拒且不取得 lease、帶 `after_seconds` 或 `stream_resumable: true` 被拒、body 無法解析不放行、BFF 未改寫 request body、frontend 實際送出的請求（`on_disconnect: "cancel"`）照常、stream 與 wait 照常、預算耗盡時 resume 放行且 terminal state 與非 demo 一致、resume 用量入帳測試。
- [x] 5.6 非 demo 回歸：既有限流、CORS、認證、Route 與錯誤碼行為不變（client IP 依 1.x 的已接受改變除外）。驗證：既有 BFF、backend、frontend 測試全數通過，未刪除或放寬既有 Assertion。

## 6. 整合驗證與部署交付

- [x] 6.1 本機以 demo 模式啟動 BFF + backend + Redis，走完：首次造訪取得 session → Gun Chat 對話 → 帳本入帳可查 → 調低深度研究上限至耗盡，只停用深度研究 → 調低全站上限至耗盡，收到 `usage_budget_exhausted` → 建立 cron 與呼叫 `math_agent` 被拒 → 以 `on_disconnect: "continue"` 建立 run 被拒 → 啟動一次深度研究後中途斷開用戶端，確認 BFF 發出 run cancel、backend 的 run 在寬限內進入 terminal、之後才釋放 lease → 停止 Redis 收到 `usage_budget_unavailable`。驗證：記錄實際命令與輸出（含斷線後 run 的 terminal 狀態與時間）；不得以 mock 取代此項。
- [x] 6.2 撰寫部署設定說明：必要設定清單、不安全值、信任代理設定方式（含非 demo 部署的 IP 行為改變）、frontend 與 BFF 必須同站的部署前提（含 Public Suffix List 平台網域的注意事項）、demo 不開放背景 run 與 batch、demo 只接受 `on_disconnect: "cancel"` 且拒絕 `after_seconds` 與可恢復串流、cancel 未確認時並行容量暫時下降、單價表格式與核實來源、最壞超支估算公式（並行 3 × 單一 run 最大成本 + 放行 resume）。驗證：Master 審閱，供 D5 cost acceptance 使用。
- [x] 6.3 跨套件完整驗證：`cd frontend && npm run lint && npm run test && npm run build`；`cd bff && npm run build` 與 BFF 測試入口；`cd backend && npm run lint && npm run test && npm run build`。如實記錄未執行項目。
- 6.4 原為部署前 Gate（原 0.3）：正式單價核實、E3 成本量測與 qwen3.5-flash 切換。依 Master 決策 M-6（2026-11-04）移到獨立的部署前 OpenSpec Change，不再是本 Change 的 task；該 Change 完成前仍不得部署 demo。

## 7. 前置依賴（Master 決策 M-7，2026-11-04）

- 2.5、5.6、6.3 的驗證要求 backend 完整測試全數通過，目前受 3 個既有基準失敗阻擋（Opik live smoke、PostgreSQL 連線、tool-dispatch 錯誤碼；均已在不含本 Change 的基準重現）。依 Master 決策 M-7，這三個失敗另開 Change 修正或在具備環境時重跑；該 Change 完成後，再由實作者重跑 2.5、5.6、6.3 並勾選。本 Change 不放寬上述驗證條件。

## handoff-apply-change-003 實作驗證紀錄

- Codex 已完成並驗證本輪勾選項目；完整追溯與命令輸出見 implementation-result-apply-change-003 及其 evidence。
- 2.5、5.6、6.3 保留未勾選：backend 完整測試 2280 passed、3 failed、115 skipped；三個失敗均已在不含本 Change 的 HEAD 基準重現。PostgreSQL 案例改連隔離測試資料庫後通過，Opik 與 tool-dispatch 既有失敗尚待處理。未刪除或放寬既有 Assertion。
- 6.1 已以真實 BFF、LangGraph server 1.4.5、Redis、隔離 PostgreSQL 及 Edge headless 驗證。斷線時 run 先進入 interrupted，lease 仍保留，取得確認後才釋放，約 628 毫秒；未以 mock 代替。單價全部為 fixture。
- 6.2 的部署說明已新增於 docs/demo-cost-and-access-guard.md；Master 已於 2026-11-11 審閱通過，勾選 6.2。
- 6.4 為範圍外部署前 Gate，未核實正式單價或執行正式成本驗收，不得據此部署（2026-11-04 起移到獨立部署前 Change，見 Master 決策 M-6）。
