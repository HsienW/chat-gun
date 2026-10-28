## ADDED Requirements

### Requirement: 首頁 MUST 每次進站顯示兩個入口

前端 MUST 在每次載入頁面時顯示首頁，首頁 MUST 包含 logo、首頁產品標題與 **Gun Chat**、**Gun Shop** 兩個入口，且 MUST NOT 記住上次選擇的入口或深度研究開關狀態。

#### Scenario: 首次進站

- **GIVEN** 使用者第一次開啟前端頁面
- **WHEN** 頁面載入完成
- **THEN** 畫面 MUST 顯示 logo 與首頁產品標題 `Chat Gun AI Agent`（依 `project-identity`）
- **AND** 畫面 MUST 顯示可用鍵盤操作、具可存取名稱的 Gun Chat 與 Gun Shop 兩個入口
- **AND** Gun Chat 入口的子標題 MUST 為「Generative AI Agent」，Gun Shop 入口的子標題 MUST 為「Shop AI Assistant」
- **AND** 畫面 MUST NOT 出現舊標題 `ChatGun AI Agent`
- **AND** 首頁 MUST NOT 顯示訊息輸入框，也 MUST NOT 建立 thread 或送出任何 run

#### Scenario: 進入入口後重新載入

- **GIVEN** 使用者已進入 Gun Shop，或已在 Gun Chat 開啟深度研究開關
- **WHEN** 使用者重新載入頁面
- **THEN** 畫面 MUST 回到首頁並顯示兩個入口
- **AND** 前端 MUST NOT 從 `localStorage`、`sessionStorage`、cookie 或 URL 還原入口或開關狀態

#### Scenario: Gun Shop 入口說明

- **GIVEN** 首頁已顯示
- **WHEN** 使用者檢視 Gun Shop 入口
- **THEN** 入口說明 MUST 表達其為本地生活助手，涵蓋商品查詢、政策問答與需審批的訂單流程

---

### Requirement: 目標 assistant MUST 只由入口與深度研究開關決定

前端 MUST 以單一集中定義的推導規則，從目前入口與深度研究開關決定送出的 `assistantId`；MUST NOT 使用模型輸出、訊息內容、關鍵字或任何規則自動分流。

#### Scenario: Gun Chat 預設送往 chatbot

- **GIVEN** 使用者剛從首頁進入 Gun Chat
- **WHEN** 使用者在深度研究開關為關閉（預設）時送出訊息
- **THEN** 該次 run 的 `assistantId` MUST 為 `chatbot`
- **AND** request MUST NOT 附帶深度研究專用的 run config 或 `reasoning_model`

#### Scenario: Gun Chat 開啟深度研究

- **GIVEN** 使用者在 Gun Chat 且沒有進行中的 run
- **WHEN** 使用者開啟深度研究開關後送出訊息
- **THEN** 該次 run 的 `assistantId` MUST 為 `deep_researcher`
- **AND** request MUST 沿用既有欄位附帶 run config 與 `reasoning_model`，payload shape 與本 Change 前相同

#### Scenario: Gun Chat 關閉深度研究

- **GIVEN** 使用者在 Gun Chat，上一則訊息以 `deep_researcher` 執行且已進入 Terminal State
- **WHEN** 使用者關閉深度研究開關後送出下一則訊息
- **THEN** 該次 run 的 `assistantId` MUST 為 `chatbot`

#### Scenario: 訊息內容不影響目標

- **GIVEN** 使用者在 Gun Chat 且深度研究開關為關閉
- **WHEN** 使用者送出含有「研究」「深入分析」或購物相關字詞的訊息
- **THEN** 該次 run 的 `assistantId` MUST 仍為 `chatbot`

#### Scenario: Gun Shop 送往 shopping_assistant

- **GIVEN** 使用者在 Gun Shop
- **WHEN** 使用者送出訊息
- **THEN** 該次 run 的 `assistantId` MUST 為 `shopping_assistant`
- **AND** Gun Shop MUST NOT 顯示深度研究開關或思考模式開關

#### Scenario: 無有效入口時不得送出

- **GIVEN** 推導規則收到 `home` 或未知的入口值
- **WHEN** 前端嘗試決定目標 assistant
- **THEN** 推導結果 MUST 表示沒有目標
- **AND** 前端 MUST NOT 送出 run，也 MUST NOT 退回任何預設 graph

---

### Requirement: 介面 MUST NOT 提供 agent 選單或暴露未展示的 graph

前端 MUST 移除 agent 下拉選單，且任何介面路徑 MUST NOT 讓使用者選擇或送往 `math_agent`、`mcp_agent`；此隱藏 MUST NOT 被描述為伺服器端權限控制。

#### Scenario: 輸入列不含 agent 選單

- **GIVEN** 使用者在 Gun Chat 或 Gun Shop
- **WHEN** 使用者檢視輸入列與工作區
- **THEN** 畫面 MUST NOT 出現可選擇 agent 或 graph 的控制項
- **AND** 畫面 MUST NOT 出現 `math_agent`、`mcp_agent` 或其顯示名稱

#### Scenario: 推導規則的輸出範圍

- **WHEN** 對所有入口與開關組合執行目標推導
- **THEN** 輸出 MUST 只會是 `chatbot`、`deep_researcher`、`shopping_assistant` 或「沒有目標」

#### Scenario: 隱藏不等於停用

- **GIVEN** 本 Change 已完成
- **WHEN** 檢視本 Change 產出的 UI 文案與文件
- **THEN** 內容 MUST NOT 宣稱 `math_agent` 或 `mcp_agent` 已在伺服器端停用

---

### Requirement: 入口工作區 MUST 以新 thread 開始並在離開時完整重置

每次從首頁進入入口時，前端 MUST 從空對話開始；回到首頁時，前端 MUST 完整丟棄該工作區的前端對話狀態，且 MUST NOT 刪除伺服器端 thread。

#### Scenario: 進入入口為空對話

- **GIVEN** 使用者先前在 Gun Chat 已有對話並回到首頁
- **WHEN** 使用者再次進入 Gun Chat 或改進入 Gun Shop
- **THEN** 工作區 MUST 顯示空對話
- **AND** 第一則訊息 MUST 在新 thread 上執行，而非延續先前 thread

#### Scenario: 回首頁清除工作區狀態

- **GIVEN** 使用者在入口工作區且沒有進行中的 run
- **WHEN** 使用者選擇回首頁
- **THEN** 訊息、Activity Timeline、本機錯誤或取消訊息、澄清狀態、commerce 卡片與審批送出狀態 MUST 全部清除
- **AND** 深度研究開關 MUST 回到關閉

#### Scenario: 限流與身分狀態跨入口保留

- **GIVEN** 前端正在顯示限流倒數或身分失敗狀態
- **WHEN** 使用者回首頁並進入另一個入口
- **THEN** 限流倒數與身分失敗狀態 MUST 保留，直到依既有規則結束
- **AND** 限流期間 MUST NOT 因切換入口而允許送出

#### Scenario: 深度研究開關不重置 thread

- **GIVEN** 使用者在 Gun Chat 已以 `chatbot` 完成一則對話
- **WHEN** 使用者開啟深度研究開關並送出下一則訊息
- **THEN** 既有訊息 MUST 保留在畫面上
- **AND** 先前訊息已歸檔的 Activity Timeline MUST 維持可用
- **AND** 該則訊息 MUST 在同一 thread 上以 `deep_researcher` 執行

#### Scenario: 深度研究開關不觸發入口重置

- **GIVEN** 使用者在 Gun Chat 已有對話，且先前訊息有已歸檔的 Activity Timeline
- **WHEN** 使用者切換深度研究開關（開或關）並送出下一則訊息
- **THEN** 前端 MUST NOT 執行回首頁或切換模式時使用的工作區重置
- **AND** 先前訊息、已歸檔的 Activity Timeline 與 thread MUST 不被清除
- **AND** 只有新 run 的即時活動狀態 MUST 依既有 `frontend-chat` 規則重新開始

---

### Requirement: 進行中的 run 與等待澄清時 MUST 鎖定深度研究開關

run 進行中或等待澄清回覆時，深度研究開關 MUST 不可切換；run 進入 Terminal State 後 MUST 解鎖。

#### Scenario: 串流中切換

- **GIVEN** Gun Chat 有一個進行中的 run
- **WHEN** 使用者嘗試切換深度研究開關
- **THEN** 開關 MUST 為不可操作狀態並提供可存取的說明
- **AND** 進行中 run 的 `assistantId`、活動與晚到事件處理 MUST NOT 受影響

#### Scenario: 等待澄清時切換

- **GIVEN** Gun Chat 正在等待澄清回覆
- **WHEN** 使用者嘗試切換深度研究開關
- **THEN** 開關 MUST 為不可操作狀態
- **AND** 澄清 resume MUST 送往原本建立該 interrupt 的 assistant

#### Scenario: 成功完成後解鎖

- **GIVEN** Gun Chat 的 run 成功完成
- **WHEN** Terminal State 確立
- **THEN** 深度研究開關 MUST 可再次切換
- **AND** 活動狀態 MUST NOT 回到 running

#### Scenario: 失敗或逾時後解鎖

- **GIVEN** Gun Chat 的 run 以錯誤或逾時（例如 `bff_timeout`、`upstream_timeout`）結束
- **WHEN** 前端依既有規則顯示錯誤
- **THEN** 深度研究開關 MUST 可再次切換
- **AND** 逾時 MUST 仍呈現為錯誤 Terminal State，而非成功

#### Scenario: 使用者取消後解鎖

- **GIVEN** Gun Chat 的 run 進行中
- **WHEN** 使用者以既有取消按鈕取消
- **THEN** 前端 MUST 沿用既有取消契約送出取消並保留取消訊息
- **AND** 深度研究開關 MUST 可再次切換，晚到事件 MUST NOT 讓狀態回到 running

---

### Requirement: 離開入口 MUST 不中斷進行中的操作且不代替使用者決定審批

前端 MUST 在 run 進行中或審批決定送出中禁止回首頁；Gun Shop 有待審批操作時，MUST 先取得使用者確認才離開，且 MUST NOT 自動送出任何審批決定或取消。

#### Scenario: run 進行中嘗試回首頁

- **GIVEN** 任一入口有進行中的 run
- **WHEN** 使用者嘗試回首頁
- **THEN** 回首頁控制項 MUST 為不可操作狀態並提示需先取消
- **AND** 進行中的 run MUST 不受影響

#### Scenario: 審批決定送出中嘗試回首頁

- **GIVEN** Gun Shop 的審批卡片正在送出 approve 或 deny
- **WHEN** 使用者嘗試回首頁
- **THEN** 回首頁控制項 MUST 為不可操作狀態

#### Scenario: 有待審批操作時確認離開

- **GIVEN** Gun Shop 有等待使用者決定的審批卡片，且沒有進行中的 run
- **WHEN** 使用者選擇回首頁並在確認提示中確認
- **THEN** 前端 MUST 回到首頁並丟棄該工作區狀態
- **AND** 前端 MUST NOT 送出 approve、deny 或 cancel
- **AND** 確認提示 MUST 說明待審批操作不會帶到新對話

#### Scenario: 有待審批操作時取消離開

- **GIVEN** Gun Shop 有等待使用者決定的審批卡片
- **WHEN** 使用者選擇回首頁後在確認提示中取消
- **THEN** 前端 MUST 留在 Gun Shop 工作區
- **AND** 審批卡片的狀態與可操作性 MUST 與離開前相同

#### Scenario: 審批送出失敗後離開

- **GIVEN** Gun Shop 的審批決定送出失敗，卡片依既有規則維持開啟
- **WHEN** 使用者選擇回首頁
- **THEN** 前端 MUST 以「有待審批操作」處理並顯示確認提示

#### Scenario: Gun Shop 審批流程在新入口下維持原行為

- **GIVEN** 使用者從首頁進入 Gun Shop 並觸發需審批的訂單操作
- **WHEN** 伺服器送出審批 interrupt，使用者核准或拒絕
- **THEN** 審批卡片、resume 送出、送出失敗處理與 commerce 卡片 MUST 與本 Change 前的行為相同

---

### Requirement: 入口工作區 MUST 在頂部提供模式切換，切換即開啟新 session

入口工作區 MUST 在頂部左側（與底部 Setting 控制項上下對應）顯示目前模式與下拉切換選單；選單 MUST 只列出 Gun Chat 與 Gun Shop。切換到另一個模式 MUST 等同開啟新 session，不保留先前的對話內容。

#### Scenario: 顯示目前模式

- **GIVEN** 使用者在 Gun Chat 入口工作區
- **WHEN** 使用者檢視工作區頂部
- **THEN** 左上角 MUST 顯示目前模式名稱 `Gun Chat` 與可展開的下拉指示
- **AND** 觸發控制項 MUST 具可存取名稱並表達展開狀態

#### Scenario: 展開模式選單

- **GIVEN** 使用者在任一入口工作區
- **WHEN** 使用者以滑鼠或鍵盤展開模式選單
- **THEN** 選單 MUST 只列出 `Gun Chat`（子標題「Generative AI Agent」）與 `Gun Shop`（子標題「Shop AI Assistant」）
- **AND** 目前模式 MUST 以勾號與可存取的已選取狀態標示
- **AND** 選單 MUST NOT 列出 `math_agent`、`mcp_agent` 或任何其他 graph

#### Scenario: 關閉選單不切換

- **GIVEN** 模式選單已展開
- **WHEN** 使用者按下 Escape 或點擊選單外部
- **THEN** 選單 MUST 關閉，焦點 MUST 回到觸發控制項
- **AND** 目前模式與對話 MUST 不變

#### Scenario: 切換到另一個模式

- **GIVEN** 使用者在 Gun Chat 已有對話，且沒有進行中的 run
- **WHEN** 使用者在模式選單選擇 Gun Shop
- **THEN** 工作區 MUST 切換為 Gun Shop 並顯示空對話
- **AND** 先前的訊息、Activity Timeline、本機錯誤或取消訊息、澄清狀態、commerce 卡片與審批送出狀態 MUST 全部清除
- **AND** 下一則訊息 MUST 在新 thread 上以 `shopping_assistant` 執行
- **AND** 再切回 Gun Chat 時 MUST 為空對話，深度研究開關 MUST 為關閉

#### Scenario: 選擇目前模式

- **GIVEN** 使用者在 Gun Shop 已有對話
- **WHEN** 使用者在模式選單選擇 Gun Shop
- **THEN** 選單 MUST 關閉
- **AND** 對話、thread 與工作區狀態 MUST 不變

#### Scenario: run 進行中嘗試切換模式

- **GIVEN** 任一入口有進行中的 run，或 Gun Shop 的審批決定正在送出
- **WHEN** 使用者嘗試切換模式
- **THEN** 模式切換 MUST 為不可操作狀態並提示需先取消
- **AND** 進行中的 run 或審批送出 MUST 不受影響

#### Scenario: 有待審批操作時切換模式

- **GIVEN** Gun Shop 有等待使用者決定或送出失敗的審批卡片，且沒有進行中的 run
- **WHEN** 使用者選擇 Gun Chat
- **THEN** 前端 MUST 先顯示確認提示，說明待審批操作不會帶到新 session
- **AND** 使用者確認後 MUST 以新 session 進入 Gun Chat，且 MUST NOT 送出 approve、deny 或 cancel
- **AND** 使用者取消後 MUST 留在 Gun Shop，審批卡片的狀態與可操作性 MUST 與切換前相同

#### Scenario: 限流與身分狀態跨模式保留

- **GIVEN** 前端正在顯示限流倒數或身分失敗狀態
- **WHEN** 使用者切換模式
- **THEN** 限流倒數與身分失敗狀態 MUST 保留，直到依既有規則結束
- **AND** 限流期間 MUST NOT 因切換模式而允許送出

#### Scenario: 首頁不顯示模式切換

- **GIVEN** 使用者在首頁
- **WHEN** 首頁顯示
- **THEN** 頂部 MUST NOT 顯示模式切換，模式由兩個入口卡片選擇

---

### Requirement: 入口拆分 MUST 保留既有跨層契約

本 Change MUST NOT 改變 Graph ID、BFF Route、Runtime Event、錯誤碼、Terminal State 或 request payload shape，且 MUST NOT 需要 backend 或 BFF 變更。

#### Scenario: 契約不變

- **GIVEN** 本 Change 已實作
- **WHEN** 比對 `backend/`、`bff/` 與 `backend/langgraph.json` 的 Git Diff
- **THEN** 這些路徑 MUST 沒有變更
- **AND** 前端送出的 request 欄位 MUST 與相同目標 assistant 在本 Change 前送出的欄位相同

#### Scenario: BFF 結構化錯誤在入口工作區中呈現

- **GIVEN** 使用者在 Gun Chat 或 Gun Shop
- **WHEN** BFF 回傳既有 `ErrorEnvelope`（含未知錯誤碼）
- **THEN** 前端 MUST 依 `frontend-chat` 既有規則分類與顯示
- **AND** MUST NOT 以顯示文案推測狀態
