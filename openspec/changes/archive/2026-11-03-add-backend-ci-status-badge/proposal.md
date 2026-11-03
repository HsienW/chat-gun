## Why

Repository 目前沒有一條持續驗證 backend 的公開狀態。既有兩個 harness workflow 只驗證 harness 整合，`pull_request` 帶路徑過濾，也不在預設分支 `master_next` 的 push 上執行。因此讀者與審查者無法從 PR 或 README 查到 backend 目前的 lint、測試與 build 狀態。

README 的評測章節列出檢索與流程評測數字，這些數字需要資料庫或模型，預設測試不會重跑。如果只加徽章而不說明範圍，讀者可能誤以為綠色徽章代表這些數字已被 CI 驗證。

## What Changes

- 新增獨立的 Backend CI workflow，在所有 PR、`master_next` 的 push 與手動觸發時，執行 backend 既有的安裝、lint、預設測試與 build。
- 在 README 三個語言版本新增綁定 `master_next` push 結果的原生狀態徽章。
- 在 README 三個語言版本的評測章節各新增一句範圍說明，寫明徽章涵蓋與不涵蓋的內容，包含 frontend 與 BFF 的缺口。
- 不新增 BREAKING 變更。不修改應用程式行為、評測數字、測試或 npm scripts。

## Capabilities

### New Capabilities

- `backend-ci-status`：定義 backend 持續驗證的觸發、失敗傳遞、逾時、取消、最小權限與測試隔離，以及狀態徽章與範圍揭露的語意。

### Modified Capabilities

無。

## Impact

- 受影響能力域：CI 與專案文件展示層。
- 受影響套件：`backend` 只作為被驗證對象，程式不變；`frontend`、`bff` 無變更。
- 新增：`.github/workflows/backend-ci.yml`。
- 修改：`README.md`、`README.en.md`、`README.zh-CN.md`，只新增行。
- 公開 API、事件、錯誤碼、Graph、Schema、Tool 與模型 Provider 均無變更。

## 目標

- PR 上可看到 backend 驗證的真實結果，且失敗不會被轉成成功。
- README 徽章只反映 `master_next` 的 push 結果。
- 讀者能從 README 得知徽章代表什麼、不代表什麼。

## 非目標

- 不驗證 README 的評測數字，也不執行需要資料庫或模型的整合測試與 live 評測。
- 不納入 frontend 與 BFF；Design 建議之後各開獨立 workflow 與徽章。
- 不設定 required status check，不修改 branch protection。
- 不修改 harness workflows、`backend/package.json`、任何測試與 `docs/evaluation.md`。

## 風險

- 乾淨 runner 可能揭露既有的安裝或測試問題。處理方式是保留證據並另行定位，不得放寬 Assertion 或吞掉錯誤。
- 新 workflow 與 harness workflows 在部分 PR 上會重複驗證。本次先確保可信度，成本之後再依量測結果優化。
- 15 分鐘逾時來自單一次成功執行的耗時。若實際耗時明顯上升，可能誤殺正常測試，屆時須依證據調整。
- 新測試若未遵守既有略過條件，可能在 CI 嘗試連線外部服務。Workflow 不注入 secret，這類測試會失敗而不是外洩憑證。

## 回滾

撤回新增的 workflow 與三個 README 的新增行即可，應用程式不受影響。本次未設定 required status check，回滾不需要調整 branch protection。
