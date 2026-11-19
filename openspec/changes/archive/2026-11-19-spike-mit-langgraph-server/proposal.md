## Why

`demo-predeploy-cost-and-packaging` 的部署前 Gate 需要確定 backend 在 demo 主機上以什麼 runtime 執行。部署決策的背景與第三方元件授權結論記錄在該 Change 的私有部署決策紀錄（不進版本控制）；本 Change 只處理一個可公開的技術問題：

**以 MIT 授權的開源套件 `@langchain/langgraph-api`（本機開發的 `langgraphjs dev` 即使用它）自行建置 server 映像，能否在 demo 條件下取代目前規劃的 server 映像？**

已知的技術事實（2026-11-17 讀取 `langchain-ai/langgraphjs` 原始碼 `libs/langgraph-api/src/storage/`）：

1. checkpointer 為 `InMemorySaver`（繼承 `MemorySaver`），thread、run 與 checkpoint 存在記憶體，並以 JSON 寫入 `.langgraph_api/` 目錄。
2. 寫檔在資料變更後約 3 秒以 debounce 方式進行；原始碼中沒有程序結束時的強制寫檔。
3. 只支援單一程序，不使用 Postgres 或 Redis 作為 run 與 checkpoint 的權威儲存。

這些特性與既有規格有潛在衝突：

- `durable-hitl-conversation-recovery` 要求 interrupt 在 process 終止並重啟後，能從實際 checkpoint 恢復。
- `multi-instance-operation` 要求多個 instance 以 Postgres 與 Redis 共享 durable state。

在修改部署規格之前，需要以可重現的證據判斷：demo 條件下（單一主機、單一實例、每日少量訪客）上述衝突的實際影響，以及是否可接受。

## What Changes

- 新增一個以 `@langchain/langgraph-api` 自行建置的 backend server 映像設定，不修改產品程式。
- 以真實 graph、BFF demo 模式與 Redis 帳本，執行五類可重現驗證：正常重啟、異常終止、串流與取消、BFF 與前端相容性、資源用量。
- 產出可行性結論報告：逐項通過／不通過、量測數值、與既有規格的符合與偏離清單，以及給 Master 的建議。
- 本 Change **不修改**任何既有規格或部署 Change；結論由 Master 決定是否據以修改 `demo-predeploy-cost-and-packaging`。

## Capabilities

### New Capabilities

- `self-hosted-runtime-feasibility`：自建開源 server 映像可行性驗證的範圍、證據要求與結論格式。

### Modified Capabilities

（無。）

## Goals

- 以證據回答：自建開源 server 在 demo 條件下是否滿足重啟保留、HITL 恢復、串流與取消、BFF 相容與資源限制。
- 明確列出與 `durable-hitl-conversation-recovery`、`multi-instance-operation` 的偏離及其在 demo 的影響。

## Non-goals

- 不修改 frontend、bff、backend 的產品程式與既有測試。
- 不修改既有規格，不修改 `demo-predeploy-cost-and-packaging`。
- 不實作多實例、Postgres checkpointer 或自訂儲存層。
- 不部署到公開主機。
- 不評估託管部署方案。

## Impact

- **frontend／bff／backend**：無程式變更。
- **新增**：自建 server 的映像設定、驗證腳本與 compose 驗證設定（只用於本機驗證）、結論報告。

## 相容性

不改變任何公開契約、Graph ID、錯誤碼或事件。既有開發流程（`npm run dev`）與 `docker-compose.yml` 不變。

## Risks

- **開源套件定位為開發用途**：可能有未文件化的限制。以驗證項目覆蓋 demo 實際使用路徑。
- **驗證環境與 demo 主機差異**：本機 Docker 與雲主機的檔案系統、記憶體行為可能不同。結論標示驗證環境。

## 回滾策略

刪除新增的映像設定、驗證腳本與報告即可；不影響任何既有程式或規格。
