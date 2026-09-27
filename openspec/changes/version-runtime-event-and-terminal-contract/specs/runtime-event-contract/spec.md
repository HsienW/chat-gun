# Spec Delta：runtime-event-contract

> 能力域：Versioned Runtime Event Envelope and Monotonic Frontend Reducer（X19）。
> 修訂版（r2）：依 Qwen review-plan `rr-x19-plan-001` 解決 M1–M4 與 m1–m3。

## ADDED Requirements

### Requirement: Versioned RuntimeEventEnvelope

每個新生產的 runtime event MUST 為 `RuntimeEventEnvelope`，含 semver `schemaVersion`、穩定 `eventId`、Run-scoped monotonic `sequence`、穩定 `type`、ISO `emittedAt`、X12 `context` 與 `payload`。`schemaVersion` 起始為 `"1.0.0"`；major bump 表示結構不相容，minor／patch bump 表示 additive only。

#### Scenario: 新事件帶完整 envelope

- GIVEN 一次 Run 產生 runtime event
- WHEN 事件交付
- THEN MUST 含 `schemaVersion`、`eventId`、`sequence`、`type`、`emittedAt`、`context`、`payload`
- AND `sequence` MUST 為同 `runId` 內遞增的正整數

#### Scenario: 缺 envelope 欄位被拒或降級

- GIVEN 一個缺少 `sequence` 或 `eventId` 的事件
- WHEN 消費端解析
- THEN MUST 依 schema 判定為 legacy／invalid
- AND MUST NOT 以 timestamp 或到達順序假裝成有效 versioned event

### Requirement: schemaVersion 前瞻相容

消費端 MUST 依 `schemaVersion` 的 major 區分結構相容與否：同 major、不同 minor／patch 的 envelope MUST 做 partial parse（驗證已知必填欄位、忽略未知 optional 欄位）；MUST NOT 因 additive 變更就整包降級。僅 major 不匹配才降級 `unknown`（或 `unsupported_schema_version` presentation）。

#### Scenario: 同 major 不同 minor 做 partial parse

- GIVEN backend 升級至 `schemaVersion = "1.1.0"`（僅新增 optional 欄位），frontend 支援 `"1.0.0"`
- WHEN frontend 解析該 envelope
- THEN MUST 驗證已知必填欄位並忽略未知 optional 欄位
- AND MUST NOT 整包降級為 unknown
- AND 既有可呈現資訊 MUST 保留

#### Scenario: major 不匹配才降級

- GIVEN 一個 `schemaVersion` major 大於消費端支援的 envelope
- WHEN 消費端解析
- THEN MUST 降級為 `unknown`／`unsupported_schema_version` presentation event
- AND MUST NOT 使 Chat UI 崩潰

### Requirement: 穩定 event identity 與 Run-scoped sequence

`eventId` MUST 由事件工廠單一來源產生，並在 replay／dedup 語意需要時於交付前持久化；`sequence` MUST 由 Run-scoped allocator 產生，跨 Run 不比較，且 MUST NOT 依賴 process-global mutable 單一變數。allocator MUST 於 Run 進入 terminal 時清理條目，並具 bounded TTL 防止洩漏。

#### Scenario: replay 保持 event identity

- GIVEN 一次 checkpoint replay 重新交付已產生過的事件
- WHEN 該事件再次到達消費端
- THEN 其 `eventId` 與 `sequence` MUST 與原始事件一致
- AND 消費端 MUST 能據此去重

#### Scenario: 平行 Run 不互相覆寫 sequence

- GIVEN 兩個平行 Run
- WHEN 各自分配 sequence
- THEN 各自 `sequence` MUST 從自身 Run 的計數器遞增
- AND MUST NOT 因交錯執行而讀到或覆寫另一 Run 的 sequence

#### Scenario: allocator 條目有界

- GIVEN 長時間運行且有 Run 進入 terminal 的 process
- WHEN Run 進入 terminal
- THEN 其 `runId` 的 allocator 條目 MUST 被清理
- AND 遺漏條目 MUST 由 bounded TTL 回收，不無限成長

### Requirement: ExecutionEventContext 為可序列化投影

`context` MUST 為 X12 `ExecutionContext` 的可序列化投影，含 correlation 與最小 trusted identity；MUST NOT 含 `AbortSignal`、client、function、stream、credential、token 或 secret。

#### Scenario: context 不含執行期物件或機密

- GIVEN 一個序列化後的 event envelope
- WHEN 檢查 `context`
- THEN MUST NOT 含 `AbortSignal`、client、function、stream、credential 或 token
- AND 所有欄位 MUST 為 JSON 可序列化

#### Scenario: 缺 mandatory correlation 於 production fail-closed

- GIVEN 運行於 production profile
- AND `context` 缺 `runId` 或 `taskId`
- WHEN 建立 envelope
- THEN MUST fail-closed
- AND MUST NOT 以空值或推導值補齊

### Requirement: 穩定 payload schema 分類

事件 payload MUST 依穩定分類（Run、Task、Step、model、Tool、permission、reconciliation、compensation、context、card、terminal）定義型別與 Enum，MUST NOT 以 `unknown` 或 loose `Record<string, unknown>` 取代對外契約。新 envelope 的 `type` MUST 統一 dot-style 命名，legacy adapter MUST 提供 old-type → new-type 的單一來源映射。使用者可見標籤 MUST NOT 進入 machine event 欄位。

#### Scenario: 每一分類有型別契約

- GIVEN 任一類別的事件
- WHEN 檢查其 payload
- THEN MUST 具備明確欄位、Enum、長度與可選性
- AND 顯示文案（label）MUST NOT 被當作狀態來源

#### Scenario: type 命名統一 dot-style

- GIVEN 一個新 envelope 的事件
- WHEN 檢查其 `type`
- THEN MUST 使用 dot-style（如 `task.created`／`step.started`／`tool.start`）
- AND legacy snake_case／舊 dot 識別 MUST 經 adapter 映射至新識別

### Requirement: Run status 三層契約與單向收斂

Run 級 status MUST 分三層：`running`（進行中）、waiting/parking（`needs_user`、`manual_intervention_required`，可 resume）、與硬終止（`completed`、`failed`、`cancelled`、`timed_out`、`crashed`、`budget_exhausted`、`superseded`）。單向收斂 MUST 只作用於硬終止集合：一旦進入硬終止，MUST NOT 因 duplicate、late 或 replayed progress 回到 `running` 或 waiting。`needs_user` 與 `manual_intervention_required` 為可復原狀態，MUST 能 transition 至 `running` 或任一硬終止。

#### Scenario: 硬終止後 late progress 被忽略

- GIVEN 一次 Run 已進入硬終止（例如 `completed`）
- WHEN 一個 late 的 progress 事件到達
- THEN 消費端 MUST 忽略該事件
- AND MUST 保持硬終止狀態不變
- AND 忽略行為 MUST 可觀察（reason code）

#### Scenario: needs_user 可 resume

- GIVEN 一次 Run 進入 `needs_user`（等待 HITL／clarification）
- WHEN 使用者回應
- THEN Run MUST 能 transition 回 `running`（同 runId 續跑）
- AND 不視為違反單向收斂

#### Scenario: manual_intervention_required 可 resume 或終止

- GIVEN 一次 Run 進入 `manual_intervention_required`（停靠）
- WHEN operator 介入
- THEN Run MUST 能 transition 至 `running` 或任一硬終止

### Requirement: runStatusOf 覆蓋全部 TaskStatus

`runStatusOf(taskStatus)` MUST 對既有 13 個 `TaskStatus` 值皆有明確映射，MUST NOT 有未定義輸入，回傳三層 `RunStatus`（`running`／waiting／硬終止之聯集）。瞬態狀態（`created`、`running`、`cancelling`、`compensating`、`rollback_requested`、`partially_failed`）MUST 映射至 `running`（非終止）；`waiting_confirmation` MUST 映射至 `needs_user`；六個 terminal 值 MUST 映射至對應硬終止。

#### Scenario: 全部 13 個 TaskStatus 有明確歸屬

- GIVEN 任一 `TaskStatus` 值（`created`、`running`、`waiting_confirmation`、`completed`、`partially_failed`、`compensating`、`failed`、`cancelled`、`cancelling`、`superseded`、`rollback_requested`、`cancelled_after_commit`、`manual_intervention_required`）
- WHEN 呼叫 `runStatusOf(taskStatus)`
- THEN MUST 回傳明確定義的 Run status
- AND MUST NOT 拋出未處理錯誤或回傳未定義

#### Scenario: cancelled_after_commit 語意不變

- GIVEN `taskStatus = cancelled_after_commit`
- WHEN 映射
- THEN MUST 映射至 `cancelled` 並以 reason code `cancelled_after_commit` 區分
- AND 既有可觀察語意 MUST 不變

### Requirement: 前端去重與 bounded reordering

Frontend MUST 以 `eventId` 去重、以 `(runId, sequence)` 做 bounded reordering buffer，且 buffer MUST 有上限（有預設值、可配置、超窗推進具可觀察 metric）；duplicate 交付 MUST 只改變一次狀態。

#### Scenario: duplicate 交付只改變一次狀態

- GIVEN 同一 `eventId` 的事件被重複交付
- WHEN reducer 處理
- THEN 第二次及之後的交付 MUST NOT 再改變狀態
- AND 去重集合 MUST 有界（不無限制成長）

#### Scenario: bounded out-of-order 收斂

- GIVEN 亂序到達的事件（sequence 缺口小於 window）
- WHEN reducer 依 window buffer 排序
- THEN MUST 收斂至與有序到達相同的確定性結果
- AND 缺口大於 window 時 MUST 向前推進而非無限等待
- AND 推進行為 MUST 有可觀察 metric

### Requirement: 未知 type／major 不匹配安全降級

未知 `type` 或 major 不匹配的 `schemaVersion` MUST 轉為 `unknown` presentation event，MUST NOT 使 Chat UI 崩潰。

#### Scenario: 未知 type 降級

- GIVEN 一個未知 `type` 的事件
- WHEN frontend 解析
- THEN MUST 呈現為 `unknown` presentation event
- AND Chat UI MUST 繼續運作不崩潰

### Requirement: 新 terminal status 區分呈現

`timed_out`、`crashed`、`budget_exhausted`、`superseded` 等新 terminal status MUST 在 UI 與既有 `cancelled`／`failed` 區分呈現，MUST NOT 混為一般失敗。

#### Scenario: timeout 不渲染成一般失敗

- GIVEN 一次 Run 以 `timed_out` 硬終止
- WHEN frontend 渲染
- THEN MUST 呈現 timeout 語意
- AND MUST NOT 渲染成一般 `failed` 或 `cancelled`

### Requirement: generation 與 authoritative Run ownership 為第二道 stale guard

generation 與 authoritative Run ownership MUST 作為第二道 stale-output guard；superseded Run 的輸出 MUST NOT 覆蓋 authoritative Run。

#### Scenario: superseded Run 輸出被丟棄

- GIVEN 一個已 superseded 的 Run 產生的事件
- WHEN 該事件到達 frontend
- THEN MUST 依 generation／authoritative Run ownership 被丟棄
- AND MUST NOT 取代 authoritative Run 的輸出

### Requirement: Feature flag 回滾開關

版本化 envelope 的 emit 與 parse MUST 由 feature flag（`RUNTIME_EVENT_ENVELOPE_ENABLED`，預設 `true`）控制；`false` 時 backend MUST 回退至 legacy 事件格式、frontend MUST 走 legacy parser。disabled 路徑 MUST 有回歸測試。

#### Scenario: flag 停用回退至 legacy 格式

- GIVEN `RUNTIME_EVENT_ENVELOPE_ENABLED = false`
- WHEN backend 產生事件
- THEN MUST emit legacy 格式（`TaskEvent`／`AgentRuntimeEvent`）
- AND frontend MUST 以 legacy parser 承接，不得中斷串流

#### Scenario: flag 預設啟用

- GIVEN 未設定 `RUNTIME_EVENT_ENVELOPE_ENABLED`
- WHEN backend 產生事件
- THEN MUST emit versioned envelope

### Requirement: BFF 透傳契約

BFF MUST 只透傳 event bytes，不做語意改寫，並保留 chunk 順序、client disconnect 傳遞、upstream abort 與 backpressure；MUST NOT 無限制累積 stream buffer。

#### Scenario: stream 直通不變

- GIVEN 一次 LangGraph stream 經 BFF 代理
- WHEN 檢查 BFF 行為
- THEN event payload MUST 不被語意改寫
- AND chunk 順序、SSE framing、backpressure 與 abort 語意 MUST 保持不變

### Requirement: Versioned adapter 承接未版本化事件

既有未版本化事件 MUST 於 bounded migration window 內由 versioned adapter 承接；新 producer MUST 發 versioned envelope；舊事件可省略新欄位且消費端 MUST 容忍。

#### Scenario: legacy 事件於 migration 期被承接

- GIVEN 一個未版本化的 legacy 事件（缺 `schemaVersion`／`sequence`）
- WHEN 消費端解析
- THEN MUST 由 adapter 包裹或視為 legacy 承接
- AND MUST NOT 使新 parser 崩潰

#### Scenario: 新 producer 必發 versioned envelope

- GIVEN 一個新的事件產生端（且 flag 啟用）
- WHEN 產生事件
- THEN MUST 發 versioned envelope
- AND MUST NOT 只發 legacy 格式

### Requirement: 跨層契約測試與三套件驗證

跨層契約測試 MUST 涵蓋全部硬終止 status、waiting 狀態 resume、duplicate、out-of-order、late progress、unknown degrade、forward-compat version、feature flag disabled、disconnect／reconnect 與 checkpoint replay；frontend、bff、backend 三套件的 build／test MUST 實際執行並通過。

#### Scenario: 跨層契約測試矩陣

- GIVEN 需要驗證的契約
- WHEN 執行 contract tests
- THEN MUST 覆蓋七個硬終止、`needs_user`／`manual_intervention_required` resume、duplicate、out-of-order、late progress、unknown degrade、forward-compat、flag disabled、reconnect 與 replay
- AND frontend／bff／backend 三套件 build 與 test MUST 通過
