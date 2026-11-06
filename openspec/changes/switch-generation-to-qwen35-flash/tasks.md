## 0. 前置 Gate

- [x] 0.1 Qwen 完成 review-plan，Blocker 清零，Major 已修正或有明確接受理由。驗證：review-result-review-plan-003 由 adapter 保存（APPROVE，evidence gate 通過，0 Blocker／0 Major），CCR 仲裁兩個 Minor 並寫入 design 與本檔 2.2、2.3。
- [ ] 0.2 Master 定案 design 的 OD-1、OD-2、OD-3 並寫回 design（2026-11-04 已定案寫回：OD-1 (a)、OD-2 `LLM_THINKING_DEFAULT_ENABLED`、OD-3 (a)）；`openspec validate switch-generation-to-qwen35-flash --strict` 通過。驗證：design 不再有未定案的 OD；validate 輸出寫入 evidence。validate 尚未執行，所以本項保留未勾選，由 Codex 在施工前第一步執行。
- [ ] 0.3 Group B 施工前檢查（依 OD-1 (a)）：以 `git status --porcelain` 與 `git diff --stat` 確認 LLM Gateway、Gun Shop 模型設定、kb-eval CLI 沒有其他 Change 的未提交修改，或前一個 Change 已提交。驗證：命令輸出寫入 implementation_result 的 evidence；條件不成立時停止並回報 CCR，不施工 Group B。

範圍限制：MUST NOT 修改各 graph 檔案（`chatbot`、`deep-researcher`、`math-agent`、`mcp-agent`、`shopping-assistant/` 下除模型設定以外的檔案）、`backend/src/demo/**`、`backend/src/platform/usage/**`、`backend/src/application.ts`、bff、frontend、embedding 與 rerank 設定、`demo-cost-and-access-guard` 的單價 fixture，以及 `backend/data/**/results/**`。不重跑評測。

## 1. Group A：不重疊的檔案

- [ ] 1.1 更新 `.env.example`：所有生成用途的範例值改為 `qwen3.5-flash`（含 vision、legacy 別名）；新增 `SHOPPING_ASSISTANT_MODEL`、`SHOPPING_ASSISTANT_THINKING_ENABLED=false`、`LLM_THINKING_DEFAULT_ENABLED=false`、`KB_EVAL_GENERATION_MODEL` 的範例或註解；`QWEN_BASE_URL` 保留北京，並加註新加坡 endpoint 與「API Key 依區域分開」；embedding、rerank、judge 不變。對應 Requirement：「預設生成模型為單一來源的 qwen3.5-flash」「回滾只需改設定」。驗證：新增測試讀取 `.env.example`，斷言生成用途的值都是 `qwen3.5-flash`、不含任何非空憑證、embedding 與 rerank 鍵值與變更前相同；`cd backend && npx vitest run <新測試檔>`。
- [ ] 1.2 評測 invoker 包裝層（新檔，位於評測模組內）：收集每次回應的 provider 回報模型與實際送出的 thinking 值，不改變回傳內容。對應 Requirement：「評測記錄 provider 實際回報的模型」。驗證：有回報、未回報（`unreported`）、回報與設定不同、中途 provider 錯誤、取消的單元測試。
- [ ] 1.3 商務鏈評測與訂單請求 golden：建立模型時套用 Gun Shop 的 thinking 設定；provenance 新增 `generationModels`、`observedProviderModels`（含狀態）、`thinkingEnabled`、`llmProvider`、`llmEndpointHost`；報表加一行模型摘要；舊 provenance 讀取相容。對應 Requirement：「評測 provenance 記錄生成模型、thinking 與 endpoint」「live 評測的模型設定與 production graph 一致」。驗證：fake provider 測試斷言每個請求的 thinking 設定與 provenance 欄位；endpoint 含 query 或使用者資訊時只寫主機名稱；舊 `run.json` 重評分讀取通過；`cd backend && npx vitest run src/evaluation/commerce`。
- [ ] 1.4 新加坡 endpoint live probe（新檔，預設跳過，以獨立旗標啟用）：逐項驗證 text、json_object（通過 Runtime Validation）、tool_calling、vision（合成小圖）、thinking_off；結果寫入 evidence；不含金鑰或回應全文。對應 Requirement：「新加坡國際 endpoint 相容性以手動 live probe 驗證」。驗證：旗標未設定時跳過且不發出網路請求的測試；以 fake HTTP 驗證單項失敗、逾時、缺憑證、取消的分類測試。live 執行由 Master 決定時機，未執行時在 implementation_result 標示「live 未驗證」。

## 2. Group B：重疊檔案（依 OD-1 與 0.3）

- [ ] 2.1 LLM Gateway 預設模型：Qwen 的程式預設（含 vision）改為引用單一 Domain Constant `qwen3.5-flash`；解析優先序不變。對應 Requirement：「預設生成模型為單一來源的 qwen3.5-flash」。驗證：五個用途在未設定時都解析為 `qwen3.5-flash`；設定值優先；legacy 別名仍有效；既有 `backend-model-runtime` 測試不放寬。
- [ ] 2.2 LLM Gateway thinking：provider capability 新增 `supportsThinkingControl`（qwen 為 true，其餘為 false），既有的 thinking 控制查詢改為讀 capability；新增全站 thinking 預設設定 `LLM_THINKING_DEFAULT_ENABLED`（只接受 true／false，未設定為 false，格式錯誤拒絕啟動）；支援的 provider 在每個生成請求都明確送出 thinking 值（含 vision、json_object、Tool、provider 重試、Tool 參數修復重送）；不支援的 provider 不送出，明確要求開啟時拒絕啟動；`response_metadata` 記錄實際送出的值。對應 Requirement：「Qwen 生成請求明確送出 thinking 設定且預設關閉」「不新增模型層 fallback，provider 層 fallback 語意不變」。驗證：以 fake fetch 斷言每種請求的 body；優先序（呼叫端 → 入口預設 → 全站 → false）；ccr 與 openai-compatible 不送出；重試與修復重送帶相同值；取消不重試；啟用 provider 層 fallback 時各 provider 依 capability 決定；五個已註冊 graph 各一個 fake provider run，所有生成請求的模型為 `qwen3.5-flash` 且 thinking 為關閉、embedding 與 rerank 模型不變；同一組 fake 回應下 flash 與 qwen3.7-plus 的 Graph 輸出 Schema 相同；「Schema 相同」以 spec「模型切換不改變 Domain Contract」Scenario 為基準，即 Graph 輸出、Tool 輸入輸出、事件與錯誤碼的 Schema 都相同。
- [ ] 2.3 Gun Shop 模型設定：thinking 只接受未設定或 `false`，未設定時有效值為關閉且不受全站預設影響；設定讀取的回傳型別中 thinking 為必填 boolean，未設定時回傳 `false`；`true` 或其他值拒絕啟動，錯誤碼 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`；適用所有模式。對應 Requirement：「Gun Shop thinking 一律關閉並在啟動時驗證」。驗證：回傳型別沒有可選的 thinking 欄位（型別測試或編譯期斷言）；未設定且全站預設為開啟時 Gun Shop 請求仍為關閉；非 demo 模式設定 `true` 拒絕；格式錯誤拒絕；live 評測在建立模型前失敗；`demo-cost-and-access-guard` 的 demo 檢查測試仍通過且未修改。
- [ ] 2.4 kb-eval CLI：生成模型的程式預設改為引用同一 Domain Constant；provenance 新增與 1.3 相同的欄位並使用 1.2 的包裝層；judge 模型與預設不變。對應 Requirement：「評測 provenance 記錄生成模型、thinking 與 endpoint」「評測記錄 provider 實際回報的模型」。驗證：provenance 欄位測試；`--no-judge` 時 judge 欄位語意不變；dataset 驗證失敗仍在建立模型前失敗（不放寬 `harden-kb-evaluation-baseline` 的既有測試）；`cd backend && npx vitest run src/knowledge/evaluation`。

## 3. 整合驗證

- [ ] 3.1 backend 完整驗證：`cd backend && npm run lint && npm run test && npm run build`。如實記錄失敗；若失敗在不含本 Change 的基準上也能重現，附基準比對 evidence；不得刪除或放寬既有 Assertion。
- [ ] 3.2 回滾驗證：把 purpose 專屬模型設定改為 `qwen3.7-plus`，執行 2.2 的五個 graph fake run，斷言所有生成請求模型為 `qwen3.7-plus` 且 thinking 仍明確送出。驗證：測試或命令輸出寫入 evidence。
- [ ] 3.3 （Master 決定時機）以新加坡帳號執行 1.4 的 live probe，保存 evidence。驗證：evidence 含 endpoint 主機、模型、日期與五項結果；未執行時，在 implementation_result 的 `notExecuted` 列出，且不得勾選本項。
- [ ] 3.4 `openspec validate switch-generation-to-qwen35-flash --strict` 通過。

## 4. 交付給下游（不在本 Change 內實作）

- 1B-2：以 flash 重跑 `knowledge:evaluate`、`commerce:evaluate`，發布 qwen3.7-plus 對 qwen3.5-flash 比較，訂定並套用 C1 門檻與 fallback 模型。
- `demo-cost-and-access-guard` 6.4(a)：把 `qwen3.5-flash` 的新加坡核實單價填入 demo 單價表；6.4(c) 在本 Change 完成後勾選。
- 1B-6：以 flash 量測每輪實際 token（E3）。
