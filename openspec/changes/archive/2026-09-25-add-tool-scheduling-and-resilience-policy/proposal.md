# Proposal：add-tool-scheduling-and-resilience-policy

## 變更摘要

把 Tool 的 concurrency 與 resilience 行為，從「依賴 ToolNode 預設、Tool 名稱或個別 Tool 實作自行決定」的現況，收斂為**由 `RuntimeToolDescriptor` 驅動、可強制執行的排程與韌性政策**：在 X14 統一 dispatch pipeline 的既有 concurrency 分類之上，補齊「model-produced Tool batch 的 partitioning」「可設定且有界、於 startup 驗證的 scheduler capacity」「宣告於 Tool governance 的 rate-limit 與 circuit-breaker 政策」「只接 definitive retryable outcome 且套用 backoff／bounded Retry-After 的 retry loop」「貫穿排程、backoff、invocation 與 child work 的 AbortSignal 傳播」「queue／permission／backoff／execution／reconciliation／total 的分段 latency 追蹤」，並把既有 distributed Step lock 與 DB CAS 接線到 dispatch 的 state transition，明確「lock 只保護 transition、不取代 business-effect idempotency」。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X16**，是 Layer 5（Tool Execution Hardening）的第三個 Change，與 X15（`harden-provider-and-tool-call-decoding`）平行。前置 X2（`add-agent-retry-budget`）、X5（`add-distributed-step-lock`）與 X14（`establish-unified-tool-dispatch-pipeline`）均已 archive。X14 已建立 `BoundedToolDispatchScheduler`（`runtime/tool-dispatch/scheduler.ts`）與 `RuntimeToolDescriptor`（`runtime/tool-dispatch/runtime-tool-descriptor.ts`），但 concurrency 只停在「safe／serial」二分，**沒有 rate-limit、沒有 circuit-breaker、retry loop 沒有 backoff、read-only 不 retry、distributed lock 未接線、latency 未分段**，使 X16 Acceptance 的七項要求大多尚未成立。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，以唯讀盤點 backend 現況）：

1. **Scheduler 只做二分 concurrency，無韌性政策，且 limit 寫死**：`runtime/tool-dispatch/scheduler.ts:13` 的 `BoundedToolDispatchScheduler` 建構子 `maxConcurrentReads = 4` 為 hardcoded 預設，非 config 驅動、無 per-Run／per-process 有界上限、無 startup 驗證；`schedule()`（`scheduler.ts:19-26`）只接受已算好的 `concurrencySafe: boolean`，`acquireReadSlot`／`serialTail` 等待（`scheduler.ts:56-72`）**不接收 AbortSignal**，排隊中的工作無法被取消；亦無 rate-limit／circuit-breaker 攔截。

2. **Descriptor 缺 resilience 政策欄位**：`RuntimeToolDescriptor`（`runtime-tool-descriptor.ts:33-45`）只有 `timeoutPolicy`／`retryPolicy`／`isConcurrencySafe`／`interruptBehavior`，**沒有 `rateLimitPolicy`、沒有 `circuitBreakerPolicy`**；因此 rate-limit 與 circuit-breaker 無法定義為 Tool governance 的一部分。

3. **Retry loop 無 backoff、不尊重 Retry-After，read-only 不 retry**：`runtime/side-effect/tool-execution-runner.ts` 的 `executeReadOnly`（`tool-execution-runner.ts:234-247`）只呼叫一次 `executor.executeTyped` 就回傳，**timed-out read-only 不重試**，違反 X16「A timed-out read-only Tool may retry within budget」；mutation 的 `failed_not_committed` retry 分支（`tool-execution-runner.ts:602-617`）只做 `checkBudget` 後 `continue`，**完全沒有 backoff delay、不套用 `computeBackoff`、不尊重 Retry-After**。

4. **`computeBackoff` 與 retry-after-header 已存在但未接線**：`runtime/retry/backoff.ts:20-47` 的 `computeBackoff` 已支援 `retry-after-header`（`retryAfterMs`）策略，但只在 `runtime/retry/retry-executor.ts:174` 被呼叫；而 `executeWithRetry`（`retry-executor.ts:91`）**僅被其自身 test 引用**，未被 production dispatch 路徑使用。實際 production retry 是 `tool-execution-runner.ts` 內的手寫 loop，兩套 retry 語意彼此孤立。

5. **Distributed Step lock 與 DB CAS 未接線 dispatch**：`runtime/lock/step-lock.ts:43-90`（`RedisStepLock`）與 `runtime/lock/step-transition-guard.ts:62`（`DefaultStepTransitionGuard`）已存在，但只在自身 test 與 `lock/index.ts` 被引用；`tool-dispatch/pipeline.ts` 與 `scheduler.ts` 皆未 import。production dispatch 的 state transition 目前只靠 ledger 的 `transitionExecution`（`expectedStatus`／`nextStatus` DB CAS），**Step-level lock 的 lock-expiry／owner-mismatch 保護未套用**。

6. **無 circuit-breaker、無 Tool-level rate-limit policy**：全域盤點無任何 circuit breaker 程式碼；`rate_limit` 目前只是 retry 的 error category（`retry-policy.ts:15` 的 `retryableCategories`），`add-redis-rate-limit` 屬 BFF transport 層限流，**Tool governance 層沒有主動 rate-limit policy**。

7. **Latency 未分段**：現行 observability 只有 `tool.dispatch.count`（`pipeline.ts`）與 `tool.side_effect.outcome`（`tool-execution-runner.ts:563`）等計數，**沒有 queue wait／permission wait／backoff／execution／reconciliation／total 的分段 latency**，無法證明 X16 Acceptance「Metrics separate queue, permission, retry, execution, and reconciliation latency」。

綜合而言，X14 已把 concurrency classification 放進 pipeline（`pipeline.ts:366-376` 計算 `isConcurrencySafe`），但 classification 之後的**排程容量、rate-limit、circuit-breaker、backoff、lock 與 latency 分段**仍是缺口，正違反 X16 Goal「Make concurrency and resilience behavior explicit and enforceable」與 X11 Cross-Layer Invariant #5（retry 永不暗示 side effect 可重複）／#8（stable machine identifiers 驅動行為）。

## 解決方案

以「descriptor 擴充 + 單一 resilience scheduler + retry loop 補 backoff + lock 接線 + startup config 驗證 + latency 分段」收斂：

1. **擴充 `RuntimeToolDescriptor`（descriptor-driven）**：新增可選 `rateLimitPolicy?: ToolRateLimitPolicy`（`maxRequestsPerWindow`／`windowMs`）與 `circuitBreakerPolicy?: ToolCircuitBreakerPolicy`（`failureThreshold`／`successThreshold`／`resetTimeoutMs`／`halfOpenMaxProbes`），由 Tool governance 宣告、單一 registry 供給；既有 `isConcurrencySafe(input)` 維持為 concurrency classification 的唯一來源（不引入 Tool 名稱 switch）。

2. **單一 resilience scheduler 取代既有二分 scheduler**：新增 `runtime/tool-dispatch/rate-limiter.ts`（bounded window／token-bucket，回 allow／defer（附 `retryAfterMs` hint）／deny）與 `runtime/tool-dispatch/circuit-breaker.ts`（closed／open／half-open，依 definitive outcome 轉態，open 時不 dispatch 即回 stable `circuit_open` classification）；擴充 `scheduler.ts` 為 policy-aware，在 dispatch 前依序執行 rate-limit 判定、circuit-breaker 判定、concurrency 排隊（read concurrency-safe bounded concurrent、mutation／unknown serial），全程接收並傳播 `AbortSignal`。

3. **retry loop 補 backoff 與 bounded Retry-After**：`tool-execution-runner.ts` 的 retry 路徑改以 `computeBackoff`（含 `retry-after-header` 策略、`retryAfterMs` 上限 bounded）計算延遲，並讓 backoff wait 可被 `AbortSignal` 中斷；read-only path 引入「timed-out read-only 於 retry budget 內可重試」的 bounded retry（無 ledger）；mutation 只在 `not_committed` reconcile 或 external idempotency guarantee 後才 retry，其餘 definitive outcome（authorization deny／user cancel／business reject／invalid schema／unknown side-effect）一律不 retry。

4. **distributed Step lock／CAS 接線 dispatch state transition**：把 `StepLock` 與 `StepTransitionGuard` 接進 scheduler／pipeline 的 Step 狀態推進，確保 lock expiry／owner mismatch 不得 corrupt Step state；lock 只保護 transition，business-effect idempotency 仍由 side-effect ledger 的 `businessEffectKey` 保證（lock 永不取代 idempotency）。

5. **scheduler capacity 於 startup 驗證**：`maxConcurrentReads`、rate-limit、circuit-breaker、Retry-After 上限等移入 `platform/runtime-config.ts` 單一來源，具預設值、explicit override 與 startup 驗證（invalid 值 fail-fast），capacity bounded per Run 且 per process。

6. **latency 分段追蹤**：新增 queue wait／permission wait／backoff／execution／reconciliation／total 的分段 span 與 metric，接 X12 `ExecutionContext` 的 `runId`／`taskId`／`stepId`／`toolCallId` correlation。

## 受影響範圍

### 受影響套件

- `backend`：`runtime/tool-dispatch/scheduler.ts`（改，policy-aware + AbortSignal）、`runtime/tool-dispatch/runtime-tool-descriptor.ts`（改，rateLimit／circuitBreaker 欄位）、`runtime/tool-dispatch/rate-limiter.ts`（新）、`runtime/tool-dispatch/circuit-breaker.ts`（新）、`runtime/tool-dispatch/pipeline.ts`（改，接 rate-limit／circuit-breaker／lock／latency）、`runtime/side-effect/tool-execution-runner.ts`（改，backoff + read-only retry）、`platform/runtime-config.ts`（改，scheduler／rate-limit／circuit-breaker 設定）、對應 `*.test.ts` 與 fault-injection／architecture test。

### 受影響能力域

- Tool dispatch 邊界（concurrency classification 之後的排程與韌性政策）。
- Retry／backoff（Retry-After bounded、read-only bounded retry、cancellation）。
- 可觀測性（queue／permission／backoff／execution／reconciliation／total latency 分段）。
- Distributed Step lock／DB CAS 與 side-effect idempotency 的責任邊界。

### 既有能力原語（本 Change 接線、不重造）

- `runtime/retry/`（`retry-budget.ts`、`backoff.ts`、`error-classification.ts`、`retry-policy.ts`，X2）。
- `runtime/lock/step-lock.ts`、`runtime/lock/step-transition-guard.ts`（X5）。
- `runtime/tool-dispatch/scheduler.ts`、`pipeline.ts`、`runtime-tool-descriptor.ts`（X14）。
- `runtime/side-effect/tool-execution-runner.ts`、`business-effect-ledger.ts`（X8.6）。
- X12 `canonical-execution-context`（`runId`／`taskId`／`stepId`／`toolCallId` correlation）。
- `platform/observability.ts`（`recordMetric`）與 `platform/tracing/`（span）。

## 目標

- Concurrency-safe read-only Tool 呼叫於設定上限內 bounded concurrent；mutation 與 unknown Tool serial。
- Classification 失敗（`isConcurrencySafe` 拋錯或 input validation 失敗）MUST 保守 serial／no-dispatch，MUST NOT 提升 concurrency。
- Retry 只接 definitive retryable outcome；authorization deny／user cancel／business reject／invalid schema／unknown side-effect 不自動 retry。
- Retry Budget、cancellation、bounded Retry-After、circuit-open、max elapsed time 皆被強制。
- Scheduler capacity bounded per Run 且 per process，配置於 startup 驗證。
- Distributed Step lock 與 DB CAS 保護 state transition；lock 永不取代 business-effect idempotency。
- Fault injection 證明 retry／resume 下無 duplicate side effect。
- Metrics 分離 queue／permission／backoff／execution／reconciliation latency。

## 非目標

- ❌ 不做 unbounded `Promise.all` 一次並發所有 model Tool calls。
- ❌ 不以固定 Tool 名稱清單決定 concurrency safety。
- ❌ 不以固定延遲掩蓋 race（backoff 有 bounded 語意，非寫死 sleep）。
- ❌ 不宣稱 distributed exactly-once；仍以 durable identity、idempotency 與 reconciliation 為準。
- ❌ 不變更既有 Graph ID、公開 BFF route、Tool 名稱或既有 error-code 語意。
- ❌ 不重造 X14 已建立的統一 registry／pipeline／structured result（本 Change 在 classification 之後補排程與韌性政策）。
- ❌ 不新增 frontend／bff 變更（本 Change 屬 backend 邊界；前端承接的仍是 X14 structured result envelope）。
- ❌ 不把 BFF transport 層的 Redis 限流與 Tool governance 層的 rate-limit 混為一談（兩者責任邊界不同，本 Change 只做後者）。

## 風險

| 風險 | 緩解 |
|---|---|
| retry loop 加 backoff 後，既有 mutation retry 行為（X14 既有的 reconcile-then-retry）被誤改 | backoff 只影響延遲與 Retry-After 上限，不改變「reconcile 後才 retry」的順序；以 X14 side-effect runner 既有 test 全量回歸 |
| circuit-breaker 誤判為 open，正常 Tool 被延後或拒絕 | open 只對 definitive failure 累積，且有 `resetTimeoutMs` 與 half-open probe；config 有預設值與 override |
| rate-limit 上限設定過嚴，誤拒合法 burst | 上限採 runtime-config 單一來源，window/token-bucket 有 bounded 語意；defer 附 `retryAfterMs` 供 scheduling 與 tracing |
| `AbortSignal` 接進 queue wait 後，取消 race 造成 state 不一致 | 取消只收斂到 terminal；dispatch「before」與「after」狀態維持 X14 的 dispatchState 區分 |
| lock 接線後 lock expiry／owner mismatch 誤傷 Step 進度 | lock 只保護 transition；失敗時回 stable error 不 corrupt state；`NoopStepLock` 供無 Redis 的 dev/測試路徑 |
| latency 分段引入額外 span 成本 | 分段只在必要 span 記錄，metrics 採既有 `recordMetric` 聚合，不新增高頻 unbounded 資料 |

## 回滾策略

本 Change 為 backend 邊界的 additive 變更：新增 `rate-limiter.ts`／`circuit-breaker.ts` 模組與 descriptor 欄位（`rateLimitPolicy?`／`circuitBreakerPolicy?` 可選，未設定時走既有二分 scheduler 行為）；scheduler 的 concurrency 二分語意不變，只在其上游補 rate-limit／circuit-breaker 判定與 `AbortSignal`。若驗證失敗，可逐模組 revert 回既有 `BoundedToolDispatchScheduler`；retry 的 backoff 若出錯，可回退到「無 backoff 的既有 `continue`」而不影響 reconcile 順序。無資料庫 migration、無 Graph ID／route 變更，frontend／bff 不受影響。
