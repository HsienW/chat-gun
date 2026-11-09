## Why

backend 完整測試（`cd backend && npm run lint && npm run test && npm run build`）在不含任何進行中 Change 的 HEAD 上有 3 個既有失敗，導致所有要求「backend 完整測試全數通過」的 Change（目前是 `demo-cost-and-access-guard` tasks 2.5、5.6、6.3，以及排在它之後的 `switch-generation-to-qwen35-flash`）都無法驗收。Master 決策 M-7（2026-11-04）要求另開 Change 處理，Opik 與 PostgreSQL 案例在具備環境時重跑。

三個失敗與已定位的層級：

1. **Tool dispatch「mandatory dependency 缺失」測試（錯誤碼不符）**：預期 `TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE`，實際得到 `TASK_STEP_UNAVAILABLE`。已定位為**測試隔離缺陷，不是程式缺陷**：測試沒有隔離 PostgreSQL pool，因此 pipeline 的 production default 會讀取開發者本機 `.env` 的 `DATABASE_URL`，自動組出 Task-Step adapter。前提「dependency 缺失」因此不成立，執行路徑變成「dependency 已組裝但啟動失敗」。兩條路徑都 fail-closed、都不 dispatch，符合主規格 `unified-tool-dispatch-pipeline`。
2. **Hosted Opik live smoke（items 未完成）**：測試已用 `RUN_OPIK_EVALUATION=true` opt-in，本機環境啟用後實際執行。hosted experiment 已建立，但完成的 item 數量是 0。Task 3.1 的 live 診斷已定位為 **evaluation 程式缺陷**：`experiment.ts` 呼叫 `deepResearcherGraph` 時沒有提供 graph 入口在 production 模式所需的身分與 correlation（入口只從 `x-bff-*` trusted identity 欄位重建 principal 與 scope，並會忽略呼叫端自帶的 execution context），每個 item 都在 Zod 驗證時失敗（缺 `requestId`、`principal`、`scope`），與模型或外部環境無關。
3. **Runtime PostgreSQL integration（ECONNREFUSED 127.0.0.1:5433）**：gate 直接看 runtime 用的 `DATABASE_URL` 是否存在。開發者 `.env` 為了執行應用程式會設定它，所以預設測試就會嘗試連線，PostgreSQL 沒啟動時便失敗；在隔離 PostgreSQL 下可以通過。

## What Changes

- 定義 backend 測試基準的「完成」判準：預設環境的 lint／test／build 全數通過；需要外部環境的案例以專用、明確的 opt-in gating 控制，未啟用時 skip 並在報告中列出；啟用時環境不可用 MUST fail，不得 skip。
- 修正 dispatch dependency 測試的隔離問題：讓「dependency 缺失」的前提不受本機環境影響。不放寬 Assertion，並補上「已組裝但啟動失敗」路徑的獨立測試。
- 在 `unified-tool-dispatch-pipeline` 補上兩種 fail-closed 路徑的錯誤碼語意 Scenario，避免往後在兩者之間來回修改。
- PostgreSQL integration 改用專用 opt-in：`RUN_PG_INTEGRATION=true` 搭配 `TEST_DATABASE_URL`（Master 決策 D1-B）。
- Opik live 失敗在本 Change 內先診斷，診斷前不改程式（Master 決策 D2-A）。診斷判定為程式缺陷後，修正併入本 Change（Master 決策 D4，2026-11-09）。第一版修正（直接傳 execution context）被入口依設計丟棄後，Master 決策 D5：Opik evaluation 以 in-process 方式經由 `x-bff-*` trusted identity 管道為每個 item 提供 per-experiment 合成身分與 correlation，不放寬 graph 入口或 Runtime Validation。
- 採完整完成判準（Master 決策 D3-A），見 design。

## Capabilities

### New Capabilities

- `backend-test-baseline`：backend 預設測試套件的 hermetic 要求、外部環境測試的 opt-in gating 語意、基準驗證證據格式，以及 evaluation harness 呼叫 graph 時 MUST 提供 canonical execution context。

### Modified Capabilities

- `unified-tool-dispatch-pipeline`：在「mandatory dependency 於 dispatch 前 unavailable MUST fail-closed」Requirement 中補充「未提供」與「已組裝但啟動失敗」兩條路徑的錯誤碼 Scenario。行為不變。

## Impact

- 受影響套件：只有 `backend`。F1、F3 只動測試與測試 gating；F2 修改 `src/evaluation/opik/experiment.ts`（evaluation 呼叫端）與其單元測試，並在 `src/runtime/authorization/principal.ts`、`src/runtime/execution-context/read-execution-context.ts` 只新增匯出既有欄位名稱常數（值與行為不變）。graph 入口、tool dispatch、persistence 與 execution context 契約不變。
- frontend、bff：無影響。
- 公開 API、事件、Graph ID、錯誤碼：不變（只補規格 Scenario，不改錯誤碼）。
- 下游：本 Change 完成後，`demo-cost-and-access-guard` 的 CCR 可交 Codex 重跑 tasks 2.5、5.6、6.3。

## Goals / Non-Goals

**Goals**

- 預設環境下 `npm run lint && npm run test && npm run build` 全數通過。
- 每個外部環境案例在 opt-in 環境中實際執行並有證據。
- 不放寬任何 Assertion，不刪測試，不用固定延遲或 Mock 掩蓋核心邏輯。

**Non-Goals**

- 不修改 tool dispatch pipeline 的 production 行為或錯誤碼。
- 不修改 `deepResearcherGraph`、`createGraphEntryContextResolver`、`instrumentGraphWithExecutionContext`、`parseTrustedPrincipal` 或 execution context 的驗證規則。
- 不改變 BFF 或 HTTP 入口對 `x-bff-*` 的處理，不新增對外可觸發的路徑。
- 不提供或啟動 PostgreSQL／Opik 基礎設施（由 Master 於具備環境時執行）。
- 不修改其他進行中 Change 已修改、尚未提交的檔案（包括 `backend/.env.example`）。
- 不處理 CI workflow 的 PostgreSQL service 設定（若需要另開 Change）。

## Risks

- 若 D1 選擇新增專用 opt-in 變數，任何依賴 `DATABASE_URL` 自動觸發 integration 測試的流程都會改為需要明確啟用。現有 backend／harness CI workflow 已固定 `DATABASE_URL=''`、`RUN_OPIK_EVALUATION='false'`，不受影響（見 design）。
- Opik live 重跑需要被評估的 agent 的 runtime 依賴可用，包括可連線的隔離 PostgreSQL；修正 execution context 後可能暴露下一個失敗層級。緩解：依 design 的停止線處理，不在施工中疊加修正。

## Rollback

F1、F3 只涉及測試檔；F2 只涉及 Opik evaluation 呼叫端與其測試。回滾即還原這些檔案的 diff，不影響 serving runtime 行為或既有資料。
