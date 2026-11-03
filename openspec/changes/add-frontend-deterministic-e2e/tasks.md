# Tasks

> lite profile（ADR-FL-001／ADR-FL-002）。Primary Implementer：Codex（attempt 2 由 CCR 經 Master 授權以 implementation_secondary 實作 1～10）。Secondary Architecture Reviewer：Qwen。規劃基準 `a090967`，實作基準 `feat/4.6.5-feat/lane-knowledge-retrieval` @ `f5b81633e7c2023e1f1a10461d69db77689bb686`（Master 同意取代）。每個 Task 只有在程式、測試與驗證都實際完成並通過後才能勾選。本 Change 只有 deterministic 測試，沒有 live 驗證。證據存於 `.agent-runtime/add-frontend-deterministic-e2e/evidence/`。

驗證命令（皆於 `frontend/` 執行）：

```bash
npm run lint
npm run test
npm run build
npm run test:e2e
```

## 1. 前置確認

- [x] 1.1 確認工作樹中其他 Change（含 F-L1 相關）的未提交修改與本 Change 檔案邊界不重疊；`bff/` 與 `backend/` 沒有任何修改。驗證：implementation_result 列出 `git status --short`、`git diff --stat -- bff backend`（應為空）與本 Change 修改清單。
- [x] 1.2 以瀏覽器實際請求紀錄確認 `useStream` 用到的端點與 SSE 事件種類，寫入 implementation_result（design D4）。驗證：附上紀錄來源與端點清單。

## 2. E2E 基礎設施

- [x] 2.1 新增精確版本的 `@playwright/test` devDependency 與 `test:e2e` script；Playwright 只設定 Chromium、`retries: 0`；新增 E2E 用 tsconfig；`.gitignore` 加入 Playwright 輸出目錄（Requirement「E2E 時序 MUST 由情境控制而非固定延遲」「E2E MUST 在 CI 執行且不影響既有驗證」）。驗證：`npm run build` 通過；`git diff -- package-lock.json` 只含 Playwright 相關套件。
- [x] 2.2 Vitest 排除 E2E 目錄；ESLint 對 E2E 檔案禁止 `waitForTimeout` 與以 `setTimeout` 包成的等待（design D6）。驗證：`npm run test` 的測試檔數與套用前相同；在暫存檔加入 `page.waitForTimeout(1)` 時 `npm run lint` 失敗，移除後通過（結果寫入 evidence，暫存檔不得提交）。
- [x] 2.3 新增 `.env.e2e` 與 `vite build --mode e2e` 流程，只含非機密值（design D2）。驗證：檢查 `.env.e2e` 內容沒有 Key、Token 或正式 URL；E2E build 的 bundle 以同 origin `/api/langgraph` 連線。
- [x] 2.4 實作 fixture server：同 origin 提供 `/app/` 靜態檔、`/api/langgraph/*` 情境回應、`/__e2e/*` 控制介面；每個測試一個 server、只綁 `127.0.0.1`；gate 釋放；請求紀錄；unexpected 請求、`pageerror`、非 test origin 連線使測試失敗（design D1、D5；Requirement「E2E MUST 只依確定性回應執行」）。驗證：harness 自測，涵蓋 unexpected 請求使測試失敗、外部連線被拒、gate 未釋放前不送出後續內容。
- [x] 2.5 情境載入時以 Frontend 既有 parser 驗證 envelope 與 card payload；刻意無效的內容需明確標記（design D4）。驗證：harness 自測，未標記的無效 payload 使測試失敗。

## 3. 串流

- [x] 3.1 逐步渲染、成功完成、未知事件、中途失敗、逾時五個 Scenario（Requirement「串流回覆 MUST 逐步渲染並單向收斂到 Terminal State」）。驗證：`npm run test:e2e -- <串流測試檔>`。

## 4. 使用者取消

- [x] 4.1 UI 立即反映、取消信號送達上游、晚到內容不復活（design D3 兩種管道）、取消後開始新回覆（Requirement「使用者取消 MUST 立即生效且不可被晚到內容推翻」）。驗證：`npm run test:e2e -- <取消測試檔>`；請求紀錄顯示原連線在完成前關閉，且只有一次帶 `targetRunId` 的 cancel 請求。

## 5. HITL 審批

- [x] 5.1 核准、拒絕、撤回、送出失敗、連點只送一次（Requirement「HITL 審批 MUST 以一次性 resume 送出人工決定」）。驗證：`npm run test:e2e -- <HITL 測試檔>`；連點情境以請求紀錄計數。

## 6. 退款去重畫面

- [x] 6.1 原操作已知、原操作未知、未知操作狀態，並涵蓋三種去重原因（Requirement「退款去重畫面 MUST 呈現去重狀態、原因與原操作狀態」）。驗證：`npm run test:e2e -- <去重卡片測試檔>`。

## 7. Clarification

- [x] 7.1 選擇候選後恢復、取消 Clarification、恢復失敗（Requirement「Clarification MUST 以一次性 resume 恢復」）。測試只斷言 resume 內容來自 interrupt 的結構化候選與 interruptId，不涉及地點解析（`docs/agent-rules/weather.md`）。驗證：`npm run test:e2e -- <Clarification 測試檔>`。

## 8. 事件與提交去重

- [x] 8.1 `eventId` 重複、`sequence` 亂序、過期 Run、訊息 ID 重複、Terminal 重播、重複提交（Requirement「事件與提交 MUST 在瀏覽器中去重」）。versioned 事件情境走 Gun Shop 入口（design §1）。驗證：`npm run test:e2e -- <去重測試檔>`；重複提交以請求紀錄計數。

## 9. CI

- [ ] 9.1 新增 `.github/workflows/frontend-e2e.yml`（design D10）。驗證：以 `actionlint` 或等價工具檢查語法（無法執行時標示未執行）；在 PR 上實際執行一次並記錄 run URL 與結果；若無法在 PR 執行，標示未執行，不得宣稱 CI 通過。

## 10. 收尾驗證

- [x] 10.1 完整回歸：`npm run lint`、`npm run test`、`npm run build`、`npm run test:e2e` 全部通過；`npx playwright test --repeat-each=5 --retries=0` 全部通過（design D6）。驗證：輸出寫入 evidence 並由 implementation_result 引用。
- [x] 10.2 產品原始碼變更檢查：`git diff --stat -- frontend/src` 應為空；若依 design D8 新增 selector，逐一列出並說明沒有行為改變。驗證：implementation_result 附上 diff。
- [x] 10.3 若任一 Scenario 揭露產品缺陷，依 design D9 保存證據並回報 CCR；不得勾選該 Scenario 所屬 Task。驗證：implementation_result 的未完成項目與 evidence 清單。

## 11. 已知限制處置（2026-11-02 Master 決定，design D9、D11）

- [x] 11.1 將 design D11 表列的 4 個測試以 `test.fail()` 標記，annotation 為 `{ type: 'known-limitation', description: 'KL-n：<一句說明>' }`；原 assertion、情境與其他測試一字不改，不得使用 `test.skip`／`test.fixme`。驗證：`git diff -- frontend/e2e` 只新增標記與 annotation；`npm run lint`、`npm run test:e2e` 通過；`npx playwright test --repeat-each=5 --retries=0` 全部通過（KL 測試以 expected failure 計）；報告列出 4 個 KL 測試的 expected-failure 結果。
- [x] 11.2 11.1 完成後，重新判定 3.1、4.1、5.1、10.1：除 D11 表列測試外，其餘 Scenario 測試全部通過，且 KL 測試標記符合 D9 時才可勾選。1.1 的「`git diff --stat -- bff backend` 應為空」因工作樹已有其他工作的 bff/backend 修改而無法成立，改以開工前後 `git status` 相同為證據，由 Reviewer 判定是否接受。驗證：implementation_result 逐項列出判定依據。
