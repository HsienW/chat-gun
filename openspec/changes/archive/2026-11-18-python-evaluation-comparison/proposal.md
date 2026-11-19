## Why

chat-gun 的評測（`knowledge:evaluate`、`research:evaluate`）由 TypeScript runner 執行，每次 run 產出 `run-*.json`（逐題結果加上 TS 計算的 `summary`）與 `provenance.json`，比較報告則各自由 TS 產生 Markdown。目前有三個問題：

1. **跨 run 比較沒有工具**。r2 計畫 1B-2 要發布 qwen3.7-plus 與 qwen3.5-flash 的比較，日後也要比較 provider 或 retrieval 設定變更前後的結果。現在只能人工比對多個 Markdown，容易抄錯，也無法檢查兩個 run 是否用同一份資料集。
2. **評測摘要沒有獨立重算**。`summary` 只由產生它的 TS 程式計算，沒有第二套實作交叉驗證；scorer 的錯誤會直接進入對外發布的數字。
3. **專案沒有任何 Python 元件**。評測分析是資料處理工作，適合以 Python 生態（pydantic、pytest）獨立實作，並與 runtime 完全解耦。另一個 Python 專案已完成 research scorer 的移植與一致性驗證，但沒有回到 chat-gun。

## What Changes

- 新增獨立的 Python 評測分析套件，只讀取既有評測產出，不呼叫模型、不連網、不寫入 runtime 資料。
- **Runtime Validation**：以版本化的 pydantic 模型讀取 kb-eval 與 research-eval 的 `run-*.json` 與 `provenance.json`；必要欄位缺失或型別錯誤時明確失敗，未知的新增欄位容許。
- **摘要一致性檢查（parity）**：由逐題結果獨立重算摘要指標，與檔案內 TS 產生的 `summary` 比對；不一致時以非零狀態結束並列出差異。以既有的全部已錄 run 作為回歸基準。
- **跨 run 比較報告**：輸入兩個以上同一資料集版本的 run，輸出 deterministic Markdown 報告，列出各指標數值與差異、provenance（模型、thinking、endpoint 主機等）差異，以及小樣本提醒。
- **CI**：新增 Python job，執行 lint、型別檢查、pytest 與已錄 run 的一致性檢查。

## Capabilities

### New Capabilities

- `python-evaluation-analysis`：Python 評測分析套件的輸入驗證、摘要一致性檢查、跨 run 比較報告、離線與 deterministic 要求，以及 CI 驗證。

### Modified Capabilities

（無。TS 評測 runner、scorer、報告與 `evaluation-model-provenance` 的既有 Requirement 不變；Python 套件只讀取它們的產出。）

## Goals

- 任何已錄的 kb-eval 與 research-eval run，Python 重算的摘要都與 TS `summary` 一致。
- 1B-2 的模型比較報告可由單一命令從 run 目錄產生，並自動拒絕資料集版本不一致的比較。
- Python 元件有自己的測試與 CI，與 runtime 部署無關。

## Non-goals

- 不改 TS 評測 runner、scorer、資料集或既有結果檔。
- 不把評測執行（呼叫模型、Tavily、資料庫）移到 Python；Python 只做離線分析。
- 不涵蓋 commerce chain-eval（結果格式與存放位置不同，另開 Change）。
- 不發布到 Opik，不新增 runtime 服務，不影響部署。
- 不重新執行任何 live 評測；1B-2 的實際重跑不屬於本 Change。

## Impact

- **frontend／bff／backend**：無程式變更。
- **新增**：根目錄下獨立的 Python 套件（原始碼、測試、相依鎖定檔）、一個 GitHub Actions workflow。
- **既有資料**：只讀取 `backend/data/knowledge-eval/results/**` 與 `backend/data/research-eval/results/**`，不修改。

## 相容性

- 不改變任何公開契約、Graph ID、錯誤碼或事件。
- 既有 Node 開發與 CI 流程不變；Python job 獨立執行。
- Python 讀取的 JSON 結構若日後新增欄位，模型容許未知欄位；移除或改名必要欄位會讓 parity 檢查失敗，提醒同步更新。

## Risks

- **兩套實作的語意漂移**：TS scorer 修改後 Python 未同步。以 CI 的 parity 檢查阻擋。
- **浮點誤差**：不同語言的加總順序可能造成極小差異。以明確容許誤差定義一致性，計數類指標要求完全相同。
- **歷史 run 格式差異**：早期 run 可能缺少後來新增的欄位。以「未記錄」呈現，不推測補值。

## 回滾策略

刪除 Python 套件目錄與 workflow 即可；不影響任何 TS 程式、資料或部署。
