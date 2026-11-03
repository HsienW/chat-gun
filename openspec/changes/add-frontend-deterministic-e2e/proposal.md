# Proposal：Frontend 確定性 E2E（X46 第一片）

> lite profile（ADR-FL-001／ADR-FL-002）。到期日依 ADR：X29 開啟或 2026-11-30，以先到者為準。規劃基準：`feat/4.6.5-feat/lane-knowledge-retrieval` @ `a090967`（Master 於 2026-11-01 確認由 `740cc4e` 改用此 commit；`740cc4e..a090967` 沒有修改 `frontend/` 或 `bff/`）。

## Why

### 問題

Frontend 的串流、取消、HITL 核准、去重卡片與 Clarification 恢復，目前只有 Vitest＋jsdom 的元件與純函式測試。這些測試驗證 reducer 與單一元件，沒有驗證真實瀏覽器裡的整段互動：

- `useStream` 的實際 HTTP／SSE 交換、`AbortController` 中斷與取消後的 `kind: 'cancel'` 請求。
- 多個 reducer（stream activity、commerce、runtime event buffer）在同一頁面上的組合結果。
- 連點、Enter 與按鈕同時觸發時，網路上實際送出幾次。

`second-stage-plan-en-v7.md` 的 X46 要求 Playwright E2E 在 CI 執行，涵蓋串流渲染、使用者取消、HITL 核准恢復與退款去重畫面。

### 為何要確定性回應

live 模型目前有已知限制 F-L1（`fix-order-request-tool-initiation` 仍在進行）：模型是否發起 Tool 呼叫不穩定，會讓 E2E 的失敗原因混入模型行為。E2E 的目標是驗證 Frontend 行為，因此後端回應 MUST 是確定性腳本，與模型、Provider、F-L1 修正進度無關。

## What Changes

- 在 `frontend/` 新增 Playwright E2E 套件，只在 Chromium 執行。
- 新增 E2E 專用的確定性 fixture server：提供已建置的 Frontend 靜態檔，並在同一個 origin 模擬 BFF 對瀏覽器公開的 `/api/langgraph` 介面。它只存在於測試，不進入產品 bundle。
- 新增 `frontend` devDependency `@playwright/test`（精確版本）與 `test:e2e` script。
- 調整 Vitest 設定，排除 E2E 檔案，避免 `npm run test` 誤收。
- 新增 `.github/workflows/frontend-e2e.yml`，在 Frontend 變更時執行 E2E。
- 新增 capability spec `frontend-deterministic-e2e`。

不修改產品程式碼的行為。E2E 若揭露產品缺陷，依 design D9 停止並回報，不在本 Change 內修正。

### 已知限制（2026-11-02 Master 決定）

attempt 2 的 E2E 在實際基準 `f5b81633e7c2023e1f1a10461d69db77689bb686` 上揭露 3 個產品缺陷（4 個測試，`--repeat-each=5` 穩定重現）。Master 接受為已知限制，本 Change 不修正產品行為，spec 的 Requirement 也不放寬：

- KL-1：BFF 形狀的結構化錯誤 frame 經 SDK 後遺失錯誤碼，`bff_timeout`／`upstream_timeout` 顯示為 `unknown_error`，逾時語意不可見。
- KL-2：HITL 送出失敗時，卡片保持開啟並可重送，但不顯示錯誤碼。
- KL-3：取消後，cancel 請求的串流若夾帶已取消 Run 的訊息內容，畫面會顯示該內容。

這 4 個測試保留原 assertion，以預期失敗標記並指向 design 的 KL 編號（design D9、D11）。修正另立後續 Change。

## Capabilities

### New Capabilities

- `frontend-deterministic-e2e`：Frontend 在真實瀏覽器中、以確定性回應驗證串流、取消、HITL、去重卡片、Clarification 與事件去重行為。

### Modified Capabilities

無。本 Change 驗證既有 `frontend-chat`、`order-operation-status-surface`、`runtime-event-contract`、`frontend-weather-forecast` 的行為，不改變它們的 Requirement。

## 範圍

### 目標

1. 串流：逐步渲染、成功完成、未知事件、中途失敗、逾時。
2. 使用者取消：UI 立即反映、中斷信號送達瀏覽器對外邊界、晚到內容不復活、取消後可開始新回覆。
3. HITL 核准恢復：核准、拒絕、撤回、送出失敗、連點只送一次。
4. 退款去重畫面：`deduplicated` 狀態、去重原因、原操作狀態。
5. Clarification 恢復：已在 `a090967` 確認流程存在（weather interrupt、`clarification:` interruptId、選擇與取消兩種 resume）。
6. 事件與提交去重：`eventId` 重複、`sequence` 亂序、過期 Run、訊息 ID 重複、Terminal 重播、重複提交。
7. CI 執行、重複執行穩定性門檻、測試證據。

### 非目標

- 圖片上傳到推薦的流程：等 X47，已延到 v0.1.0 之後。
- web-vitals（LCP、INP、CLS）與 TTFT 上報、P50/P90 Dashboard：會動到 BFF 事件契約，拆成第二片。
- 修改 `bff/` 或 `backend/` 的任何檔案；新增或修改任何事件、錯誤碼或 API 契約。
- 真實 BFF 到 Backend 的中斷傳遞。這段由 `bff-stream-proxy` 的既有測試負責（Requirement「BFF MUST propagate downstream disconnect to upstream」）。
- live 模型 E2E、Firefox／WebKit、視覺快照比對。

## 受影響套件與能力域

| 套件 | 影響 |
|---|---|
| `frontend` | 新增 E2E 目錄、Playwright 設定、devDependency、`test:e2e` script；Vitest 排除 E2E。產品原始碼預期不變（例外見 design D8）。 |
| `bff` | 無 |
| `backend` | 無 |
| Repository | 新增一個 GitHub Actions workflow |

能力域：Frontend Chat 串流、Commerce 審批與操作狀態、Runtime Event 去重、Weather Clarification UI（只驗證渲染與 resume 送出，不涉及地點解析）。

## 與計畫的差異

- X46 依賴 X43 與 X47，原排程在 X47 之後。本片先做不依賴 X47 的部分；圖片 E2E 留到 X47 完成後。這是 Master 於 2026-11-01 的範圍決定。
- X46 的 observability 部分（web-vitals、TTFT、Dashboard、「metric 遺失不影響聊天」）不在本片。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| fixture 與真實 BFF／LangGraph 串流格式漂移 | E2E 通過但真實環境失敗 | fixture frame 以 Frontend 既有 parser 驗證，並以既有 contract fixture 為來源（design D4）；漂移風險寫入 implementation_result。本片不取代跨層契約測試。 |
| 「中斷傳到上游」只驗證到瀏覽器對外邊界 | 誤以為已驗證端到端取消 | 規格與報告明確標示驗證邊界（design D3）。 |
| 時序造成 flaky | CI 不可信 | 不使用固定延遲；以 gate 控制 fixture 送出時機；CI 不重試；驗收時以重複執行檢查（design D6）。 |
| E2E 揭露既有產品缺陷 | 範圍擴大 | 停止並回報 CCR，另開 Change（design D9）。已發生：KL-1～KL-3 由 Master 接受為已知限制（design D11）。 |
| 預期失敗標記讓已知限制被遺忘 | 缺陷長期留存 | 每個標記指向 KL 編號；產品修好時測試意外通過會使 CI 失敗，強制移除標記；tasks 要求提出後續修正 Change。 |
| 新 devDependency 與瀏覽器下載 | CI 時間與供應鏈 | 精確版本、只裝 Chromium、只在 Frontend 路徑觸發。 |

## 回滾

刪除 E2E 目錄、Playwright 設定、`test:e2e` script、devDependency 與 workflow，並還原 Vitest 排除設定。本 Change 不修改產品行為，回滾不影響執行中的服務。
