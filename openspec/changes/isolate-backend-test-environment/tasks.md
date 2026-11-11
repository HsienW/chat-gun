## 0. 前置

- [x] 0.1 記錄切換前基準：在乾淨 shell（未設定 proxy 與 Opik 變數）於 HEAD 工作樹執行 `cd backend && npx vitest run --reporter=json --outputFile=<scratch>/before.json`，保存測試檔數、案例數與 passed／failed／skipped 數。驗證：evidence 記錄命令、exit code 與計數；只記錄變數名稱與「已設定／未設定／空字串」狀態，不記錄任何值。不得讀取 `backend/.env`。

## 1. 預設測試程序隔離 runtime 設定檔

- [x] 1.1 新增測試 fixture（只含來源標記，不含 Secret），確認未被 `.gitignore` 忽略。對應 Requirement：「預設測試程序 MUST NOT 載入開發者本機 runtime 設定檔」。驗證：`git check-ignore -v backend/test-support/hermetic-dotenv.txt` 無輸出（exit 1）。
- [x] 1.2 新增預設 vitest 設定，以 `test.env` 設定 dotenv 來源為 fixture；不改變 include／exclude、pool、timeout。對應同上 Requirement。驗證：乾淨 shell 下 `cd backend && npx vitest run --reporter=json` 的測試檔數與案例數與 0.1 相同。

## 2. 預設測試程序停用 proxy 與 Opik

- [x] 2.1 在同一 `test.env` 中清空四個 proxy 變數與 `NODE_USE_ENV_PROXY`，並設定 `OPIK_ENABLED=false`。對應 Requirement：「預設測試程序 MUST 停用 proxy 與 Opik 匯出」。驗證：見 2.2。
- [x] 2.2 新增 hermetic 守門測試：來源標記、proxy 變數、`OPIK_ENABLED`、import LLM Gateway 後無 `network_proxy_configured`、預設 tracer 為 Noop；並以 `vi.stubEnv` 證明個別測試明確設定仍生效、結束後還原。對應兩項 Requirement 的守門與明確設定 Scenario。驗證：`cd backend && npx vitest run <守門測試路徑>` 通過；暫時移除 `test.env` 後同命令失敗、還原後通過（記錄兩次結果，暫時修改不得保留）。

## 3. 環境矩陣與逾時連鎖回歸

- [x] 3.1 在 shell 設定 `HTTPS_PROXY=http://127.0.0.1:9`、`HTTP_PROXY=http://127.0.0.1:9`、`OPIK_ENABLED=true` 與假的 Opik 認證變數（值為不具效力的測試字串，不記入 evidence），對 `src/platform/llm-gateway-fallback.test.ts`、`src/platform/llm-gateway.test.ts`，以及工作樹中若存在的 `src/platform/llm-gateway.usage.test.ts`、`src/agents/usage-attribution.integration.test.ts` 連續執行兩次 `npx vitest run <檔案...>`。對應 Scenario：「外部服務緩慢時不產生逾時連鎖」「shell 中 proxy 指向不可達位址」「shell 中 Opik 啟用」。驗證：兩次全數通過且案例數、passed 數相同；evidence 記錄實際存在的檔案清單。
- [ ] 3.2 backend 完整驗證，兩種 shell 狀態各一次：(a) 乾淨 shell；(b) 3.1 的 proxy／Opik 設定。命令：`cd backend && npm run lint && npm run test && npm run build`。對應 Requirement：「預設測試程序 MUST NOT 載入開發者本機 runtime 設定檔」的「結果相同」Scenario。驗證：(a)(b) 的 passed／failed／skipped 數相同；skip 的 suite 名稱列入 evidence。與環境無關的既有失敗（例如 tool-dispatch 錯誤碼）如仍存在，MUST 如實列出並證明在 HEAD 基準可重現，不得放寬斷言或刪除測試。
- [x] 3.3 若切換後出現 0.1 沒有的失敗，逐一定位為「暗中依賴 runtime 設定檔」的測試，改為測試內明確 stub。對應 Scenario：「修正不得放寬斷言」（既有 Requirement）。驗證：diff 中無斷言預期值被放寬或刪除；新增失敗超過 5 個 suite 時停止並回報 CCR。

## 4. 專用 live 設定與 Opik live smoke

- [x] 4.1 新增 live vitest 設定（只收集 `*.live.test.ts` 與 `*.live-smoke.test.ts`，保留 runtime 設定檔與 proxy 行為），並只修改 `backend/package.json` 的 `scripts.eval:opik` 改用該設定。對應 Requirement：「live 測試 MUST 使用專用 live 測試設定執行」。驗證：`git diff -- backend/package.json` 中屬於本 Change 的 hunk 只有 `eval:opik` 一行；`cd backend && npx vitest list --config vitest.live.config.ts` 只列出 live 測試檔。
- [x] 4.2 未啟用 opt-in 時以 live 設定執行 `npm run eval:opik`。對應 Scenario：「以 live 設定執行但未啟用 opt-in」。驗證：exit 0、該 suite 為 skipped，evidence 記錄 suite 名稱與原因。
- [x] 4.3 在乾淨 shell 設定 `RUN_OPIK_EVALUATION=true` 後以預設設定執行 `npx vitest run src/evaluation/opik/experiment.live-smoke.test.ts`。對應 Scenario：「以預設設定啟用 live opt-in」。驗證：測試失敗且訊息列出缺少的設定名稱；確認失敗訊息未包含任何設定值。
- [ ] 4.4 Opik live smoke 真實執行（以 live 設定、opt-in 啟用、真實環境）。對應 Scenario：「以 live 設定執行 Opik live smoke 且環境可用」「live 執行逾時」。驗證：由 Master 或具備環境者執行 `cd backend && npm run eval:opik`（opt-in 旗標於 shell 或 runtime 設定檔提供）並保存結果；環境不可用時本項 MUST 記為「未執行」並列於 implementation_result 的 `notExecuted`，不得以 mock 代替，也不阻擋 1–3 的預設 Gate 判定。

## 5. 交付

- [x] 5.1 implementation_result 列出新增與修改的檔案、0.1／3.2 計數對照、3.1 兩次結果、4.x 結果與未執行項目，並附提交建議：只暫存本 Change 的新增檔案與 `eval:opik` hunk，不暫存其他 Change 的修改（見 design「提交順序」）。驗證：`openspec validate isolate-backend-test-environment --strict` 通過；`git status --short` 中本 Change 以外的修改維持原狀。

## handoff-apply-change-002 實作驗證紀錄

- 由 CCR 以 `implementation_secondary` 承接（Master 授權 auth-isolate-backend-test-environment-apply-001），完整命令與計數見 implementation-result-apply-change-002 及其 evidence。
- 3.2 保留未勾選：乾淨 shell 第 2 次與敵意 shell 的計數相同（2379 passed、0 failed、118 skipped），但乾淨 shell 第 1 次因 `llm-gateway-fallback.test.ts` 第一個案例在全套件負載下冷啟動 import 超過 5000ms 逾時而失敗 2 個案例。此不穩定與環境洩漏無關，修正需變更該測試檔（不在本 Change 範圍與授權內），交 CCR 仲裁。
- 4.4 保留未勾選：Opik live smoke 真實執行未進行，需 Master 環境。
- 未刪除或放寬任何既有斷言；未修改其他 Change 的工作樹修改。