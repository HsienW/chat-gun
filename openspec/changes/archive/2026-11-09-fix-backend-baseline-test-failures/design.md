## Master 決策（2026-11-07）

- **D1 = D1-B**：PostgreSQL integration 改用專用 opt-in（`RUN_PG_INTEGRATION=true` + `TEST_DATABASE_URL`）。
- **D2 = D2-A**：Opik live 失敗在本 Change 內先診斷，診斷前不改程式。
- **D3 = D3-A**：完整完成判準（預設環境＋本機 `.env` 原樣＋PG opt-in 實跑＋Opik 依 D2）。

## Master 決策（2026-11-09）

- **D4 = 併入本 Change**：Task 3.1 診斷判定 F2 為 evaluation 程式缺陷（見「失敗 F2」）。修正併入本 Change，本 Change 因此擴大到修改 production 程式 `backend/src/evaluation/opik/experiment.ts`，並重新 review-plan。D3-A 完成判準不變。

- **D5 = x-bff-* trusted identity 管道**（2026-11-09，Task 3.3 第 1 次 live 重跑失敗後）：D4 由 evaluation 直接傳 `execution_context` 的做法被 graph 入口依設計丟棄。改由 evaluation 以 in-process 方式提供入口在 production 模式接受的 `x-bff-*` trusted identity 與 correlation 欄位（見「失敗 F2」的「修正（D5）」）。

以下各節保留原始選項以便追溯；施工以本節決策為準。

## Context

基準證據（由 `demo-cost-and-access-guard` 的 Codex 於 2026-11-02 產生，HEAD `f5b81633`，以 `git archive HEAD` 隔離 snapshot 與目前 working tree 各跑一次，結果相同）：

```text
Test Files  3 failed (3)
Tests  3 failed | 40 skipped (43)
FAIL experiment.live-smoke > hosted Opik evaluation > runs two versioned experiments with different agent models
  AssertionError: expected [] to have a length of 1 but got +0
FAIL tool-dispatch/pipeline > RuntimeToolDispatchPipeline > fails closed when a mandatory dependency is unavailable
  - "errorCode": "TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE"
  + "errorCode": "TASK_STEP_UNAVAILABLE"
FAIL runtime/__tests__/integration > runtime PostgreSQL integration > persists task, step, and event records when DATABASE_URL is configured
  Error: connect ECONNREFUSED 127.0.0.1:5433
```

兩次執行都繼承同一份經 dotenv 載入的 backend 本機環境（值未保存）。

### 環境載入事實

- backend 的 `platform/env` 模組以 `dotenv/config` 載入 `backend/.env`；測試間接 import 它時，本機 `.env` 的值會進入 `process.env`。dotenv 不覆寫已存在的變數（包括空字串）。
- 現有 CI（`backend-ci.yml`、`harness-registry-integration.yml`、`harness-candidate-integration.yml`）在 job env 固定 `DATABASE_URL: ''` 與 `RUN_OPIK_EVALUATION: 'false'`。因此 CI 上三個案例都不會以失敗形態出現：F1 因為沒有 pool 而走預期路徑，F2 與 F3 都被 skip。失敗只在開發者本機 `.env` 設定這些值時發生。

## 失敗 F1：dispatch dependency 測試（層級：測試隔離，非程式）

### 定位

- `createRuntimeToolDispatchPipeline` 經 `withProductionDefaults` 補 production default：`pool` 為 `undefined` 時呼叫 `getPool()`。`getPool()` 在 `DATABASE_URL` 已設定時建立真實 `pg.Pool`（只是 lazy，尚未連線），未設定時回 `null`。
- 有 pool 時，`taskStepAdapter` 未提供會預設為 `PgToolDispatchTaskStepAdapter`。
- 測試傳入 `taskStepAdapter: undefined`，但**沒有**傳 `pool: null`。同檔另一個測試已用 `pool: null` 隔離，可見本測試是漏寫。
- 結果：
  - 本機 `DATABASE_URL` 指向不可達的 5433 → mandatory dependency 全數「已提供」→ 通過 `hasMandatoryDependencies` → 取 step lock → `taskStepAdapter.start()` 連線失敗 → `TASK_STEP_UNAVAILABLE`（`rejected_before_dispatch`，未 dispatch）。
  - 未設定 `DATABASE_URL` → `taskStepAdapter` 仍為 `undefined` → `TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE`（`rejected_before_dispatch`，未 dispatch）。

### 判定

程式行為符合主規格「mandatory dependency 於 dispatch 前 unavailable MUST fail-closed」：兩條路徑都 fail-closed，也都不 dispatch。錯的是測試前提：它想驗證「dependency 未提供」，實際上卻依賴本機環境。

### 修正

- 測試以明確 `pool: null` 隔離 production default，讓「未提供」前提與環境無關。Assertion（errorCode、`runnerExecute` 未被呼叫）**不變**。
- 新增獨立測試，覆蓋「Task-Step adapter 已提供但 `start` 失敗」：以注入的 adapter（`start` reject）斷言 `rejected_before_dispatch` + `TASK_STEP_UNAVAILABLE`，且 runner 未被呼叫。不依賴真實 PostgreSQL。
- 規格：在 `unified-tool-dispatch-pipeline` 補兩個 Scenario，把兩條路徑的錯誤碼語意寫成契約（行為不變）。

### 替代方案（不採用）

- 把 Assertion 改成 `TASK_STEP_UNAVAILABLE`：會讓測試結果隨環境改變，而且等於放寬 Assertion。拒絕。
- 在 `hasMandatoryDependencies` 前預先 ping DB：會改變 production 行為並增加延遲，超出本 Change 範圍。拒絕。
- 在 vitest 全域 setup 清掉 `DATABASE_URL`：影響面太大，會讓 F3 永遠 skip，也掩蓋 opt-in 語意。拒絕。

## 失敗 F3：PostgreSQL integration（層級：測試 gating）

### 定位

gate 為 `describe.skipIf(!process.env.DATABASE_URL)`。`DATABASE_URL` 同時是**應用程式 runtime 設定**，開發者為了執行應用程式而設定它，並不代表要跑 integration 測試。所以本機預設 `npm run test` 會在 PostgreSQL 沒啟動時嘗試連線，然後失敗。在隔離 PostgreSQL 下可通過（M-7 前提）。

### 待 Master 決策 D1

- **D1-A（不改程式）**：保留現有 gate。把「預設環境」定義為與 CI 相同的 `DATABASE_URL=''`、`RUN_OPIK_EVALUATION=false`，完成判準的預設命令在這個環境下執行。PostgreSQL integration 另以 `DATABASE_URL=<隔離 PG>` 執行一次並保存證據。
  - 優點：零程式修改，與 CI 一致。
  - 缺點：開發者本機直接跑 `npm run test` 仍會失敗（gate 仍與 runtime 設定耦合），F1 類問題會在其他測試再出現。
- **D1-B（推薦）**：改成專用 opt-in。`RUN_PG_INTEGRATION=true` 才執行，連線字串讀測試專用 `TEST_DATABASE_URL`，不沿用 runtime `DATABASE_URL`。啟用但缺少 `TEST_DATABASE_URL` 或連線失敗時 MUST fail（不得 skip）。未啟用時 skip，並在驗證報告列出。
  - 優點：預設測試真正 hermetic；opt-in 語意與 Opik 一致。
  - 缺點：需改測試 gate，連線字串要經由測試注入，不能經由 runtime 的 `getPool()` 單例；需要小幅調整測試取得 pool 的方式。
  - 變數說明寫在測試檔頭註解與本 design。`backend/.env.example` 目前被其他 Change 修改、尚未提交，本 Change 不修改它，等其提交後另以後續任務補上。

## 失敗 F2：hosted Opik live smoke（層級：Evaluation harness 呼叫 Graph 的 Input 契約，程式缺陷）

### 診斷結果（Task 3.1，2026-11-09）

證據：`.agent-runtime/fix-backend-baseline-test-failures/evidence/task-3.1-opik-diagnosis.json`。

- 以 `RUN_OPIK_EVALUATION=true` 執行，兩個 agent model 的 hosted experiment 都建立成功（`hostedStatus` 為 `SUCCEEDED`），但都是第 1 個 item `FAILED`、其餘 23 個 `SKIPPED`，0 個 `COMPLETED`。
- 錯誤類別為 `ZodError`，缺少的欄位是 `requestId`、`principal`、`scope`。兩個模型結果相同，與模型、Provider、配額或網路無關。
- 根因（Task 3.3 第 1 次 live 重跑後修正）：`deepResearcherGraph` 由 `instrumentGraphWithExecutionContext` 包裝，入口 context 由 `createGraphEntryContextResolver`（`runtime/execution-context/graph-entry.ts`，HEAD commit `af14464` 起）產生。入口 resolver：
  - 以 `ENTRY_OWNED_KEYS` **刻意移除**呼叫端提供的 `execution_context`、`task_id`、`step_id` 等欄位，不接受呼叫端自帶的 canonical context。
  - 在 production 模式以 `readExecutionContext` 重建 context：correlation 讀 `configurable` 的 `request_id`、`thread_id`、`run_id`；principal 與 scope **只**從 `x-bff-*` trusted identity 欄位解析；`taskId` 由 `GraphTaskAdmission` 指派。
  - `experiment.ts` 的 `runDefaultAgent` 沒有提供 `request_id` 與任何 `x-bff-*` 欄位，因此每個 item 在入口就以 ZodError（requestId、principal、scope）失敗。
- 這個入口行為在 HEAD 已存在，不是工作目錄中其他未提交修改造成。

### 第一次修正（D4）失敗紀錄

- D4 讓 `runDefaultAgent` 直接傳 `configurable.execution_context`。入口 resolver 依設計丟棄該欄位，第 1 次 live 重跑結果與修正前完全相同（證據：`evidence/task-3.3-opik-live-attempt-1.json`）。
- 單元測試以 `vi.mock` 取代整個 deep-researcher 模組，沒有經過真實入口 resolver，因此未能發現。這是測試設計缺口：**驗證 graph 入口契約的測試 MUST 經過真實的入口 resolver。**
- 依 AGENTS.md §9 停止線，第二輪修正前先由 Master 決定身分管道（D5）並重新 review-plan。

### 修正（D5：x-bff-* trusted identity 管道）

- `runDefaultAgent` 改以入口 resolver 在 production 模式本來就接受的欄位提供身分與 correlation，不再傳 `execution_context`：
  - correlation：`thread_id`（既有 `localExperimentId`）、`run_id`（既有 per-item `runId`）、`request_id`（由 `runId` 衍生，per-item 不同）。`taskId` 由入口的 task admission 指派，evaluation 不提供；`step_id` 由入口移除，evaluation 也不提供。
  - trusted identity：`x-bff-principal-id`、`x-bff-principal-type`（`user`）、`x-bff-tenant-id`、`x-bff-roles`（空）、`x-bff-scopes`（空）、`x-bff-auth-source`（`trusted_gateway`）、`x-bff-authenticated-at`、`x-bff-scope-id`、`x-bff-scope-type`（`tenant`）。
  - `x-bff-authenticated-at` MUST 由 `Date.prototype.toISOString()` 產生（`YYYY-MM-DDTHH:mm:ss.sssZ`）；入口的 ISO 檢查要求字串與 `toISOString()` 結果完全相同，帶時區偏移或缺毫秒的字串會被拒絕。
  - 不提供 `x-bff-principal-kind`：缺少時入口由 `principalType` 推導（`user` 推導為既有對應值），evaluation 不另外指定。
  - principal 與 tenant 仍為 per-experiment 合成 evaluation 身分（由 `localExperimentId` 衍生），不同 experiment 彼此隔離；scope 為該 tenant 的 tenant scope。
  - 不提供 `x-bff-account-id`、`x-bff-session-id`：evaluation 沒有真實帳號與 session。
- 欄位名稱 MUST 取自 runtime 既有的單一來源（trusted principal header 常數與 scope 欄位），不在 evaluation 另寫一份字串清單；若既有常數未匯出，只允許新增匯出，不得改動其值或解析規則。
- 建立邏輯抽成可單獨測試的純函式，輸出 graph 的 `configurable`；`ExperimentDependencies` 與 `ExperimentAgentContext` 的公開形狀不變。
- 信任邊界：`x-bff-*` 是 BFF 在可信 gateway 位置注入的欄位。evaluation 以 in-process 方式扮演 trusted gateway，**只限**於 backend 內部、由 `RUN_OPIK_EVALUATION` opt-in 執行的評估程式碼；不新增任何對外可觸發的路徑，不改變 BFF 或 HTTP 入口對 `x-bff-*` 的處理。
- identity status：本機與 CI 的 identity status 檢查目前關閉。若環境開啟 `IDENTITY_STATUS_ENFORCEMENT_ENABLED`，evaluation 因沒有 account／session，入口 MUST 依既有規則以 `IDENTITY_CONTEXT_REQUIRED` 拒絕；evaluation MUST NOT 偽造 account 或 session 來繞過。此時 live smoke 判為失敗並依停止線回報。
- 不修改 `deepResearcherGraph`、`createGraphEntryContextResolver`、`instrumentGraphWithExecutionContext`、`readExecutionContext`、`parseTrustedPrincipal` 的行為或驗證規則。
- 測試（補上 D4 的缺口）：
  - mock 策略：
    - 移除 D4 加入的 `vi.mock("../../agents/deep-researcher.js")`。在 D4 之前，既有測試本來就會載入真實的 deep-researcher 模組並全數通過，所以移除後不會增加新的載入副作用；既有測試仍以注入 `runAgent` 的方式隔離，不呼叫真實 graph。
    - `runDefaultAgent` 增加一個只供內部與測試使用的 graph 參數，預設值為 `deepResearcherGraph`；`ExperimentDependencies.runAgent` 的簽章與 production 呼叫路徑不變。測試以這個參數傳入「真實入口包裝的 stub graph」，不 mock 整個模組，也不 spy 掉 instrument 包裝。
  - 純函式測試：產出的 `configurable` 含上述欄位，不含 `execution_context`；per-item 的 `request_id`／`run_id` 不同；不同 experiment 的 principal 與 tenant 不同。
  - **真實入口測試（經由 `runDefaultAgent`）**：以真實的 `createGraphEntryContextResolver` 與 `instrumentGraphWithExecutionContext` 包裝一個 stub graph（只記錄收到的 config 並回傳固定訊息），注入 fake task admission（不需資料庫），再把它傳給 `runDefaultAgent` 執行一個 item。斷言 stub graph 收到的 `configurable.execution_context` 通過 canonical 驗證，principal、scope、requestId、threadId、runId 與預期一致，`taskId` 為 admission 指派的值；`runDefaultAgent` 回傳 stub 的訊息。這個測試在 D4 的實作下必定失敗，可直接證明補上了 D4 的缺口。
  - 反例測試：同一個真實入口包裝在缺少 `x-bff-*` 欄位時仍以既有錯誤拒絕；呼叫端自帶的 `execution_context` 仍被忽略。

### live 重跑的前置條件

- deep-researcher 的 tool 呼叫會經過 unified tool dispatch pipeline。依「失敗 F1」的分析，Task-Step adapter 在 runtime 透過 `DATABASE_URL` 連線 PostgreSQL；連不上時 tool 呼叫會以 `TASK_STEP_UNAVAILABLE` fail-closed，而 live smoke 斷言 `tool_call_correctness` 必須大於 0，因此仍會失敗。
- 因此 Task 3.3 的 live 環境除了 Opik 與模型設定，還需要 runtime `DATABASE_URL` 指向一個已 migrate、可寫入的隔離 PostgreSQL（可與 Task 2.3 使用同一個隔離資料庫）。這是被評估的 agent 本身的 runtime 依賴，不是測試 gating，因此不新增 opt-in 變數。
- 若修正後 live 重跑出現新的失敗層級（例如 tool dispatch 或 synthesis），依 AGENTS.md §9 停止線先固化證據、重新判定層級，再回 CCR 決定，不在施工中疊加修正。

### 替代方案（不採用）

- 由 evaluation 直接傳 `execution_context`（D4）：入口依設計丟棄，已證實無效。
- 讓入口 resolver 對 evaluation 接受呼叫端的 `execution_context`：會打開「呼叫端自帶身分」的入口，削弱安全設計，拒絕。
- 使用開發模式開關（`NODE_ENV=development` 搭配 `EXECUTION_CONTEXT_DEV_ENABLED`）：讓結果依賴執行環境，且開發模式身分固定為 public tenant，拒絕。
- 繞過入口直接呼叫內部 compiled graph：跳過 task admission 與入口治理，拒絕。
- 共用單一固定 principal／tenant：不同 experiment 的資料會混在一起，也不利於清理，拒絕。

### 原始分析（診斷前）

### 已知

- gate `RUN_OPIK_EVALUATION=true` 已存在，本機 `.env` 啟用後實際執行。
- 失敗發生在 `completedItems` 長度斷言（預期 `min(maxItems, dataset.items.length)` = 1，實際 0）。前面的 `traceIds.length > 0`、`hostedStatus === "SUCCEEDED"`、experiment id／url 斷言都已通過，表示 hosted experiment 有建立，但 item 沒有完成（狀態可能是 FAILED／TIMEOUT 等）。
- 基準 HEAD 也失敗，所以不是 `switch-generation-to-qwen35-flash` 造成的。

### 診斷方式

由 Codex 在 Master 提供的 live 環境，以 `RUN_OPIK_EVALUATION=true` 重跑單一案例，收集每個 item 的 `status` 與錯誤類別／訊息摘要（不含 Secret、Prompt 原文或 API 回應全文）。依 AGENTS.md §4 判定層級：Model Provider、Tool Execution、Synthesis、評估框架，或外部配額／網路。

### 待 Master 決策 D2

- **D2-A（推薦）**：在本 Change 內診斷，不在診斷前修改程式。
  - 判定為外部因素（配額、模型下線、網路）：記錄證據，由 Master 在環境恢復後重跑；本 Change 的 Opik 項目以「預設環境 skip + live 重跑證據」關閉。
  - 判定為程式或測試缺陷：回 CCR 更新規格與 tasks（若涉及 production 程式需重新 review-plan），再交 Codex 修正。
- **D2-B**：本 Change 只確保預設環境 skip 的語意正確，把 Opik live 失敗另開 Change。本 Change 的完成判準不含 Opik live 通過。

### 共同決策 D3：完成判準

- **D3-A（推薦）**：同時滿足以下各項才算完成：
  1. 預設環境（opt-in 全關，與 CI 一致）`npm run lint && npm run test && npm run build` 全數通過，報告列出 skip 的 suite 與原因。
  2. 本機 `.env` 原樣（D1-B 下 runtime `DATABASE_URL` 指向不可達位址，opt-in 關閉）同一組命令也通過，證明 hermetic。
  3. PostgreSQL opt-in 在隔離 PG 下通過。
  4. Opik opt-in 依 D2 的結果。
- **D3-B**：只要求 D3-A 第 1 項，第 3、4 項列為「尚待 live 驗證」。

## 資料流與責任邊界

- frontend、bff：無變更。
- backend：F1、F3 只動測試檔與測試 gating。F2（D4）修改 `src/evaluation/opik/experiment.ts` 呼叫 graph 的方式與其單元測試；production 的 dispatch、persistence、execution context 契約與 graph 本身不變。
- 資料流（F2 修正後）：`runExperiment` → `runDefaultAgent` 建立 per-item correlation 與 `x-bff-*` trusted identity → `deepResearcherGraph.invoke` → 入口 resolver 以既有規則重建 canonical execution context 並由 task admission 指派 taskId → agent 與 tool dispatch。

## 安全與權限

- 不讀取或保存任何 `.env*` 值。證據只記錄變數**名稱**與「已設定／未設定／空字串」狀態。
- 新的測試專用連線字串只從環境變數讀取，不寫死 URL、Port 或帳密。

## 相容性與風險

- 錯誤碼、Graph ID、BFF Route、事件不變。
- F2 修正只影響 Opik evaluation 的呼叫端；graph 與 execution context 契約不變。evaluation 產生的 runtime 資料列帶有 per-experiment tenant，只會寫入 live 環境指定的隔離資料庫；本 Change 不提供清理工具。
- D1-B 之後，若有人依賴「設了 `DATABASE_URL` 就自動跑 integration」，需改為明確 opt-in。CI 不受影響。
- 檔案衝突：Codex 施工前必須確認目標測試檔在 working tree 沒有其他 Change 未提交的修改；若有，停止並回報。

## 可觀測性

驗證證據放在 `.agent-runtime/fix-backend-baseline-test-failures/evidence/`，每次執行記錄命令、環境變數名稱與狀態、exit code、tests passed／failed／skipped 數與 skip 的 suite 名稱。
