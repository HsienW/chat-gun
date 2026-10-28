# Design：首頁入口拆分（Gun Chat／Gun Shop）

## Context

- 前端目前由單一聊天畫面組成：空對話時顯示歡迎畫面與輸入框，對話開始後顯示訊息列表；兩者的輸入列都有 agent 下拉選單。
- 目前目標 assistant 由一個前端 state（`selectedAgentId`，預設 `deep_researcher`）決定，並直接作為 LangGraph SDK `useStream` 的 `assistantId`。下拉選單的 agent 清單來自前端集中定義的 `AgentId` enum 與 `AVAILABLE_AGENTS`。
- 目標 assistant 也決定：是否顯示 Activity Timeline 與處理 `agent.card.emit`（`showActivityTimeline`）、是否附帶深度研究 run config 與 `reasoning_model`、是否顯示 effort 選單與圖片上傳。
- 前端沒有自行管理 `threadId`；thread 由 `useStream` 內部持有。目前 submit 時若 agent 改變，會重置活動、澄清、commerce 與審批送出狀態，但不明確重置 thread。
- Gun Shop 的審批卡片（T10）由 `CommercePanel` 依 thread interrupt 與 commerce reducer 呈現，屬 `commerce-assistant-and-approved-side-effects` 已實作的行為。

## Goals / Non-Goals

**Goals**

- 以入口（Gun Chat／Gun Shop）與明確的深度研究開關取代 agent 下拉選單。
- 目標 assistant 由單一純函式從「入口 + 開關」推導，可獨立測試。
- thread、串流、取消、澄清與審批在切換入口或開關時有明確且可測試的行為。

**Non-Goals**

- backend、BFF、Graph、模型、事件、錯誤碼、伺服器端開放控制與成本防護（見 proposal 非目標）。
- 打 release tag：本 Change 屬 Chapter 1A，對應 `v2.0.0-rc.1`（1B 為 `v2.0.0-rc.2`，D5 部署為 `v2.0.0`）；tag 由 Master 執行，實作與驗收流程均不得建立 tag。

## 各層變更

### frontend

1. **入口狀態**：新增記憶體內的入口狀態，值為 `home`、`gun_chat`、`gun_shop` 三者之一，初始一律為 `home`。不寫入 `localStorage`、`sessionStorage`、cookie 或 URL；重新載入頁面即回到首頁。
2. **首頁**：顯示 logo、首頁產品標題 `Chat Gun AI Agent`（依本 Change 的 `project-identity` MODIFIED）與兩張入口卡片：Gun Chat（子標題「Generative AI Agent」）、Gun Shop（子標題「Shop AI Assistant」）。首頁本身不提供輸入框，也不建立 thread 或送出任何 run。瀏覽器頁籤標題維持 `Chat Gun`。
3. **入口工作區**：進入入口後顯示聊天工作區（沿用既有訊息列表、輸入列、Activity Timeline、CommercePanel），並提供「回首頁」控制項。工作區左上角的模式切換（D9）標示目前入口名稱。
4. **目標 assistant 推導**：集中於一個純函式，輸入為入口與深度研究開關，輸出為既有 `AgentId`：

   | 入口 | 深度研究開關 | 目標 assistant |
   | --- | --- | --- |
   | `gun_chat` | 關（預設） | `chatbot` |
   | `gun_chat` | 開 | `deep_researcher` |
   | `gun_shop` | 不適用（不顯示） | `shopping_assistant` |
   | `home` 或未知值 | — | 無目標，不得送出 |

   Graph ID 只引用既有 `AgentId` enum（單一來源），不在元件中另寫字串。`math_agent`、`mcp_agent` 不在任何入口的輸出範圍內。此表屬穩定 Domain Constant（入口 enum → Graph ID），有型別、單一來源、未知值處理與測試，不承擔任何自然語言理解。
5. **移除 agent 下拉選單**：輸入列不再顯示 agent 選單；輸入列上方「使用 {agent 名稱}」說明改為入口相關說明。effort 選單、圖片上傳、`reasoning_model` 與 run config 仍依推導出的目標 assistant 決定，維持既有行為（目標為 `deep_researcher` 時才出現或附帶）。模型選單沿用 `frontend-model-selection` 現有行為。
6. **Activity Timeline 與 commerce 卡片**：仍依目標 assistant 的 `showActivityTimeline` 決定；`onUpdateEvent` 讀取最新目標 assistant，不得使用過期閉包（`frontend-chat` MODIFIED）。
7. **不提供思考模式開關**。

### bff

無變更。BFF Route、驗證、限流、逾時、取消傳遞與錯誤映射維持原狀。

### backend

無變更。`backend/langgraph.json` 的五個 graph 都保留；`math_agent`、`mcp_agent` 仍可經 BFF 直接呼叫，伺服器端開放控制屬 Chapter 2。

## Decisions

### D1：入口狀態只存在記憶體

- **決定**：每次進站顯示首頁，不記住上次入口與開關狀態。
- **替代方案**：`localStorage` 記住上次入口——與需求 4 衝突；URL 路由（`/chat`、`/shop`）——需新增路由或手寫 history 處理，超出 1A 最小範圍。
- **後果**：瀏覽器「上一頁」不會在首頁與入口間切換；此為已知限制，記錄於 README 或後續 Change。

### D2：目標 assistant 由純函式推導，取代自由選擇的 agent state

- **決定**：不再保留可由介面任意設定的 `selectedAgentId`；目標 assistant 一律由「入口 + 開關」推導。
- **理由**：推導值不重複保存（`frontend/AGENTS.md` §7），也避免 UI 出現第三條可達 `math_agent`／`mcp_agent` 的路徑。
- **替代方案**：保留 `selectedAgentId`，由入口與開關去 set——會多一份可失同步的 state，不採用。

### D3：進入入口即開始新 thread；回首頁即放棄目前 thread 的前端參照

- **決定**：每次從首頁進入任一入口，都從空對話開始（新 thread 在第一則訊息送出時建立，沿用 SDK 既有行為）。回首頁時，前端丟棄該入口的訊息、活動、澄清、commerce 與審批送出狀態；不刪除伺服器端 thread。
- **實作方向（由 Codex 依 SDK 實際能力擇一並以測試證明）**：以每次進入入口遞增的 key 重新掛載聊天工作區；或使用 SDK 提供的 thread 重置能力。不得以手動清空部分 state 取代完整重置。
- **跨入口保留**：限流倒數（`rateLimitRetryAfter`）與身分失敗狀態屬於整個前端工作階段，不因切換入口而清除，避免使用者以切換入口繞過 UI 層的限流提示（伺服器端限流仍是唯一權威）。

### D4：深度研究開關只影響下一則訊息，thread 延續（Master 已決定）

- **決定**：在 Gun Chat 內切換開關，只改變下一則送出訊息的目標 assistant；既有對話與 thread 保留。符合需求 2「該則訊息送往 `deep_researcher`」，也與目前 submit 時切換 agent 不重置 thread 的行為一致。
- **前提**：`chatbot` 與 `deep_researcher` 都以 `messages` 為訊息 key；兩者能否在同一 thread 上交替執行，必須由 Task 1 以測試與本機 smoke 證明。
- **不得走入口重置路徑**（review-plan Major 修訂）：目前 submit 流程在目標 agent 改變時會呼叫 agent 切換處理，以 `clearHistorical` 清除先前訊息已歸檔的 Activity Timeline，並重置 commerce 與審批狀態。實作 MUST 移除 submit 時的 agent 切換重置：深度研究開關只改變推導出的 `assistantId`，不得呼叫 D3／D9 的工作區重置，也不得清除已歸檔活動。每次 submit 仍依既有 `frontend-chat` 規則重置「即時」活動狀態（不清除歷史）。完整工作區重置只發生在進入入口、回首頁與切換模式。
- **submit 介面**：`handleSubmit` 與 `InputForm` 的 `onSubmit` 移除 `agentId` 參數；目標 assistant 一律由入口與深度研究開關推導，`InputForm` 不再傳遞或持有 agent 選擇。
- **未採用的替代方案**：切換開關即開始新 thread。
- **停止條件**：若 Task 1 證明同一 thread 交替執行不可行，Codex MUST 停止並交回 CCR；由 CCR 更新本 design 與 spec、經 Master 重新決定後再實作。Codex 不得自行改為開新 thread，也不得加入特殊分支吞錯誤。
- **effort 選單**：沿用既有規則（對話已有歷史時不顯示，使用預設 effort）。若 Master 希望對話中開啟深度研究時可選 effort，列為後續 Change。

### D5：串流中與等待澄清時鎖定開關

- **決定**：下列情況深度研究開關不可切換（disabled，並有可存取的說明）：
  - run 進行中（SDK loading 或前端 dispatching）。
  - 等待澄清（clarification interrupt）回覆中。
- **理由**：run 已用某個 assistant 建立；中途切換目標會讓取消、澄清 resume 或晚到事件對應到錯誤的 assistant。鎖定比「允許切換但延後生效」更容易驗證。
- run 結束（成功、錯誤、逾時、取消）後立即解鎖；Terminal State 不得因解鎖而回到 running。

### D6：離開入口的規則

- **run 進行中**：「回首頁」不可用；使用者需先用既有取消按鈕取消。理由：取消需要在同一 thread 送出既有 cancel 契約，元件卸載中送出取消難以保證送達與測試。
- **等待澄清**：可離開；澄清狀態隨工作區丟棄，不送出任何 resume。
- **Gun Shop 有待審批操作（T10 卡片仍在等待決定或送出失敗）**（Master 已決定）：先顯示確認提示（說明待審批操作不會帶到新對話，伺服器端依既有審批逾時處理），使用者確認後才離開；取消提示則留在原工作區且卡片狀態不變。前端 MUST NOT 自動送出 approve、deny 或 cancel。未採用的替代方案：禁止離開直到審批完成。
- **審批決定送出中（submitting）**：視同 run 進行中，不可離開。

### D7：Graph 只在 UI 隱藏

`math_agent`、`mcp_agent` 從介面移除不構成權限控制（`frontend/AGENTS.md` §3：不得以隱藏取代權限檢查）。本 Change 的文件與 UI 不得宣稱這兩個 graph 已停用。

### D8：首頁產品標題與專案顯示名稱分開定義（Master 已決定）

- **決定**：首頁標題為 `Chat Gun AI Agent`，入口子標題為「Generative AI Agent」（Gun Chat）與「Shop AI Assistant」（Gun Shop）。專案顯示名稱維持 `Chat Gun`，用於瀏覽器頁籤標題、README 與專案文件。
- **與既有 spec 的關係**：`project-identity` 的「顯示名稱一致」Scenario 要求使用者可見專案名稱皆為 `Chat Gun`，與首頁標題 `Chat Gun AI Agent` 不完全相同。本 Change 以 MODIFIED delta 在同一 Requirement 中新增「首頁產品標題」與「入口名稱」兩個識別 token，並把顯示名稱 Scenario 的範圍限定為首頁產品標題與入口名稱以外的位置。
- **未採用的替代方案**：把專案顯示名稱整體改為 `Chat Gun AI Agent`——需同步 README（三語）、`docs/`、`harness-*` specs、頁籤標題與根規則文件，超出 frontend-only 的 1A-1 範圍。
- **影響範圍**：見 proposal「首頁標題的影響範圍」。除首頁標題外，README、docs 與其他 spec 不需修改。
- **單一來源**：首頁標題與入口名稱、子標題集中定義於一處（例如入口定義旁），不在多個元件中重複字串；首頁入口卡片與 D9 模式切換選單共用同一份定義。

### D9：入口工作區頂部的模式切換（2026-10-28 追加）

- **位置**：入口工作區左上角，與左下角既有 Setting 按鈕上下對應；不遮擋訊息列表與輸入列，窄螢幕下仍可操作。
- **外觀**（參考 Codex 模式選單）：
  - 觸發按鈕顯示目前模式名稱（`Gun Chat` 或 `Gun Shop`）與向下箭頭。
  - 展開後為下拉選單，每個選項兩行：粗體模式名稱、較淡的子標題（Gun Chat「Generative AI Agent」、Gun Shop「Shop AI Assistant」）。
  - 目前模式在右側以勾號標示。
  - 沿用專案既有深色主題與既有 UI 元件（例如現有下拉選單元件），不新增相依套件。
- **可存取性**：觸發按鈕具可存取名稱與展開狀態；選項以單選語意（例如 `menuitemradio` 或等效）標示目前選擇；可用鍵盤開啟、移動、選擇，Escape 關閉並把焦點還給觸發按鈕。
- **首頁**（Master 已確認）：首頁沒有目前模式，因此不顯示模式切換；首頁以兩張入口卡片選擇模式。
- **切換語意**：選擇另一個模式，等同「離開目前入口再進入新入口」——開啟新 session：新 thread、清除訊息與所有工作區狀態、深度研究開關回到關閉；限流倒數與身分失敗狀態依 D3 保留。選擇目前模式不做任何事，對話保留。
- **切換限制**：與 D6 相同。run 進行中或審批決定送出中，模式切換不可操作並提示需先取消；Gun Shop 有待審批操作時，先顯示確認提示，確認後才切換，取消則留在原處且卡片狀態不變；前端不得自動送出 approve／deny／cancel。等待澄清時可切換，澄清狀態隨工作區丟棄。
- **實作方向**：模式切換與「回首頁再進入」共用同一個重置路徑（D3 的 key 重新掛載或 SDK thread 重置），不得另寫一套部分清除邏輯。
- **未採用的替代方案**：切換模式時保留各模式的對話——與需求「切換後不記憶先前對話」衝突，且需要多份 thread 狀態。

## 資料流

```text
首頁（entry = home）
  └─ 點選 Gun Chat ─→ entry = gun_chat，新工作區（空對話）
        ├─ 開關關 → submit → assistantId = chatbot ──┐
        └─ 開關開 → submit → assistantId = deep_researcher（附 run config 與 reasoning_model）
  └─ 點選 Gun Shop ─→ entry = gun_shop，新工作區（空對話）
        └─ submit → assistantId = shopping_assistant ─┤
                                                     ↓
                         既有 useStream → BFF（Route 不變）→ LangGraph Runtime
```

## 測試策略

- 純函式：入口與開關的所有組合、`home`／未知值、不得輸出 `math_agent`／`mcp_agent`。
- React 行為測試（Testing Library，以可存取語意查詢）：首頁兩個入口、無 agent 選單、進入入口後送出的 `assistantId`、開關切換、鎖定、回首頁、重新掛載後為空對話、Gun Shop 審批卡片與離開確認、取消與錯誤後解鎖。
- 既有回歸：`App.commerce.test.tsx`、`App.stream-activity.test.tsx`、`InputForm.model-selection.test.tsx` 等改以入口操作取代下拉選單，不得放寬原本斷言。
- 模式切換：選單結構與可存取語意、切換即新 session、選擇目前模式不重置、run 中與待審批時的限制（Task 6）。
- 本機 smoke（Task 1、Task 7）：同 thread 交替 `chatbot`／`deep_researcher`；Gun Shop 審批流程。Mock 測試通過不等於 live 驗收。

## Risks / Trade-offs

- 同 thread 跨 graph（D4）是主要技術風險，已設停止條件。
- 不使用 URL 路由，無法分享入口連結、上一頁不回首頁（D1）。
- 隱藏 graph 不等於關閉（D7），Chapter 2 之前直接呼叫 BFF 仍可用。

## Migration / Rollback

無資料遷移。回滾為 revert frontend 變更。

## Open Questions

無。Master 已於 2026-10-28 決定 D4、D6、D8、D9 與版本號（見 proposal「Master 決定紀錄」與「版本」）。唯一的條件性風險是 D4 的停止條件。
