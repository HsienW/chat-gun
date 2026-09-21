# Spec：Canonical Execution Context

## ADDED Requirements

### Requirement: Canonical ExecutionContext 與 strict runtime schema

Backend MUST 定義單一 domain 型別 `ExecutionContext`，包含 `requestId`、`threadId`、`runId`、`taskId`、optional `stepId`／`toolCallId`／`toolExecutionId`／`parentRunId`／`agentId`、`attempt`、`principal: PrincipalContext` 與 `scope: RuntimeScope`。該型別 MUST 由 strict runtime schema（Zod）驗證，作為全鏈 correlation 的單一事實來源。

#### Scenario: 完整 context 通過驗證

GIVEN 一個具備全部 mandatory 欄位（`requestId`、`threadId`、`runId`、`taskId`、`attempt`、`principal`、`scope`）且各 ID 符合字元集與長度限制的 context
WHEN 以 runtime schema 解析
THEN MUST 通過並回傳 `ExecutionContext`
AND optional 欄位可合法省略

#### Scenario: 缺 mandatory 欄位被拒絕

GIVEN 一個缺少 `runId` 或 `taskId` 或 `principal` 或 `scope` 的 context
WHEN 以 runtime schema 解析
THEN MUST 回傳 validation failure
AND MUST NOT 以空字串或 placeholder 靜默補齊

#### Scenario: malformed 或 oversized ID 被拒絕

GIVEN 一個 `requestId`／`runId` 含不合法字元或超過長度上限
WHEN 以 runtime schema 解析
THEN MUST 回傳 validation failure
AND MUST NOT 將該值視為有效 correlation identity

#### Scenario: unknown field 不被靜默忽略

GIVEN 一個 context 含未知欄位
WHEN 以 strict runtime schema 解析
THEN MUST 被偵測（strict 模式拒絕或顯式列為 error）
AND MUST NOT 靜默通過後才在消費端才發現 typo

---

### Requirement: 單一 Backend adapter 作為 LangGraph metadata 的唯一映射邊界

Backend MUST 提供單一 `readExecutionContext` adapter，從 LangGraph request／config metadata 建立 `ExecutionContext`；snake_case／kebab-case／camelCase 的對映 MUST 只在該 adapter 發生，內部模組 MUST 使用單一 naming convention，MUST NOT 各自解析 raw config key。

#### Scenario: legacy key mapping 於單一邊界收斂

GIVEN config 同時存在 `thread_id`、`run_id`、`task_id`、`step_id`、`tool_call_id` 等 snake_case 與對應 camelCase key
WHEN 以 `readExecutionContext` 解析
THEN MUST 於 adapter 內統一對映至 domain 欄位
AND 消費端 MUST NOT 因 key case 不同而讀到空值

#### Scenario: 同一 logical value 不得因位置不同而分裂

GIVEN `runId` 同時可能位於 top-level `config.runId` 或 `configurable.run_id`
WHEN 以 `readExecutionContext` 解析
THEN MUST 回傳一致的 `runId`
AND MUST NOT 因呼叫端只提供其中一種位置而得到空值或相異值

#### Scenario: 直接讀 raw config key 被 contract test 阻止

GIVEN 一個模組直接讀取 raw config key 自行解析 correlation
WHEN 執行 architecture／contract test
THEN 該直讀 MUST 被視為違規
AND 模組 MUST 改經由 canonical adapter 取得 context

---

### Requirement: Transport type 與 domain ExecutionContext 分離

BFF 的 trusted headers、`config.configurable` 的 raw key 與前端 transport metadata 屬 transport type，MUST NOT 與 domain `ExecutionContext` 混用；adapter 是 transport → domain 的唯一橋接。

#### Scenario: domain 邏輯不直接解析 transport header

GIVEN 一個需要 correlation 的 backend 模組
WHEN 取得 context
THEN MUST 消費 `ExecutionContext`
AND MUST NOT 直接讀取 `x-bff-*` 或 raw header key 自行重組身份

---

### Requirement: BFF 產生／驗證 requestId 並覆寫 trusted identity

BFF MUST 產生或驗證 `requestId`，並覆寫所有 trusted identity 欄位；client 提供的 correlation headers 視為不可信輸入，MUST NOT 原樣採納。

#### Scenario: client requestId 合法才接受

GIVEN client 提供符合格式與長度限制的 `x-request-id`
WHEN BFF 處理請求
THEN MUST 接受並沿用該 `requestId`
AND MUST 覆寫所有 trusted identity 欄位（`x-bff-principal-*`）

#### Scenario: client requestId 非法則產生或拒絕

GIVEN client 提供 malformed、oversized 或含非法字元的 `x-request-id`
WHEN BFF 處理請求
THEN MUST 依政策產生 server-generated `requestId` 或拒絕該請求
AND MUST NOT 將未驗證的 client 值原樣透傳為 correlation identity

#### Scenario: duplicate 或衝突 correlation header 被拒絕

GIVEN 同一 correlation header（例如 `x-request-id`）出現多個或互相衝突的值
WHEN BFF 驗證
THEN MUST reject（不採信任一未驗證值）
AND MUST NOT 以任意一個值當作有效 identity

#### Scenario: client 偽造 identity 不覆蓋 trusted identity

GIVEN client 攜帶 `x-user-id`／`x-tenant-id` 等 raw identity
WHEN BFF 解析 trusted context
THEN principal／tenant MUST 由 trusted resolver 導出
AND canonical trusted headers MUST 覆寫 raw header，backend 只消費 BFF 產出的 canonical headers

---

### Requirement: context 傳播至 events、ToolExecution、authorization、audit、tracing 與 terminal

`ExecutionContext` MUST 被傳播至 Task/Step events、ToolExecution、authorization 決策、audit、OTel、Opik、metrics 與 terminal envelopes，使同一 `runId` 可貫穿全鏈查詢。

#### Scenario: 單一 runId 貫穿全鏈

GIVEN 一次 Run 從 BFF 進入並完成 model／Tool／audit／trace／event／terminal
WHEN 以 `runId` 查詢
THEN MUST 能於 Task/Step events、ToolExecution、authorization、audit、OTel／Opik span、metrics 與 terminal response 找到同一 `runId`

#### Scenario: audit 記錄 run/thread identity

GIVEN 一次執行產生 audit event
WHEN 查詢 audit
THEN 該事件 MUST 含 `requestId`／`threadId`／`runId`（或可索引的等價欄位）
AND MUST NOT 只存於不可索引的 opaque payload

#### Scenario: terminal response 帶 canonical correlation

GIVEN 一次執行到達 terminal state
WHEN 產生 terminal／error envelope
THEN MUST 帶 canonical correlation（至少 `runId`／`threadId`／`requestId`）

---

### Requirement: Parent/child Run correlation 不得與 threadId／attempt 混同

Child Run MUST 以 `parentRunId` 表達父子關係且保有獨立 `runId`；`threadId`、user prompt ID 與 request attempt MUST NOT 被等同於 `runId`。

#### Scenario: child Run 保留獨立 runId 並帶 parentRunId

GIVEN 一次 Run 派生出 child Run
WHEN 建立 child 的 `ExecutionContext`
THEN `runId` MUST 為 child 的獨立識別
AND `parentRunId` MUST 指向 parent 的 `runId`

#### Scenario: threadId 不等於 runId

GIVEN 同一 thread 內有多個 Run
WHEN 建立各 Run 的 `ExecutionContext`
THEN 各 Run 的 `runId` MUST 相異
AND `threadId` MUST 保持 thread 層級識別，MUST NOT 被當作 `runId`

#### Scenario: request attempt 不等於 runId

GIVEN 同一 request 的多次 attempt
WHEN 建立 context
THEN `attempt` MUST 以獨立欄位表達
AND MUST NOT 以 `attempt` 改寫 `runId` 或 `requestId`

---

### Requirement: checkpoint 序列化不含執行期物件或機密

`ExecutionContext` 與任何 checkpointed state MUST 只含 JSON 可序列化欄位；client、`AbortSignal`、stream、function、credential MUST NOT 進入 checkpoint 序列化狀態。取消訊號 MUST 經 LangGraph 標準非 checkpointed 槽位傳遞。

#### Scenario: AbortSignal 不進入 checkpointed configurable

GIVEN 一次執行攜帶 `AbortSignal`
WHEN 傳遞取消訊號
THEN `AbortSignal` MUST 經 top-level `config.signal` 傳遞
AND MUST NOT 被寫入 `config.configurable`（會被 checkpoint 的位置）

#### Scenario: serialized context 不含敏感或不序列化物件

GIVEN 一個序列化後的 `ExecutionContext` 或 checkpoint state
WHEN 檢查其內容
THEN MUST NOT 含 client、function、stream、signal 或 credential
AND 所有欄位 MUST 為 JSON 可序列化

---

### Requirement: 平行 Run 不得互相覆寫 context

平行 Run 的 context MUST 彼此隔離；傳播機制 MUST NOT 使用 process-global mutable current Run variable，MUST NOT 因交錯執行而覆寫彼此的 `ExecutionContext`。

#### Scenario: 平行 Run context 隔離

GIVEN 兩個平行進行的 Run
WHEN 各自於 node／Tool 讀取 context
THEN 各自 MUST 取得自身 Run 的 `ExecutionContext`
AND MUST NOT 讀到或覆寫另一 Run 的 context

#### Scenario: 無 process-global mutable current Run

GIVEN 傳播機制
WHEN 檢查 context 傳遞方式
THEN MUST NOT 依賴 process-global mutable current Run variable
AND MUST 以 explicit config／參數傳遞

---

### Requirement: 缺 mandatory context 於 production fail-closed

Production 下，缺 mandatory correlation 欄位（尤其 `runId`／`taskId`／`principal`／`scope`）時 MUST fail-closed，MUST NOT 以空值或推導值繼續受保護的執行。

#### Scenario: production 缺 runId 被拒

GIVEN 運行於 production profile
AND `ExecutionContext` 缺 `runId`
WHEN 建立 context
THEN MUST fail-closed（回傳明確 error）
AND MUST NOT 以 display text 或 model output 推導補齊

#### Scenario: development 使用隔離 identity

GIVEN 運行於 development 且未配置 production authentication source
WHEN 建立 context
THEN MUST 使用隔離的 development identity（`public`／`anonymous`／`development`）
AND MUST NOT 假裝成任意 tenant 的授權身份

#### Scenario: production 缺 principal／scope 不得以 development identity 補齊

GIVEN 運行於 production profile（或環境無法明確判定）
AND `ExecutionContext` 缺 `principal` 或 `scope`
WHEN 建立 context
THEN MUST fail-closed（回傳明確 error）
AND MUST NOT 以 development identity（`anonymous`／`public`／`development`）或空值補齊
AND MUST NOT 讓未建立的身份呈現為已驗證的執行脈絡

---

### Requirement: 相容性 adapter 與 bounded migration

既有 correlation headers MUST 只經 explicit compatibility adapter 接受；既有 events 於 bounded migration window 內可省略新欄位，但新 producer MUST 發 canonical context；本 Change MUST NOT 變更任何 Graph ID、公開 BFF route 或既有 error-code 語意。

#### Scenario: 既有 header 僅經 adapter 接受

GIVEN 既有 client 仍發送 `x-request-id`／`x-idempotency-key`／`x-active-run-id`／`x-active-run-generation`
WHEN 建立 context
THEN MUST 經 compatibility adapter 對映
AND MUST NOT 新增 header 語意變更

#### Scenario: 舊事件可省略新欄位、新 producer 必須發送

GIVEN bounded migration window
WHEN 消費事件
THEN 舊 producer 的事件可省略新 correlation 欄位且消費端 MUST 容忍
AND 新 producer 的事件 MUST 發送 canonical context

#### Scenario: Graph ID／route／error-code 不變

GIVEN 本 Change 的實作
WHEN 檢查公開契約
THEN Graph ID、公開 BFF route 與既有 error-code 語意 MUST 保持不變

---

### Requirement: Contract tests 覆蓋 legacy mapping、unknown fields、malformed IDs 與 concurrent Runs

Contract tests MUST 至少覆蓋 legacy key mapping、unknown fields、malformed IDs 與 concurrent Runs，且 frontend、bff、backend 三套件 build／test MUST 通過。

#### Scenario: contract test 矩陣

GIVEN 需要驗證的契約
WHEN 執行 contract tests
THEN MUST 涵蓋：
- legacy snake_case／kebab-case／camelCase key mapping
- unknown field 偵測
- malformed／oversized ID 拒絕
- 平行／concurrent Runs 的 context 隔離
AND 三套件（frontend／bff／backend）的 build 與 test MUST 實際執行並通過
