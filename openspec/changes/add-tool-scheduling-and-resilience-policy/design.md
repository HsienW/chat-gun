# Design：add-tool-scheduling-and-resilience-policy

## 責任邊界

本 Change 只落在 **backend** 的 Tool dispatch 排程與韌性政策邊界；**不變更 frontend、bff**。frontend 承接的仍是 X14 既有的 versioned structured tool result envelope，本 Change 不新增任何跨層欄位或 route。rate-limit／circuit-breaker 是 Tool governance 層的政策，與 BFF transport 層的 Redis 限流（`add-redis-rate-limit`）責任邊界不同，不得混用。

## 資料流

### Before（現況，二分排程、無韌性）

```text
LangGraph ToolNode batch (多個 tool call)
  → pipeline.dispatch()（每個 tool call 各自進入）
      → inputSchema.safeParse
      → isConcurrencySafe 分類（isReadOnly && isConcurrencySafe(input)）
      → scheduler.schedule(concurrencySafe, operation)
          → concurrencySafe ? bounded read (max=4 hardcoded) : serial
      → toolExecutionRunner.execute()
          → read-only：executeTyped 一次即回（無 retry）
          → mutation：dispatchAttempts loop（reconcile-then-retry，但 continue 無 backoff）
  → recordMetric("tool.dispatch.count")   // 無 latency 分段
```

### After（descriptor-driven 排程 + 韌性政策 + latency 分段）

```text
LangGraph ToolNode batch
  → batch partition（依 descriptor.isReadOnly / isConcurrencySafe(input) 分類）
      → read concurrency-safe：bounded concurrent（configurable global limit）
      → mutation / destructive / unknown：serial
  → 每個 tool call 進入 pipeline.dispatch()
      → inputSchema.safeParse
      → concurrency classification（分類拋錯 → conservative serial/no-dispatch）
      → rate-limit policy 判定（allow / defer{retryAfterMs} / deny）
      → circuit-breaker policy 判定（closed / half-open probe / open → circuit_open，不 dispatch）
      → scheduler.schedule(classification, operation, { signal })
          → queue wait 可被 AbortSignal 中斷
      → toolExecutionRunner.execute({ retryBudget, retryPolicy, signal })
          → read-only：bounded retry（timed-out 於 budget 內可重試，無 ledger）
          → mutation：dispatchAttempts loop（reconcile-then-retry + computeBackoff / bounded Retry-After）
      → Step lock / DB CAS 保護 state transition（lock ≠ idempotency）
      → circuit-breaker record()（依 outcome 映射記 success / definitive_failure）
  → recordSpan/metric：queue wait / permission wait / backoff / execution / reconciliation / total
```

## 模組設計

### `runtime/tool-dispatch/rate-limiter.ts`（新）

Tool governance 宣告的主動限流，採 bounded window（或 token-bucket），回穩定分類：

```typescript
export interface ToolRateLimitPolicy {
  maxRequestsPerWindow: number;
  windowMs: number;
}

export type RateLimitDecision =
  | { type: "allow" }
  | { type: "defer"; retryAfterMs: number }   // 附 bounded hint，供 scheduling 與 tracing
  | { type: "deny"; errorCode: "TOOL_RATE_LIMITED" };

export interface ToolRateLimiter {
  check(toolName: string, policy: ToolRateLimitPolicy | undefined, signal?: AbortSignal): RateLimitDecision;
}
```

- `policy === undefined` → `allow`（未宣告限流的 Tool 不受影響，向後相容）。
- window 有單一來源與 bounded 語意；`retryAfterMs` 為下限 hint，且 MUST 以 config `toolRetryAfterMaxMs` 為 upper bound clamp（`defer.retryAfterMs = Math.min(hint, toolRetryAfterMaxMs)`），實際等待由 scheduler 以 `AbortSignal` 可中斷的方式處理。極端 window 設定下 `retryAfterMs` hint 再大也 capped 於 `toolRetryAfterMaxMs`，不得無上限等待。
- 不得以 Tool 名稱 switch 決定 policy；policy 一律來自 descriptor。

### `runtime/tool-dispatch/circuit-breaker.ts`（新）

依 definitive outcome 轉態，open 時不 dispatch 即回 stable classification：

```typescript
export interface ToolCircuitBreakerPolicy {
  failureThreshold: number;
  successThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxProbes: number;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface ToolCircuitBreaker {
  beforeDispatch(toolName: string, policy: ToolCircuitBreakerPolicy | undefined): CircuitState;
  record(toolName: string, policy: ToolCircuitBreakerPolicy | undefined, outcome: "success" | "definitive_failure"): void;
}
```

- `policy === undefined` → 恆 `closed`（未宣告 breaker 的 Tool 不受影響）。
- 只有 definitive failure（authorization deny 以外的可判定 failure）累積到 `failureThreshold` 才 open；open 後經 `resetTimeoutMs` 進 half-open，以 `halfOpenMaxProbes` 限量 probe；probe 成功達 `successThreshold` 回 closed，失敗回 open。
- open 時 dispatch pipeline 回 stable `circuit_open` classification（error code `TOOL_CIRCUIT_OPEN`，retryable/deferred），**不 dispatch 下游 Tool**。
- 不得以顯示文字或 error-message substring 判斷 outcome；outcome 分類沿用 `runtime/retry/error-classification.ts` 的 stable category。

#### `record()` 呼叫點與 outcome → circuit-breaker 映射

`beforeDispatch` 於 dispatch 前判定；`record` 於 pipeline 收斂出最終 `GovernedToolOutcome` 之後、產生 structured envelope 之前呼叫（一次 per Tool call），依下列映射把「已定讞」的 outcome 記入 breaker，避免把「尚未定讞」的 outcome 誤記為 `definitive_failure`：

| pipeline outcome | circuit-breaker record |
|---|---|
| `succeeded` | `record("success")` |
| `failed_not_committed` 且 retryable（retry 未窮盡） | 不 record（仍在 retry loop） |
| `failed_not_committed` 且 retry 窮盡（非 retryable category 或 budget exhausted） | `record("definitive_failure")` |
| `rejected_before_dispatch`（input validation／rate-limit／classification） | 不 record |
| `denied_by_authorization`／`confirmation_required` | 不 record |
| `ambiguous_after_dispatch` | 不 record（需 reconcile，非 definitive） |
| `cancelled`（before／after） | 不 record |
| `deferred`（ledger unavailable 等） | 不 record |

### `runtime/tool-dispatch/scheduler.ts`（改，policy-aware + AbortSignal）

在既有二分 scheduler 之上，把「rate-limit → circuit-breaker → concurrency queue」組成單一排程入口：

```typescript
export interface ResilienceSchedulingOptions {
  signal?: AbortSignal;
}

export interface ToolDispatchScheduler {
  schedule<TResult>(
    classification: ConcurrencyClassification,   // "concurrent_safe" | "serial"
    operation: () => Promise<TResult>,
    options?: ResilienceSchedulingOptions
  ): Promise<TResult>;
}

export type ConcurrencyClassification = "concurrent_safe" | "serial";
```

- `maxConcurrentReads` 改由 runtime-config 注入（不再是 hardcoded 建構子預設），並於 startup 驗證為 positive integer。
- **per-Run bounded capacity**：以 `Map<runId, { active: number; max: number }>` 追蹤每個 Run 的 active read 數；`max` 由 config `toolDispatchMaxConcurrentReadsPerRun` 供給；Run 的 active 歸零（terminal）時 `delete(runId)` 清理 entry，避免 memory leak。
- **reject-vs-queue 語意**：per-Run bound 已滿 → 回 stable deferred `TOOL_RUN_CAPACITY_EXCEEDED`（不 queue，避免單一 Run 壟斷）；per-process global bound 已滿 → 排隊等待（bounded、可由 `AbortSignal` 中斷）。優先序：先 per-Run 判定，再 per-process 排隊。
- `acquireReadSlot`／serial tail 等待改為可接收 `AbortSignal`：等待期間 abort 即拋 `USER_CANCELLED`（或回 cancelled），不 leak waiter。
- 分類失敗的保守路徑（`TOOL_CONCURRENCY_CLASSIFICATION_FAILED`）維持 X14 語意：不提升 concurrency。

### `runtime/tool-dispatch/runtime-tool-descriptor.ts`（改）

`RuntimeToolDescriptor` 新增兩個可選欄位，由 registry 驗證：

```typescript
export interface RuntimeToolDescriptor<TInput = unknown, TOutput = unknown> {
  // ...既有欄位不變...
  rateLimitPolicy?: ToolRateLimitPolicy;
  circuitBreakerPolicy?: ToolCircuitBreakerPolicy;
}
```

- `validateDescriptor` 增加：`rateLimitPolicy`（若存在）`maxRequestsPerWindow`／`windowMs` 為 positive integer；`circuitBreakerPolicy`（若存在）`failureThreshold`／`successThreshold`／`resetTimeoutMs`／`halfOpenMaxProbes` 為 positive integer 且 `failureThreshold > 0`、`successThreshold > 0`。
- 型別不符於註冊時 fail-closed，不採預設補齊。

### `runtime/tool-dispatch/pipeline.ts`（改）

- 在既有 `inputSchema.safeParse` 與 concurrency classification 之後、`scheduler.schedule` 之前，依序執行 rate-limit 與 circuit-breaker 判定；`defer` 時以 bounded `retryAfterMs` 等待（可被 signal 中斷），`deny` 回 `rejected_before_dispatch`（`TOOL_RATE_LIMITED`），`circuit_open` 回 stable deferred classification（不 dispatch）。
- `scheduler.schedule` 改傳 `ConcurrencyClassification` 與 `{ signal }`。
- 接 `StepLock`／`StepTransitionGuard` 保護 `taskStepAdapter.start/complete/fail` 的 Step 狀態推進；lock expiry／owner mismatch 回 stable error，不 corrupt Step state。**lock lifecycle**：acquire 後於 Tool execution 期間以 heartbeat interval（`TTL/3`）呼叫 `extend`；complete／fail／abort／cancel 時 `release`；`extend` 失敗即停止 Tool 並回 stable error `TOOL_STEP_LOCK_EXTEND_FAILED`。lock TTL 由 config `toolDispatchStepLockTtlMs` 供給，且以 heartbeat 確保不因 TTL（既有 `step-transition-guard.ts:12` 的 `DEFAULT_LOCK_TTL_MS = 30_000`）短於 `timeoutPolicy.timeoutMs` 而過期。
- 增加 latency 分段 span：queue wait（rate-limit + circuit-breaker + 排隊）、permission wait（authorization／confirmation）、backoff、execution、reconciliation、total。

### `runtime/side-effect/tool-execution-runner.ts`（改）

- **mutation retry 補 backoff**：`dispatchAttempts` 的 `failed_not_committed` 分支，在 `checkBudget` 允許 retry 後，以 `computeBackoff(policy.backoffStrategy, attempt, { retryAfterMs, maxMs })` 計算延遲（`retry-after-header` 策略 bounded 於 config 上限），backoff wait 可被 `input.signal` 中斷；中斷即回 `USER_CANCELLED`。
- **read-only bounded retry**：`executeReadOnly` 引入「timed-out read-only 於 retry budget 內可重試」的 bounded retry（無 ledger、無 reconcile），只對 definitive timeout／rate_limit／server_error 分類重試，其餘（permission_denied／business_rejected／user_cancelled／schema_invalid）不 retry。
- **read-only retry 與 output validation 的邊界**：retry 只在 `executeReadOnly` 內部對 `executor.executeTyped` 回傳的 `failed`（timeout／rate_limit／server_error）outcome 重試；`outputSchema` validation 是 pipeline `mapRunnerResult` 在 runner 回傳後才做（`pipeline.ts:193-201`），output-validation-failed 轉為 `failed_not_committed`（read-only）但 **MUST NOT 重進 retry loop**。兩層責任分離：executor 層只管 dispatch outcome 的重試，pipeline 層只管 output validation，避免在 executor 層對 output validation 也 retry、或 pipeline 層重跑已退出的 runner。
- **definitive outcome 不 retry**：authorization deny、user cancel、business reject、invalid schema、unknown side-effect state 維持 X14 語意不進入 retry；mutation 只在 `not_committed` reconcile 或 external idempotency guarantee 後 retry。

### `platform/runtime-config.ts`（改）

新增單一來源設定（含預設值與 startup 驗證）：

```typescript
toolDispatchMaxConcurrentReads: number;   // 既有 4，改 config 驅動
toolDispatchRateLimitMaxRequestsPerWindow: number;
toolDispatchRateLimitWindowMs: number;
toolDispatchCircuitResetTimeoutMs: number;
toolRetryAfterMaxMs: number;               // Retry-After bounded 上限
```

- 讀取方式沿用既有 `readPositiveInt`，invalid 值 fallback 到預設或 fail-fast（依欄位語意）；capacity bounded per Run 且 per process。

## 政策規則（Policy Rules）

- Authorization deny、user cancel、business reject、invalid schema、unknown side-effect state → **不自動 retry**。
- Timed-out read-only Tool → 於 retry budget 內**可 retry**（無 ledger）。
- Mutation Tool → 只在 `not_committed` reconcile 或 external idempotency guarantee 後 retry。
- Circuit-open → 回 stable retryable/deferred classification，**不 dispatch**。
- Scheduler capacity bounded per Run 且 per process；配置於 startup 驗證。

## 替代方案與取捨

| 方案 | 取捨 | 結論 |
|---|---|---|
| 在 pipeline 內以 `Promise.all` 一次並發 batch 所有 tool call | 違反 X16 Excludes「No unbounded Promise.all」；無 per-Run bound | 不採用；batch partition + bounded scheduler |
| 以固定 Tool 名稱清單標記 concurrency-safe | 違反「No fixed Tool-name list」；難維護 | 不採用；沿用 descriptor `isConcurrencySafe(input)` |
| retry 前寫死固定 sleep | 違反「No fixed delays to mask races」；無法尊重 Retry-After | 不採用；`computeBackoff` + bounded Retry-After |
| circuit-breaker 以 error-message substring 判 outcome | 違反 X11 Invariant #8 | 不採用；沿用 stable error category |
| 讓 lock 取代 business-effect idempotency | 違反 X16「a lock never substitutes for business-effect idempotency」 | 不採用；lock 只保護 transition，idempotency 由 ledger `businessEffectKey` 保證 |
| read-only 永不 retry | 違反 X16「A timed-out read-only Tool may retry within budget」 | 不採用；read-only 引入 bounded retry（無 ledger） |
| rate-limit／circuit-breaker 由 BFF 負責 | 越界；Tool governance 政策屬 backend，BFF 是 transport 限流 | 不採用；兩者責任邊界分離 |

## 可觀測性

- 新增分段 span／metric：`tool.schedule.queue_wait`、`tool.authorization.wait`、`tool.retry.backoff`、`tool.execution`、`tool.reconcile`、`tool.dispatch.total`。
- 分段 latency 接 X12 `ExecutionContext` 的 `runId`／`taskId`／`stepId`／`toolCallId` correlation。
- 分段 metric／span 記錄失敗時沿用 `ignoreObservabilityFailure` 模式（best-effort），**不中斷 dispatch 流程**。
- MUST NOT 落 raw Tool argument、raw provider body、未遮罩 PII；沿用既有 redaction 原則。

## 相容性

- 既有 Weather／Web／Calculator／MCP 行為不變（未宣告 rate-limit／circuit-breaker 的 Tool 走既有二分路徑）。
- 不變更既有 Graph ID、公開 BFF route、Tool 名稱、error-code 語意。
- `rateLimitPolicy?`／`circuitBreakerPolicy?` 可選，未設定時行為與 X14 既有 scheduler 一致。

## 未驗證假設

- 真實多節點 Redis lock 的 expiry／owner-mismatch 行為，以 `step-lock.integration.test.ts`（既有）與新增 fault injection 證明；無 Redis 的 dev 路徑以 `NoopStepLock` 覆蓋。
- circuit-breaker 的 half-open probe 在真實 provider 斷線下的收斂，以 deterministic test + fault injection 證明，非 live 驗證。
- 分段 latency 的數值正確性以 unit test 驗證 span 命名與 metric 屬性，非效能調校。

## 責任邊界總結

| 能力 | 權責 | 本 Change 動作 |
|---|---|---|
| Concurrency classification | X14 `descriptor.isConcurrencySafe(input)` | 沿用，不重造 |
| 排程容量與 bounded concurrency | backend scheduler | config 驅動、bounded、AbortSignal、startup 驗證 |
| Rate-limit／Circuit-breaker | Tool governance descriptor | 新增 policy 欄位與判定模組 |
| Retry／backoff／Retry-After | X2 retry budget + backoff | 接線到 production retry loop，補 backoff 與 read-only retry |
| Distributed Step lock／CAS | X5 step lock | 接線到 dispatch state transition（lock ≠ idempotency） |
| Business-effect idempotency | X8.6 side-effect ledger | 維持 ledger `businessEffectKey` 唯一來源 |
