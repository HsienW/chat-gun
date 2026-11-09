## 0. 施工前檢查（Primary Implementer：Codex）

- [x] 0.1 確認本 Change 要修改的測試檔在 working tree 沒有其他 Change 未提交的修改（`git status --porcelain -- backend/src/runtime/tool-dispatch/pipeline.test.ts backend/src/runtime/__tests__/integration.test.ts`）；若有，停止並回報 CCR。驗證：命令輸出寫入 evidence。

## 1. F1：dispatch dependency 測試隔離（backend-test-baseline、unified-tool-dispatch-pipeline）

- [x] 1.1 修改前重現：分別在 `DATABASE_URL` 指向不可達位址、`DATABASE_URL=''` 兩種環境執行該案例，記錄實際 errorCode（預期前者 `TASK_STEP_UNAVAILABLE`，後者 `TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE`）。驗證：`cd backend && npx vitest run src/runtime/tool-dispatch/pipeline.test.ts -t "fails closed when a mandatory dependency is unavailable"`，兩種環境的輸出都存成 evidence。
- [x] 1.2 在該測試中以明確的 `pool: null` 隔離 production default；errorCode 與「runner 未被呼叫」的斷言保持不變。
- [x] 1.3 新增測試：注入一個 `start` 會 reject 的 Task-Step adapter，斷言結果為 `rejected_before_dispatch` + `TASK_STEP_UNAVAILABLE`，且 runner 未被呼叫；不依賴真實 PostgreSQL。
- [x] 1.4 驗證：兩種環境下 `cd backend && npx vitest run src/runtime/tool-dispatch/pipeline.test.ts` 都全數通過，passed 數相同。

## 2. F3：PostgreSQL integration 專用 opt-in（backend-test-baseline；D1-B）

- [x] 2.1 gate 改為只有 `RUN_PG_INTEGRATION=true` 時才執行，連線字串讀 `TEST_DATABASE_URL`，不沿用 runtime `DATABASE_URL`；啟用但缺少 `TEST_DATABASE_URL` 時 MUST 以指出變數名稱的明確訊息失敗；在測試檔頭註解說明這兩個變數。不修改 `backend/.env.example`。
- [x] 2.2 驗證 gating 三態並記錄：未啟用 → skip；啟用＋缺設定 → fail；啟用＋不可達 → fail（ECONNREFUSED 類別）。驗證：`cd backend && npx vitest run src/runtime/__tests__/integration.test.ts` 依序在三種環境執行。
- [x] 2.3 Master 在隔離 PostgreSQL 下執行 `RUN_PG_INTEGRATION=true TEST_DATABASE_URL=<隔離 PG>` 的同一命令，結果通過；evidence 只記錄變數名稱與狀態。

## 3. F2：hosted Opik live 失敗診斷（backend-test-baseline；D2-A）

- [x] 3.1 在 Master 提供的 live 環境以 `RUN_OPIK_EVALUATION=true` 執行 `cd backend && npx vitest run src/evaluation/opik/experiment.live-smoke.test.ts`，收集每個 item 的 `status` 與錯誤類別摘要（不含 Secret、Prompt 原文、回應全文），依 AGENTS.md §4 判定失敗層級，寫入 evidence。診斷前不修改程式。
- [x] 3.2 依 3.1 的判定交 CCR 仲裁：若是外部因素，記錄後由 Master 在環境恢復後重跑；若是程式或測試缺陷，CCR 先更新本 Change 的規格與 tasks（涉及 production 程式時重新 review-plan），再施工。
- [x] 3.3 live 重跑通過的 evidence：在 3.6 完成後（第 1 次重跑在 D4 下失敗，證據 `evidence/task-3.3-opik-live-attempt-1.json`，不計入），以 Master 提供的 live 環境（Opik 與模型設定，以及 runtime `DATABASE_URL` 指向已 migrate 的隔離 PostgreSQL，見 design「live 重跑的前置條件」）執行 3.1 的同一命令，結果通過；evidence 記錄每個 item 的 `status` 與錯誤類別，只記錄變數名稱與狀態。若出現新的失敗層級，依 design 停止線回報 CCR，不得勾選。

## 3A. F2 修正：evaluation 經由 x-bff-* trusted identity 管道進入 graph（backend-test-baseline；D4 → D5）

D4（直接傳 `execution_context`）已被證實無效並由 D5 取代；下列 3.5–3.7 依 D5 重新施工與驗證，D4 階段的勾選不再有效。

- [x] 3.4 施工前確認本 Change 要修改的檔案在 working tree 沒有其他 Change 未提交的修改：`git status --porcelain -- backend/src/evaluation/opik/ backend/src/runtime/authorization/principal.ts backend/src/runtime/execution-context/read-execution-context.ts`。`src/evaluation/opik/` 下只允許本 Change 自己的 D4 修改；若有其他修改，停止並回報 CCR。驗證：命令輸出寫入 evidence。
- [x] 3.5 先寫失敗測試（`experiment.test.ts`）。mock 策略依 design：移除 D4 的測試與 `vi.mock("../../agents/deep-researcher.js")`，不以任何方式 mock 整個 graph 模組或 spy 掉 instrument 包裝；既有測試維持以注入 `runAgent` 隔離。
  - 純函式測試：產出的 `configurable` 的 key 集合恰好是 `thread_id`、`run_id`、`request_id`、`x-bff-principal-id`、`x-bff-principal-type`、`x-bff-tenant-id`、`x-bff-roles`、`x-bff-scopes`、`x-bff-auth-source`、`x-bff-authenticated-at`、`x-bff-scope-id`、`x-bff-scope-type`（共 12 個，斷言時以 runtime 匯出的常數取名，不另寫字串）；不含 `execution_context`、`x-bff-principal-kind`、`x-bff-account-id`、`x-bff-session-id`；`x-bff-authenticated-at` 等於注入時間的 `toISOString()`；per-item 的 `request_id`／`run_id` 不同；不同 experiment 的 principal 與 tenant 不同。
  - 真實入口測試（經由 `runDefaultAgent`）：以真實的 `createGraphEntryContextResolver` 與 `instrumentGraphWithExecutionContext` 包裝 stub graph，注入 fake task admission，透過 `runDefaultAgent` 的內部 graph 參數執行一個 item；斷言 stub graph 收到的 execution context 通過 canonical 驗證，principal、scope、requestId、threadId、runId 符合預期，taskId 為 admission 指派值，且 `runDefaultAgent` 回傳 stub 的訊息。
  - 反例測試：同一真實入口包裝在缺少 `x-bff-*` 欄位時仍拒絕，且呼叫端自帶的 `execution_context` 仍被忽略。
  - 修改前執行應失敗（D4 的實作下，真實入口測試必定失敗）。驗證：`cd backend && npx vitest run src/evaluation/opik/experiment.test.ts`，修改前輸出存成 evidence。
- [x] 3.6 修改程式：
  - `principal.ts` 只新增匯出既有的 trusted principal header 常數；`read-execution-context.ts` 只把 scope 欄位名稱抽成匯出常數並在原處使用。兩者的值與解析行為不變。
  - `experiment.ts`：純函式改為產出入口接受的 `configurable`（欄位名稱取自上述常數），`runDefaultAgent` 傳入該 config，不再傳 `execution_context`；`runDefaultAgent` 增加預設為 `deepResearcherGraph` 的內部 graph 參數，production 呼叫路徑與 `ExperimentDependencies.runAgent` 簽章不變；`ExperimentDependencies` 與 `ExperimentAgentContext` 的公開形狀不變；不修改 graph 入口或任何驗證規則。
  - 驗證：3.5 的測試通過；`npx vitest run src/runtime/execution-context/ src/runtime/authorization/` 與 `src/evaluation/opik/` 既有測試全數通過、斷言未放寬。
- [x] 3.7 預設環境（`RUN_OPIK_EVALUATION=false`）下 live smoke 仍為 skip，且不嘗試連線 Opik。驗證：`cd backend && npx vitest run src/evaluation/opik/`，記錄 passed／skipped 數。

## 4. 完成判準驗證（backend-test-baseline；D3-A）

- [x] 4.1 預設環境（`DATABASE_URL=''`、`RUN_OPIK_EVALUATION=false`、`RUN_PG_INTEGRATION` 未設定）：`cd backend && npm run lint && npm run test && npm run build` 全數通過；evidence 列出 passed／failed／skipped 數，以及被 skip 的 suite 與原因。
- [x] 4.2 本機 `.env` 原樣、opt-in 關閉：同一組命令全數通過，passed／failed／skipped 數與 4.1 相同。
- [x] 4.3 `git diff --stat` 只包含本 Change 的檔案（兩個 runtime 測試檔、`src/evaluation/opik/experiment.ts`、`experiment.test.ts`、`src/runtime/authorization/principal.ts` 與 `src/runtime/execution-context/read-execution-context.ts`）；與基準 evidence 比對，沒有新的失敗。
- [x] 4.4 implementation_result 的 `verification.notExecuted` 如實列出未在 live 環境執行的項目。
