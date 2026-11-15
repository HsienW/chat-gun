## Why

backend 預設測試套件（`npm run test`）的結果目前取決於開發者本機的 proxy 與 Opik 連通狀況，使所有以「backend 全測全綠」為 Gate 的 Change（例如 demo-cost-and-access-guard 的 2.5、5.6、6.3）都可能被誤判。

已知證據（來自 stream-chat-answer-text 的實作紀錄）：

- backend 的共用 env 模組在載入時執行 dotenv，會把開發者本機的 runtime 設定檔載入 vitest 程序，包括 proxy 與 Opik 設定。
- LLM Gateway 模組在載入時會設定全域 proxy dispatcher（log 為 `network_proxy_configured`），並取得 Opik tracer；當 runtime 設定啟用 Opik 時，測試中的 LLM span 會真的連到 hosted Opik。
- 多個 LLM Gateway 相關測試只 stub provider 相關變數。proxy 或 Opik 慢時，同檔第一個案例以 5000ms 逾時，晚到的呼叫再讓下一個案例的 fetch 次數（1→2）與入帳金額（7→21）出錯。同一組檔案單獨跑兩次，一次 4 失敗、一次 55/55 通過。

既有 `backend-test-baseline` 規格已要求預設套件 hermetic，但只涵蓋 runtime 資料庫設定；proxy、Opik 匯出與 runtime 設定檔載入本身尚未被規範，也沒有自動化手段保證。

## What Changes

- 預設測試程序不再載入開發者本機的 runtime 設定檔；改為載入一份納入版本控制、不含任何 Secret 的測試 fixture，並以可斷言的來源標記證明實際載入的是 fixture。
- 預設測試程序在程序層級停用 proxy（清空所有 proxy 相關環境變數）並停用 Opik 匯出，覆蓋開發者 shell 中既有的同名設定；個別測試仍可用既有 `vi.stubEnv` 明確開啟以驗證對應行為。
- 新增專用的 live 測試設定：保留既有 runtime 設定檔載入與 proxy 行為，只供 opt-in live 測試使用；Opik live smoke 的 npm script 改用此設定。
- 預設設定下若啟用 live opt-in 旗標，live 測試因缺設定而明確失敗，不得暗中改讀本機 runtime 設定檔。
- 新增自動化 hermetic 守門測試，並以「shell 中 proxy 指向不可達位址＋Opik 啟用」的環境矩陣驗證預設套件結果不變。

不修改 production runtime 行為：env 模組、proxy 設定與 Opik tracer 的 runtime 語意維持不變。

## Capabilities

### New Capabilities

（無）

### Modified Capabilities

- `backend-test-baseline`：新增「預設測試程序不載入 runtime 設定檔」「預設測試程序停用 proxy 與 Opik 匯出」「live 測試使用專用設定」三項 Requirement。

## Impact

- 受影響套件：backend（僅測試設定、測試 fixture、hermetic 守門測試與 `eval:opik` npm script）。frontend、bff 不變。
- 受影響能力域：backend 測試基準、Opik live smoke 執行方式。
- 公開 API、事件、錯誤碼、Graph ID、BFF Route：不變。
- 與 demo-cost-and-access-guard 重疊：`backend/package.json`（不同 hunk）、該 Change 未提交的 LLM Gateway 測試檔（只被執行、不被修改）；提交順序見 design。

## Goals

- 同一 commit、同一組測試檔，在「本機 runtime 設定檔存在與否」「shell 中 proxy／Opik 設定存在與否」的所有組合下，預設套件的 passed／failed／skipped 數相同。
- Opik live smoke 仍可以明確 opt-in 的方式在真實環境執行。

## Non-Goals

- 不改變 production 的 dotenv 載入、proxy 或 Opik tracer 行為。
- 不修改 demo-cost-and-access-guard 或其他 Change 的測試檔內容。
- 不修正與環境洩漏無關的既有測試失敗（例如 tool-dispatch 錯誤碼），也不放寬任何斷言。
- 不新增全域網路出口封鎖（network egress deny）；列為後續建議。

## Risks

- 若有既有測試暗中依賴本機 runtime 設定檔中的值，切換後會失敗。處置：以失敗清單逐一確認，改為在測試內明確 stub，不得恢復載入本機設定檔，也不得放寬斷言。
- 開發者若以預設設定執行 live 測試，會看到缺設定失敗而非過去的「碰巧可跑」。處置：失敗訊息與 live 設定檔頭註解指出正確命令。

## Rollback

移除新增的測試設定、fixture 與守門測試，並把 `eval:opik` script 還原，即恢復原行為；不涉及資料遷移或 production 行為。
