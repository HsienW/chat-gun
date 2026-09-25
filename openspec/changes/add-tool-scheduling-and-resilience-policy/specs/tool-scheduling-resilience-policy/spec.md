# tool-scheduling-resilience-policy Specification Delta

## Purpose

本規格定義 Tool 排程與韌性政策的正式需求：以 `RuntimeToolDescriptor` 驅動 concurrency 與 resilience 行為，使 model-produced Tool batch 依 descriptor 分類後執行（read concurrency-safe 於設定上限內 bounded concurrent、mutation／unknown serial）；分類失敗保守降級；retry 只接 definitive retryable outcome 且套用 bounded backoff 與 Retry-After；rate-limit 與 circuit-breaker 由 Tool governance 宣告並於 dispatch 前強制；`AbortSignal` 貫穿排程、backoff、invocation 與 child work；distributed Step lock 與 DB CAS 保護 state transition 且 lock 永不取代 business-effect idempotency；queue／permission／backoff／execution／reconciliation／total latency 分段可觀測。

## ADDED Requirements

### Requirement: model-produced Tool batch MUST 依 descriptor 與 input 分類後執行

model-produced Tool batch MUST 依每個 validated descriptor 與 input 分類；分類結果必須把「read-only 且 `isConcurrencySafe(input)` 的 Tool」與「mutation／destructive／unknown Tool」分開，且不得以固定 Tool 名稱清單或 ToolNode 預設作為 concurrency 判定。

#### Scenario: read concurrency-safe 於上限內 concurrent

GIVEN 一個 model-produced batch 含多個 read-only 且 `isConcurrencySafe(input)` 為 true 的 Tool
WHEN 執行排程
THEN MUST 於設定上限內 bounded concurrent 執行
AND MUST NOT 以固定 Tool 名稱清單決定 concurrency

#### Scenario: mutation 與 unknown serial

GIVEN batch 含 mutation、destructive 或 unknown 分類的 Tool
WHEN 執行排程
THEN MUST serial 執行
AND MUST NOT 與其他 mutation 併發

#### Scenario: 分類拋錯或 input validation 失敗保守降級

GIVEN `isConcurrencySafe` 拋錯或 input validation 失敗
WHEN 執行排程
THEN MUST 保守 serial 或 no-dispatch
AND MUST NOT 提升 concurrency

---

### Requirement: scheduler capacity MUST 有界且於 startup 驗證

scheduler 的 read concurrency 上限 MUST 由單一來源 config 供給、有 bounded 語意、per Run 與 per process 皆 bounded，並於 startup 驗證（invalid 值 fail-fast）。

#### Scenario: config 驅動且 invalid 值 fail-fast

GIVEN scheduler capacity 設定於 runtime-config
WHEN 啟動時讀取並驗證
THEN MUST 有預設值與 explicit override
AND invalid 值（0／負數／非整數）MUST fail-fast 或回 stable error
AND MUST NOT 以 hardcoded 常數作為 production 上限

#### Scenario: per Run 與 per process 皆 bounded

GIVEN 多個 Run 共用同一個 process 內 scheduler
WHEN 執行排程
THEN 單一 Run MUST NOT 佔滿全部 read slot
AND process 層級的 concurrency MUST 有界

#### Scenario: per-Run bound 已滿回 stable deferred 且不阻塞其他 Run

GIVEN 一個 Run 的 active read 已達 per-Run 上限
WHEN 該 Run 再請求 read slot
THEN MUST 回 stable deferred（不 queue 等待）
AND MUST NOT 阻塞其他 Run 取得 read slot
AND Run terminal 後其 capacity entry MUST 被清理（不 memory leak）

---

### Requirement: rate-limit policy MUST 由 Tool governance 宣告並於 dispatch 前強制

Tool 的 rate-limit policy MUST 宣告於 `RuntimeToolDescriptor`，於 dispatch 前強制；未宣告 policy 的 Tool 不受影響；超過上限 MUST 回 stable `defer`（附 bounded `retryAfterMs` hint）或 `deny`，MUST NOT 以寫死延遲掩蓋。

#### Scenario: 未宣告 policy 不受影響

GIVEN 一個未宣告 `rateLimitPolicy` 的 Tool
WHEN 執行 rate-limit 判定
THEN MUST `allow`
AND 行為與既有路徑一致

#### Scenario: 超過上限回 defer 附 retryAfterMs

GIVEN 一個宣告 `rateLimitPolicy` 且 window 內已達上限的 Tool
WHEN 執行 rate-limit 判定
THEN MUST 回 `defer` 且附 bounded `retryAfterMs`
AND `retryAfterMs` MUST 以 `toolRetryAfterMaxMs` 為 upper bound clamp
AND MUST NOT dispatch 該次呼叫
AND MUST NOT 寫死固定 sleep 等待

#### Scenario: rate-limit 不 dispatch

GIVEN rate-limit 判定為 `deny`
WHEN 執行 dispatch pipeline
THEN MUST 回 stable classification（`TOOL_RATE_LIMITED`）
AND MUST NOT dispatch 下游 Tool

---

### Requirement: circuit-breaker policy MUST 由 Tool governance 宣告且 open 不 dispatch

Tool 的 circuit-breaker policy MUST 宣告於 `RuntimeToolDescriptor`；依 definitive outcome 於 closed／open／half-open 間轉態；open 時 MUST 回 stable retryable/deferred classification 且不 dispatch 下游 Tool；outcome 分類依 stable error category，不得依 error-message substring。

#### Scenario: definitive failure 達閾值 open 且不 dispatch

GIVEN 一個宣告 `circuitBreakerPolicy` 的 Tool 其 definitive failure 累積達 `failureThreshold`
WHEN circuit 進入 open
THEN MUST 回 stable classification（error code `TOOL_CIRCUIT_OPEN`）
AND MUST NOT dispatch 下游 Tool

#### Scenario: resetTimeout 後 half-open 限量 probe

GIVEN circuit 處於 open 且已過 `resetTimeoutMs`
WHEN 進入 half-open
THEN MUST 以 `halfOpenMaxProbes` 限量 probe
AND probe 成功達 `successThreshold` MUST 回 closed
AND probe 失敗 MUST 回 open

#### Scenario: 未宣告 policy 恆 closed

GIVEN 一個未宣告 `circuitBreakerPolicy` 的 Tool
WHEN 執行 circuit 判定
THEN MUST 恆為 `closed`
AND 行為與既有路徑一致

---

### Requirement: retry MUST 只接 definitive retryable outcome 且套用 bounded backoff 與 Retry-After

retry 只接 definitive retryable outcome；authorization deny、user cancel、business reject、invalid schema、unknown side-effect state MUST NOT 自動 retry；timed-out read-only Tool MAY 於 retry budget 內 retry；mutation Tool 只在 `not_committed` reconcile 或 external idempotency guarantee 後 retry；retry 延遲 MUST 套用 `computeBackoff` 且 `Retry-After` 以 bounded 上限尊重，backoff wait 可被 `AbortSignal` 中斷。

#### Scenario: 非 retryable outcome 不重試

GIVEN authorization deny／user cancel／business reject／invalid schema／unknown side-effect state
WHEN 執行 retry 決策
THEN MUST NOT 建立新的 physical attempt
AND MUST NOT 進入 retry budget

#### Scenario: timed-out read-only 於 budget 內可重試

GIVEN 一個 timed-out read-only Tool
AND retry budget 允許
WHEN 執行 retry
THEN MAY 於 budget 內重試
AND MUST NOT 建立 side-effect ledger 紀錄

#### Scenario: mutation 只在 not_committed 後重試

GIVEN 一個 mutation Tool 產生 ambiguous outcome
WHEN 執行 retry 決策
THEN MUST 先 reconcile 判定 committed／not_committed／unknown
AND retry 只接 `not_committed` 或 external idempotency guarantee
AND MUST NOT 於未 reconcile 前 blind retry

#### Scenario: retry 套用 bounded backoff 與 Retry-After

GIVEN 一個可重試的 `failed_not_committed` outcome
WHEN 計算 retry 延遲
THEN MUST 套用 `computeBackoff`
AND `Retry-After` MUST 以 bounded 上限尊重
AND backoff wait MUST 可被 `AbortSignal` 中斷（中斷回 `USER_CANCELLED`）

---

### Requirement: AbortSignal MUST 貫穿排程、backoff、invocation 與 child work

`AbortSignal` MUST 自排隊等待、rate-limit／circuit-breaker 等待、backoff、Tool invocation 一路傳播至 child work；取消 MUST 收斂到 terminal，且排隊中的 waiter MUST NOT leak。

#### Scenario: abort 中斷 queue wait

GIVEN 一個正在排隊等待 read slot 或 serial tail 的工作
WHEN `AbortSignal` 觸發
THEN MUST 立即停止等待
AND MUST 回 cancelled（`USER_CANCELLED`）
AND MUST NOT leak waiter

#### Scenario: cancel 收斂且不重置 state

GIVEN 取消與 dispatch race
WHEN 執行取消決策
THEN MUST 收斂到單一 terminal ownership 決策
AND MUST NOT 讓 terminal execution 回到 running

---

### Requirement: distributed Step lock 與 DB CAS MUST 保護 state transition 且 lock 不取代 idempotency

dispatch 的 Step 狀態推進 MUST 由 distributed Step lock 與 DB CAS 保護；lock expiry 或 owner mismatch MUST 回 stable error 且不得 corrupt Step state；lock MUST 只保護 transition，business-effect idempotency MUST 由 side-effect ledger 的 `businessEffectKey` 保證。

#### Scenario: lock expiry 不 corrupt Step state

GIVEN 一個 Step lock 於執行中 expiry
WHEN 另一個 owner 嘗試推進同一步驟
THEN MUST 回 stable error 或依 CAS 拒絕
AND MUST NOT corrupt Step state

#### Scenario: owner mismatch 不覆蓋

GIVEN 一個持有 lock 的 owner 與實際寫入者不符
WHEN 執行 state transition
THEN MUST 拒絕
AND MUST NOT 覆蓋其他 owner 的進度

#### Scenario: lock 於長 Tool 執行期間被 extend

GIVEN 一個 Tool execution 時間接近或超過 lock TTL
WHEN 執行期間 lock 以 heartbeat 被 extend
THEN MUST 於 complete／fail／abort／cancel 時 release
AND extend 失敗 MUST 停止 Tool 並回 stable error（`TOOL_STEP_LOCK_EXTEND_FAILED`）
AND MUST NOT 讓 lock 於執行中途過期

#### Scenario: lock 不取代 idempotency

GIVEN 一個 mutation Tool 已 commit business effect
WHEN 以相同 business-effect key 於 lock 內重試或 resume
THEN MUST NOT 重複 commit（idempotency 由 ledger 保證）
AND lock MUST NOT 成為 idempotency 的替代來源

---

### Requirement: queue／permission／backoff／execution／reconciliation／total latency MUST 分段可觀測

排程與韌性政策 MUST 以分段 span／metric 記錄 queue wait、permission wait、backoff、execution、reconciliation 與 total latency，並接 canonical `runId`／`taskId`／`stepId`／`toolCallId` correlation。

#### Scenario: 分段 latency 具獨立 metric

GIVEN 一個 Tool dispatch 完成
WHEN 記錄 observability
THEN queue wait、permission wait、backoff、execution、reconciliation、total MUST 各具獨立 metric／span
AND MUST 接 canonical correlation
AND MUST NOT 以單一 count 取代 latency 分段

---

### Requirement: 既有 Weather／Web／Calculator／MCP 行為 MUST 保持相容

本 Change 接線後，既有 Weather／Web／Calculator／MCP 的 Tool 行為 MUST 保持相容；未宣告 rate-limit／circuit-breaker 的 Tool 走既有二分排程路徑；MUST NOT 變更既有 Graph ID、公開 BFF route、Tool 名稱或 error-code 語意。

#### Scenario: 既有行為回歸通過

GIVEN 本 Change 已接線
WHEN 執行既有 Weather／Web／Calculator／MCP 回歸
THEN MUST 通過
AND MUST NOT 變更既有 Graph ID／公開 route／Tool 名稱／error-code 語意
