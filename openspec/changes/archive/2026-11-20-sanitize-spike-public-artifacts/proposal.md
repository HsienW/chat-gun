## Why

已封存的 `spike-mit-langgraph-server` 把自建 runtime 的建置設定與全部驗證工具放在 `deploy/self-hosted-runtime/`，並推送到公開 repository 的 `master_next`。唯讀稽核（2026-11-20）確認目錄不含 secret、個資、受限授權元件或私有部署決策，但有一批只對內部開發流程有意義的內容公開在外：

1. 說明文件描述 Git 忽略的本機私有設定檔的路徑、內容類別與使用方式，以及本機續作命令。
2. 說明文件與 17 支驗證腳本包含內部 agent 工作流程細節（Handoff 編號、CurrentState guard、角色與 owner、仲裁輪次、本機 Runtime Artifact 路徑）。這些腳本需要私有的本機狀態才能執行，對外部讀者沒有重現價值。
3. 驗證腳本、測試與 compose overlay 屬一次性 spike 工具，放在 `deploy/` 下容易被誤認為正式部署設定。

同時，進行中的 `demo-predeploy-cost-and-packaging` 沿用此目錄的映像建置方式與啟動入口，因此不能整個刪除目錄。

## What Changes

- 保留下游部署需要的映像建置與啟動檔案。
- 將目錄說明文件改寫為對外版本：只描述建置、啟動、套件版本與授權、設定注入方式，不含私有設定檔描述、本機續作命令或內部工作流程。
- 從版本控制移除 spike 專用的驗證腳本、測試、compose 與 overlay 設定；歷史版本保留在原 commit，不改寫 Git 歷史。
- 調整已封存 spike 的 findings 中指向已移除工具的重現段落，改為引用原 commit。
- 主規格 `self-hosted-runtime-feasibility` 新增「公開保存的 runtime 產出只含可對外內容」的 Requirement。

## Capabilities

### New Capabilities

（無。）

### Modified Capabilities

- `self-hosted-runtime-feasibility`：新增公開產出內容邊界的 Requirement。

## Goals

- 公開目錄只留下游部署會用到的建置與啟動檔案，以及對外說明文件。
- 對外說明文件與保留檔案不含內部 agent 工作流程字樣、本機 Runtime Artifact 路徑或私有設定檔描述。
- 不破壞 `demo-predeploy-cost-and-packaging` 依賴的映像建置與啟動入口。

## Non-goals

- 不改寫 Git 歷史，不強制推送；舊內容仍保留在既有 commit。
- 不輪換任何 secret；稽核未發現已提交的 secret。
- 不修改主規格、已封存 Change 或其他 Change 中已記錄的產品已知缺口描述；產品缺口的修正由獨立產品 Change 處理。
- 不修改 `demo-predeploy-cost-and-packaging` 的任何檔案；需要的文字調整由該 Change 的負責人處理。
- 不修改 frontend、bff、backend 程式與測試。
- 不清理本機 Git 忽略的檔案或 Runtime Artifact。

## Impact

- **frontend／bff／backend**：無變更。
- **deploy/self-hosted-runtime**：移除 spike 驗證工具，改寫說明文件；建置與啟動檔案內容不變。
- **OpenSpec**：主規格 `self-hosted-runtime-feasibility` 新增一個 Requirement；已封存 spike 的 findings 重現段落改為引用原 commit。
- **協調**：`demo-predeploy-cost-and-packaging` tasks 5.1「不修改該目錄既有驗證工具」的前提將失效，需由該 Change 負責人更新文字。

## 相容性

不改變任何公開 API、Graph ID、事件、錯誤碼或 BFF Route。映像建置與啟動命令維持不變；下游部署 Change 沿用的檔案保持原內容。

## Risks

- **下游依賴遺漏**：若 `demo-predeploy-cost-and-packaging` 實作時依賴了被移除的檔案，會缺檔。以搜尋確認下游只引用保留的檔案，並在交接中通知負責人。
- **重現性下降**：移除後無法從目前 tree 重跑 spike 驗證。以原 commit 保留完整工具，findings 改為引用該 commit。
- **舊內容仍可從歷史取得**：本 Change 只處理目前 tree；若需完全移除，須另行決定是否改寫歷史。

## 回滾策略

以 `git revert` 還原本 Change 的 commit 即可恢復全部檔案；不涉及資料或執行中服務。
