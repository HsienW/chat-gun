## Why

`second-stage-plan-en-v7-r2.md` 的 Chapter 2 要求新加坡部署（D5）前，公開 demo 連結具備限流、每日成本上限與降級回應，且任一必要設定缺失時部署無法啟動。以 HEAD `a090967` 核對，現況不足以支撐公開連結：

- **client IP 可被偽造且各處不一致**：BFF 寫入審計與轉發給上游的 client IP 無條件採用 `x-forwarded-for` 第一段，任何訪客都能偽造；限流的 IP 維度卻只取 socket 對端，部署在負載平衡後面時所有請求退化成同一個桶。沒有「信任代理」設定。
- **沒有用量與成本帳本**：backend 有兩個 provider 出口——聊天模型的 LLM Gateway 與知識庫的 embedding／rerank model gateway。`computeTokenCost`、`recordTokenMetric` 只在測試中被呼叫；LLM Gateway 的結構化輸出修復只保留最後一次回應的 `usage_metadata`；預設費率是佔位值；沒有任何地方累加，BFF 也看不到用量。
- **demo 情境下限流退化成全站單一桶**：demo 不要求登入，所有訪客解析為同一個 `anonymous` principal，user 維度等於全站共用。
- **防護缺設定時默默失效**：`BFF_ALLOWED_ORIGINS` 留空即允許所有 Origin；未設定 Redis 時限流改用單一程序記憶體；數值設定不合法時回退預設值。

公開 demo 一旦被濫用，直接後果是模型費用失控與 provider 帳號被限流，這是 D5 Human Gate「cost acceptance」必須事先界定的風險。

上一版計畫（2026-10-27）把全部能力綁在 demo 開關下。Master 於 2026-11-01 決定改為**兩層架構**：信任代理、用量帳本與預算檢查介面屬於任何部署都需要的**通用層**；access session、全站上限與嚴格啟動檢查屬於可替換的 **Demo 設定層**，日後可換成登入或多租戶配額而不改通用層。同日 Master 對 r2 B8 定案：**demo 完全不設訪問碼**。

## What Changes

### 通用層（不受 demo 開關控制）

- 新增 **client IP 解析**：只在 socket 對端屬於已設定的信任代理時才採用轉發標頭；預設信任代理清單為空，即直接使用對端位址。限流、審計與轉發給上游的 client IP 共用同一個解析結果。**這會改變非 demo 部署的審計與轉發 IP**（見 Risks）。
- 新增 **模型用量與成本帳本**：在 backend 全部 provider 出口（LLM Gateway 與 knowledge model gateway）逐次累加每一次 provider 呼叫的實際用量，包含重試、模型 fallback 與結構化輸出修復；依設定的模型單價表換算為帳單幣別金額（不換匯，帳本幣別由單價表推得）；缺單價時標記為未計價，不當作 0。預設儲存為程序內記憶體，設定共用儲存後可跨程序讀取。
- 新增 **run 建立前的准入檢查介面與穩定錯誤碼**：BFF 在轉發任何會建立 run 的請求前呼叫准入政策；通用層定義介面、錯誤碼（`usage_budget_exhausted`、`usage_budget_unavailable`、`run_quota_exhausted`、`run_concurrency_limited`、`feature_disabled`）與 frontend 依錯誤碼的降級渲染。**預設政策不設任何上限、不讀帳本**，既有行為不變。
- 修正結構化輸出修復只保留最後一次用量的問題（至少在帳本累加層面逐次計入）。

### Demo 設定層（只在 demo 開關啟用時生效）

- 單一 demo 開關；啟用時注入以下政策實作到通用層的擴充點：
  - **訪客 session cookie**（不需訪問碼）：BFF 為訪客簽發 HttpOnly、Secure、SameSite 的匿名 session cookie，作為限流 user 維度鍵，取代共用的 `anonymous`。
  - **全站每日上限**：以新加坡區帳單幣別設定，每日 USD 0.21（由 Master 決定的 CNY 1.5 依參考匯率 7.2 換算），含分入口上限（Gun Shop 0.125、Gun Chat 一般對話 0.028、深度研究 0.042、預留 0.014）；並行 run 上限 3；深度研究每 IP 每日 2 次；禁止 crons；只開放 `chatbot`、`deep_researcher`、`shopping_assistant`；預算用完仍放行審批 resume。
  - **嚴格啟動檢查**：必要設定缺失、不合法或不安全（含任一啟用模型缺核實單價、Gun Shop 思考模式未關閉）即拒絕啟動，不默默降級。
- 依賴方向只能是 **Demo 設定層 → 通用層**；通用層不得引用 demo 模組或讀取 demo 開關。

### 非目標內的不變項

- Graph ID、既有 BFF Route、既有錯誤碼語意、LangGraph State／Checkpoint、X43 審批與 side-effect 語意不變。

## Capabilities

### New Capabilities

- `client-ip-resolution`（通用層）：信任代理設定、client IP 解析、限流／審計／轉發共用同一結果。
- `model-usage-ledger`（通用層）：provider 出口逐次累加用量、模型單價表與金額換算、帳本儲存介面與日期分區、寫入失敗語意。
- `run-admission-guard`（通用層）：run 建立前的准入政策介面、預設無上限政策、穩定錯誤碼與 HTTP 語意、預算檢查 fail-closed、frontend 依錯誤碼降級。
- `demo-deployment-profile`（Demo 設定層）：demo 開關、訪客 session cookie、demo 准入政策數值、嚴格啟動檢查、層間依賴方向。

### Removed（相對於 2026-10-27 草稿，未曾核准）

- `demo-access-gate`：依 B8「完全不設碼」移除；訪客 session 併入 `demo-deployment-profile`。
- `demo-token-budget`：拆成通用層的 `model-usage-ledger` 與 `run-admission-guard`，demo 數值併入 `demo-deployment-profile`。

### Modified Capabilities

- 無既有 spec Requirement 被修改。client IP 的行為改變目前沒有既有 Requirement 規範；若 review-plan 認定 `bff-stream-proxy` 或 `multi-instance-operation` 需要 MODIFIED delta，於 review 後補入。

## Impact

- **bff**：client IP 解析、准入政策介面與預設政策、新錯誤碼、demo 訪客 session、demo 准入政策、demo 嚴格啟動檢查。
- **backend**：兩個 provider 出口的用量累加、單價表、帳本儲存介面（記憶體／Redis）、demo 啟動檢查；不改 Graph ID、State、Checkpoint、事件契約。
- **frontend**：依新錯誤碼渲染降級狀態（預算耗盡、預算不可用、配額耗盡、並行受限、功能停用），帶 cookie 的請求。
- **部署**：demo 模式需要 Redis（BFF 與 backend 共用帳本）、信任代理設定、session 簽章 secret、核實的模型單價表（皆由雲端 secret 或環境變數注入，不進版控）。

## Goals

- D5 部署時限流、每日成本上限與降級三者皆為 active，且任一必要設定缺失時部署無法啟動。
- 每日成本有可查證的上限，最壞超支量可事先計算並寫進 D5 cost acceptance。
- 通用層在非 demo 部署中也提供正確的 client IP 與完整用量帳本；Demo 設定層可整個替換而不修改通用層。

## Non-Goals

- 不做訪問碼、使用者註冊、登入或 OAuth（B8：完全不設碼）。
- 不做對帳、帳單或付費方案；帳本金額只用於上限判斷與觀測。
- 不做多租戶配額或按使用者配額（通用層只保留擴充點）。
- 不做深度研究的研究輪數、初始搜尋組數與 egress 管控（分別屬於 deep_researcher 設定與 D5 Lane A）。
- 不做 Deployment Level 2 的告警、備份與 HTTPS 憑證管理；本 Change 只要求 cookie 為 Secure。
- 不改變 X43 審批、side-effect ledger 與 resume 語意。
- 不宣稱 production 等級的濫用防護；External Description Boundary 照舊適用。

## Risks

- **非 demo 部署的 client IP 行為改變**：預設信任代理為空，部署在代理後面的既有環境會把審計與轉發 IP 從 `x-forwarded-for` 第一段改為代理位址，直到設定信任代理。屬安全修正，Master 已以「通用層不受 demo 開關控制」接受；需在 README 與部署說明標示。
- **沒有訪問碼**：訪客可丟棄 cookie 取得新 session，session 維度不是濫用屏障；真正的屏障是 IP 維度、並行上限與全站每日上限。最壞情況是單一濫用者在一天內耗盡全站預算，demo 當日停用。
- **只在 run 開始前擋會超支**：最壞超支約為「並行 3 × 單一 run 最大成本」，加上預算用完後放行的審批 resume。
- **用量低估**：任何未經 provider 出口的模型呼叫都不會入帳；帳本必須逐次累加每一次 provider 呼叫。
- **Redis 成為單點**：demo 模式下 Redis 失效會讓預算檢查拒絕所有新 run；限流沿用程序內計數退回。

## Rollback

- 關閉 demo 開關即移除 Demo 設定層的全部政策，回到通用層預設（無上限、記憶體帳本）。
- 通用層的 client IP 行為可透過設定信任代理清單恢復代理後的真實訪客 IP；不提供恢復「無條件信任轉發標頭」的設定。
- 帳本累加失敗不影響模型回應；不涉及資料遷移；Redis 帳本鍵以日期分區並設 TTL，回滾後自然過期。
