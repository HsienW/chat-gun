# Proposal：首頁入口拆分（Gun Chat／Gun Shop）

## Why

### 問題

- 目前前端只有一個聊天介面，以 agent 下拉選單（`selectedAgentId`）讓使用者在 `deep_researcher`、`chatbot`、`math_agent`、`mcp_agent`、`shopping_assistant` 五個 graph 間切換。對面試官或一般訪客而言，「選 graph」是內部概念，無法一眼看出產品能做什麼。
- 下拉選單把 `math_agent`、`mcp_agent` 直接暴露在介面上，與 `second-stage-plan-en-v7-r2.md` §2 決定的展示範圍（只展示 `chatbot`、`deep_researcher`、`shopping_assistant`）不一致。
- 深度研究目前是「選一個 agent」，而不是「這則訊息要不要做深度研究」的明確使用者選擇；計畫要求深度研究只在使用者明確開啟時才執行，且不做任何模型或關鍵字分流。
- 現行首頁標題 `ChatGun AI Agent` 既不符合 `project-identity` 的顯示名稱，也不是 Master 決定的產品標題。

### 背景

本 Change 對應 `second-stage-plan-en-v7-r2.md` Chapter 1A 步驟 1A-1（本機、最快更新履歷的版本）。Chapter 1A 維持現有模型設定（鏈路 qwen3.7-plus、檢索評測 qwen-plus）與現有評測數字，不改模型、不部署；伺服器端的 graph 開放控制、成本防護與思考模式開關屬於 Chapter 2（`demo-cost-and-access-guard`），不在本 Change。

## What Changes

### 目標

1. 首頁保留 logo，標題為 **Chat Gun AI Agent**，下方提供兩個入口卡片：
   - **Gun Chat**（子標題「Generative AI Agent」）：一般 AI 對話。
   - **Gun Shop**（子標題「Shop AI Assistant」）：本地生活助手，提供商品查詢、政策問答與需審批的訂單流程，對應既有 `shopping_assistant` graph。
2. Gun Chat 提供「深度研究」開關：開啟時該則訊息送往 `deep_researcher`，關閉時送往 `chatbot`。開關只影響下一則送出的訊息，同一 thread 延續。由使用者明確切換，不做任何模型、關鍵字或規則分流。
3. 從介面移除 agent 下拉選單；`math_agent`、`mcp_agent` 不再出現在介面。
4. 每次進站都顯示首頁兩個入口，不記住上次的入口選擇或開關狀態。
5. 明確定義切換入口、切換深度研究開關時的 thread 行為，以及串流中、取消中、等待澄清或審批時的互動限制。離開 Gun Shop 時若有待審批操作，先顯示確認提示；前端不得自動送出 approve／deny／cancel。
6. 入口工作區頂部（左上角，與底部 Setting 按鈕上下對應）新增「模式切換」：顯示目前模式名稱，點開為下拉選單，列出 Gun Chat（子標題「Generative AI Agent」）與 Gun Shop（子標題「Shop AI Assistant」），目前模式以勾號標示；版面參考 Codex 的模式選單（名稱加子標題、勾號標示目前選項）。切換到另一個模式等同開啟新 session：不保留先前的對話內容，從空對話與新 thread 開始。
7. 修改 `project-identity`：區分「專案顯示名稱」（維持 `Chat Gun`）與「前端首頁產品標題」（`Chat Gun AI Agent`），消除首頁標題與既有 spec 的衝突。

### 非目標

- 不修改 backend、BFF、`backend/langgraph.json`、Graph ID、BFF Route、事件、錯誤碼或 request payload shape。
- 不修改模型設定，不切換 qwen3.5-flash（Chapter 1B）。
- 不提供 Gun Chat 思考模式開關（計畫 B12 允許，但延後）。
- 不做伺服器端 graph 開放控制、存取碼、每日預算或限流變更（Chapter 2 `demo-cost-and-access-guard`）。
- 不新增 URL 路由、不持久化入口選擇、不新增前端相依套件。
- 不做圖片推薦（計畫 A4：與首頁拆分為不同 Change）。
- 不更名專案：slug `chat-gun`、顯示名稱 `Chat Gun`、瀏覽器頁籤標題、README、docs、package、User-Agent、MCP client、Observability 與 Docker image 命名都不變。
- 不打 release tag。本 Change 屬 Chapter 1A，對應版本 `v2.0.0-rc.1`；tag 由 Master 執行（見「版本」）。

## Capabilities

### New Capabilities

- `frontend-entry-navigation`：首頁入口、入口工作區、頂部模式切換、深度研究開關、目標 assistant 決定方式、thread 生命週期與互動鎖定規則。

### Modified Capabilities

- `frontend-chat`：`Chat callbacks MUST be stable without stale state` 中以 `selectedAgentId` 描述的 Scenario 改為以「目前目標 assistant」描述，語意（不得讀到過期值）不變。
- `project-identity`：`專案 slug 與顯示名稱` 新增「前端首頁產品標題 `Chat Gun AI Agent`」與入口名稱、子標題的定義，並把「顯示名稱一致」Scenario 的適用範圍明確限定為瀏覽器頁籤標題、專案文件與首頁產品標題以外的使用者可見專案名稱。

`frontend-model-selection` 不需修改：模型選單、`reasoning_model` 欄位與取消行為維持原狀；本 Change 只改變「何時送往 `deep_researcher`」的使用者控制方式。

## Impact

### 受影響套件

| 套件 | 影響 |
| --- | --- |
| frontend | 首頁標題與入口、入口工作區、深度研究開關、移除 agent 下拉選單、相關測試 |
| bff | 無 |
| backend | 無 |

### 受影響能力域

- 前端聊天介面與互動狀態（frontend-chat）。
- 前端入口導覽（新）。
- 專案識別（project-identity）：只新增首頁產品標題與入口名稱；既有 slug、顯示名稱與其他識別 token 不變。
- 既有 Gun Shop 審批卡片（T10，`commerce-assistant-and-approved-side-effects`）的前端呈現：行為不變，只新增「離開入口」的互動規則。

### 首頁標題的影響範圍

已檢查 README（三語）、`docs/` 架構文件、`frontend/index.html`、`openspec/specs/**` 中 `Chat Gun` 與 `ChatGun` 的出現位置：

| 位置 | 現況 | 本 Change 處理 |
| --- | --- | --- |
| 首頁標題（歡迎畫面） | `ChatGun AI Agent` | 改為 `Chat Gun AI Agent` |
| 瀏覽器頁籤標題 | `Chat Gun` | 不變（仍受 `project-identity` 約束） |
| README、README.en、README.zh-CN、`docs/*.md` | 以 `Chat Gun` 指稱專案 | 不變；屬專案顯示名稱，不是首頁標題 |
| `harness-*` specs | 以 `Chat Gun` 指稱 consumer 專案 | 不變 |
| logo SVG 內部 `<title>`（`ChatGun Agent Paper Plane Logo`） | 不作為頁面可見文字 | 不變；列為後續建議 |
| README 截圖（`assets/chat-gun-demo.webp`） | 舊介面 | 不在本 Change；由 1A-3 README 更新處理 |

### 公開契約

不變：Graph ID（`chatbot`、`deep_researcher`、`shopping_assistant`、`math_agent`、`mcp_agent` 仍存在於 backend）、BFF Route、Runtime Event、錯誤碼、Terminal State、`reasoning_model` 等 request 欄位。

## 風險

| 風險 | 說明 | 緩解 |
| --- | --- | --- |
| 同一 thread 混用 `chatbot` 與 `deep_researcher` | 深度研究開關只改下一則訊息的目標 assistant，thread 不變；兩個 graph 的 state 欄位不同，若 Runtime 不接受跨 graph 延續，第二則訊息可能失敗 | Tasks 先以測試與本機 smoke 確認；若不相容，Codex 停止並交回 CCR，由 CCR 與 Master 重新決定，不得自行改變 thread 行為或以特殊分支繞過 |
| 只在 UI 隱藏 `math_agent`、`mcp_agent` | 直接呼叫 BFF 仍可使用這兩個 graph | 本 Change 明確不承擔權限控制；伺服器端開放控制屬 Chapter 2，proposal 與 README 不得宣稱已關閉 |
| 離開 Gun Shop 時有待審批操作 | 審批卡片不會帶到新 thread | 離開前確認提示；前端不自動送出審批決定；伺服器端審批依既有逾時語意處理 |
| 首頁標題與專案名稱不同 | 訪客會看到首頁的 `Chat Gun AI Agent` 與頁籤、README 的 `Chat Gun` | `project-identity` 明確定義兩者分工；README 是否補充說明由 1A-3 決定 |
| 既有測試依賴下拉選單或舊標題 | `App.*.test.tsx` 可能以下拉選單選 agent | 改為經入口與開關操作，不得放寬原本的斷言 |

## 回滾策略

本 Change 只改 frontend 與 OpenSpec，無資料遷移、無跨層契約變更。回滾方式為 revert 本 Change 的 frontend commit，即恢復原本的 agent 下拉選單介面與首頁標題；backend、BFF 與既有 thread 不受影響。若已 archive，`project-identity` 的 MODIFIED 需以另一個 Change 還原。

## Master 決定紀錄（2026-10-28）

| 項目 | 決定 |
| --- | --- |
| 深度研究開關與 thread | 開關只影響下一則訊息，同一 thread 延續（design D4） |
| 離開 Gun Shop 時有待審批操作 | 顯示確認提示，確認後才離開；取消則留在原工作區、卡片狀態不變；前端不得自動送出 approve／deny／cancel（design D6） |
| 模式切換（2026-10-28 追加） | 入口工作區左上角顯示目前模式與下拉選單（Gun Chat／Gun Shop，含子標題與勾號）；切換模式即開啟新 session，不保留先前對話（design D9） |
| 首頁標題與入口子標題 | 標題 `Chat Gun AI Agent`；Gun Chat 子標題「Generative AI Agent」，Gun Shop 子標題「Shop AI Assistant」；瀏覽器頁籤標題仍為 `Chat Gun`（design D8） |
| 版本號 | 見下節 |

## 版本

GitHub 已有依 v6 計畫的舊 release，新版本進大版本並使用 `-rc` tag：

| 階段 | 版本 tag |
| --- | --- |
| Chapter 1A（本 Change 所屬） | `v2.0.0-rc.1` |
| Chapter 1B（模型切換與量測） | `v2.0.0-rc.2` |
| Chapter 2 D5 部署 | `v2.0.0` |

本 Change 不打 tag；`v2.0.0-rc.1` 由 Master 在 Chapter 1A 完成後執行。
