# Tasks：首頁入口拆分（Gun Chat／Gun Shop）

Primary Implementer：Codex。Secondary Architecture Reviewer：Qwen（plan 模式）。
寫入範圍：`frontend/**` 與本 Change 的 `tasks.md` 勾選；MUST NOT 修改 `backend/**`、`bff/**`、`backend/langgraph.json`、模型設定或其他 Change。

每個 Task 完成後執行：

```bash
cd frontend && npm run lint && npm run test && npm run build
```

## 1. 前置驗證（D4 停止條件）

- [x] 1.1 以測試確認 LangGraph SDK `useStream` 在 `assistantId` 改變時是否保留 thread，並記錄結果（對應 Requirement「入口工作區 MUST 以新 thread 開始並在離開時完整重置」）。
- [x] 1.2 本機 smoke：同一 thread 依序執行 `chatbot` → `deep_researcher` → `chatbot` 各一則訊息，記錄每次的 `threadId`、`runId`、Terminal State 與錯誤（若有）。若任一步失敗或 thread 被替換，MUST 停止並交回 CCR（design D4 停止條件），不得自行改為開新 thread，也不得以特殊分支繞過。
  - 驗證：smoke 紀錄（命令、時間、模型設定、結果）附於 implementation_result；mock 測試不得取代此項。

## 2. 目標 assistant 推導

- [x] 2.1 新增入口型別（`home`、`gun_chat`、`gun_shop`）與集中式目標推導純函式，Graph ID 只引用既有 `AgentId`（Requirement「目標 assistant MUST 只由入口與深度研究開關決定」）。
- [x] 2.2 單元測試：全部組合、`home`／未知值回傳「沒有目標」、輸出不含 `math_agent`／`mcp_agent`（Requirement「介面 MUST NOT 提供 agent 選單或暴露未展示的 graph」）。
  - 驗證：`cd frontend && npm run test`

## 3. 首頁與入口工作區

- [x] 3.1 首頁：logo、首頁產品標題 `Chat Gun AI Agent`、Gun Chat（子標題「Generative AI Agent」）與 Gun Shop（子標題「Shop AI Assistant」）兩個可存取入口；標題、入口名稱與子標題集中定義於單一來源；不顯示輸入框、不建立 thread；瀏覽器頁籤標題維持 `Chat Gun`（Requirement「首頁 MUST 每次進站顯示兩個入口」、`project-identity`「專案 slug 與顯示名稱」）。
- [x] 3.2 入口狀態只存在記憶體，初始為 `home`；不讀寫任何瀏覽器儲存或 URL。
- [x] 3.3 入口工作區：標示目前入口、「回首頁」控制項；每次進入入口以完整重置的方式開始空對話（design D3），限流倒數與身分失敗狀態保留在入口之外。
- [x] 3.4 React 測試：首次進站（含標題 `Chat Gun AI Agent`、兩個入口子標題、不出現舊標題 `ChatGun AI Agent`、頁籤標題仍為 `Chat Gun`）、重新掛載後回到首頁、進入入口為空對話、回首頁清除工作區狀態、限流與身分狀態跨入口保留。
  - 驗證：`cd frontend && npm run lint && npm run test && npm run build`

## 4. 移除 agent 選單與深度研究開關

- [x] 4.1 從輸入列與歡迎畫面移除 agent 下拉選單與「使用 {agent}」說明，改為入口相關說明；`handleSubmit` 與 `InputForm` 的 `onSubmit` 移除 `agentId` 參數，submit 時不再執行 agent 切換重置（design D4）；effort 選單、圖片上傳、run config 與 `reasoning_model` 依推導出的目標 assistant 維持既有行為。
- [x] 4.2 Gun Chat 深度研究開關（預設關閉、可存取名稱、Gun Shop 不顯示、不提供思考模式開關）。
- [x] 4.3 run 進行中、dispatching、等待澄清時鎖定開關；成功、錯誤、逾時、取消後解鎖（Requirement「進行中的 run 與等待澄清時 MUST 鎖定深度研究開關」）。
- [x] 4.4 `onUpdateEvent` 讀取最新目標 assistant，不使用過期閉包（`frontend-chat` MODIFIED）。
- [x] 4.5 React 測試：預設送 `chatbot`、開啟送 `deep_researcher` 並附既有欄位、關閉後送回 `chatbot`、切換開關後送出時先前訊息與其已歸檔 Activity Timeline 仍在且 thread 不變（Scenario「深度研究開關不觸發入口重置」）、訊息內容不影響目標、Gun Shop 送 `shopping_assistant`、畫面無 agent 選單與 `math_agent`／`mcp_agent`、串流中與澄清中鎖定、成功／錯誤／逾時／取消後解鎖且不回到 running。
  - 驗證：`cd frontend && npm run lint && npm run test && npm run build`

## 5. 離開入口與 Gun Shop 審批（T10）

- [x] 5.1 run 進行中或審批決定送出中停用「回首頁」並提示需先取消（Requirement「離開入口 MUST 不中斷進行中的操作且不代替使用者決定審批」）。
- [x] 5.2 Gun Shop 有待審批操作（等待決定或送出失敗）時，回首頁前顯示確認提示；確認後丟棄工作區且不送出 approve／deny／cancel，取消則留在原處且卡片狀態不變。
- [x] 5.3 React 測試：上述各情境，以及從首頁進入 Gun Shop 後既有審批卡片、resume、送出失敗處理與 commerce 卡片行為不變。
  - 驗證：`cd frontend && npm run lint && npm run test && npm run build`

## 6. 頂部模式切換（design D9）

- [x] 6.1 入口工作區左上角（與底部 Setting 上下對應）新增模式切換：觸發按鈕顯示目前模式名稱與箭頭；下拉選單列出 Gun Chat（「Generative AI Agent」）與 Gun Shop（「Shop AI Assistant」），目前模式以勾號標示；名稱與子標題與首頁入口卡片共用同一份定義；沿用既有 UI 元件與深色主題，不新增相依套件；首頁不顯示（Requirement「入口工作區 MUST 在頂部提供模式切換，切換即開啟新 session」）。
- [x] 6.2 切換到另一個模式時走與「回首頁再進入」相同的完整重置路徑（新 thread、清除工作區狀態、深度研究開關回到關閉）；選擇目前模式不做任何事；限流倒數與身分失敗狀態保留。
- [x] 6.3 套用 design D6 的限制：run 進行中或審批送出中不可切換；Gun Shop 有待審批操作時先確認，確認後不送出 approve／deny／cancel，取消則卡片狀態不變。
- [x] 6.4 React 測試（以可存取語意查詢）：顯示目前模式、展開選單只有兩個選項與子標題、勾號與已選取狀態、Escape 關閉並還原焦點、切換後為空對話且下一則訊息為新 thread 與正確 `assistantId`、選擇目前模式不重置、run 中不可切換、待審批時確認與取消、限流與身分狀態保留、首頁不顯示模式切換。
  - 驗證：`cd frontend && npm run lint && npm run test && npm run build`

## 7. 既有回歸與契約確認

- [x] 7.1 將依賴 agent 下拉選單的既有測試（例如 `App.commerce.test.tsx`、`App.stream-activity.test.tsx`、`InputForm.model-selection.test.tsx`）改為經入口與開關操作；不得刪除案例或放寬斷言。
- [x] 7.2 確認 `git diff --stat` 不含 `backend/`、`bff/`、`backend/langgraph.json`、`frontend/index.html` 的頁籤標題、README、`docs/` 或其他 Change；request 欄位與相同目標 assistant 在本 Change 前一致（Requirement「入口拆分 MUST 保留既有跨層契約」）。
- [x] 7.3 本機手動 smoke：首頁 → Gun Chat（關／開深度研究各一則）→ 以頂部模式切換到 Gun Shop（確認為空對話）→ 一則商品查詢 → 回首頁；記錄結果。Gun Shop 審批的錄影 smoke 屬 1A-2，由 Master 執行，不在本 Task 勾選範圍。Master 人工 smoke 與 Codex 補跑一般對話，2026-10-28；工具連線失敗屬 fix-knowledge-egress-in-container。
  - 驗證：`cd frontend && npm run lint && npm run test && npm run build`；如實列出未執行的 live 驗證。
