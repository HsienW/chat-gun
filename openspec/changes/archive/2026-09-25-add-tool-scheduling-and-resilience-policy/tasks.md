# Tasks：add-tool-scheduling-and-resilience-policy

> 每個 Task 可獨立驗證；驗證命令以 backend 現有 script（lint／test／build）為主。未完成的驗證如實標記，不假稱通過。真實多節點 Redis lock 與 live provider 斷線的收斂以 fault injection／integration test 證明，於回報中明確列出未驗證項。

## T1 建立 descriptor 韌性政策欄位與驗證（backend）

> 無前置依賴。

- [x] 擴充 `RuntimeToolDescriptor`：新增 `rateLimitPolicy?: ToolRateLimitPolicy`（`maxRequestsPerWindow`／`windowMs`）與 `circuitBreakerPolicy?: ToolCircuitBreakerPolicy`（`failureThreshold`／`successThreshold`／`resetTimeoutMs`／`halfOpenMaxProbes`）。
- [x] `validateDescriptor` 增加型別驗證：positive integer、`failureThreshold > 0`、`successThreshold > 0`；型別不符於註冊時 fail-closed，不採預設補齊。
- [x] 新增 test：合法 policy 通過、缺 policy 不影響既有欄位、非法 policy（0／負數／非整數）於註冊時 fail-closed、既有 descriptor 註冊不受影響。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/runtime-tool-descriptor.test.ts
npm run lint
```

## T2 建立 rate-limiter 模組（backend）

> 依賴：T1。

- [x] 新增 `runtime/tool-dispatch/rate-limiter.ts`：`ToolRateLimiter.check` 回 `allow`／`defer{retryAfterMs}`／`deny`；`policy === undefined` → `allow`。
- [x] window 有單一來源與 bounded 語意；`defer.retryAfterMs` 以 config `toolRetryAfterMaxMs` 為 upper bound clamp（`Math.min(hint, toolRetryAfterMaxMs)`），不寫死等待。
- [x] 新增 test：未宣告 policy allow、window 內 allow、超過上限 defer（附 retryAfterMs）、`deny` 分類、多 Tool 獨立計數、signal abort 不誤判、`retryAfterMs` 超過 `toolRetryAfterMaxMs` 時被 clamp。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/rate-limiter.test.ts
npm run build
```

## T3 建立 circuit-breaker 模組（backend）

> 依賴：T1。

- [x] 新增 `runtime/tool-dispatch/circuit-breaker.ts`：`beforeDispatch` 回 `closed`／`half_open`／`open`；`record` 依 definitive outcome 累積與轉態；`policy === undefined` 恆 `closed`。
- [x] open 後經 `resetTimeoutMs` 進 half-open，`halfOpenMaxProbes` 限量 probe；probe 成功達 `successThreshold` 回 closed。
- [x] outcome 分類沿用 `runtime/retry/error-classification.ts` 的 stable category，不依 error-message substring。
- [x] 新增 test：definitive failure 達閾值 open、open 不 dispatch、resetTimeout 後 half-open、half-open 限量 probe；probe 成功回 closed、probe 失敗回 open、未宣告 policy 恆 closed。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/circuit-breaker.test.ts
npm run build
```

## T4 擴充 scheduler 為 policy-aware + AbortSignal（backend）

> 依賴：T2、T3。

- [x] 擴充 `scheduler.ts`：`maxConcurrentReads` 改由 runtime-config 注入；新增 per-Run bounded capacity（`Map<runId, { active, max }>`，Run terminal 時 delete entry，`max` 由 `toolDispatchMaxConcurrentReadsPerRun` 供給）；`schedule` 接收 `ConcurrencyClassification` 與 `{ signal }`。
- [x] per-Run bound 已滿 → 回 stable deferred `TOOL_RUN_CAPACITY_EXCEEDED`（不 queue）；per-process global bound 已滿 → 排隊等待（bounded、可 abort）。
- [x] `acquireReadSlot`／serial tail 等待可被 `AbortSignal` 中斷（不 leak waiter）。
- [x] 分類失敗保守 serial/no-dispatch（維持 X14 語意）。
- [x] `schedule` 介面由 `boolean` 改為 `ConcurrencyClassification`：同步更新所有 caller（`pipeline.ts:417`）與 test（`scheduler.test.ts`），避免 T4/T5 中間狀態 build 失敗。
- [x] 新增 test：safe read 於上限內 concurrent、超過上限排隊、mutation/unknown serial、abort 中斷 queue wait、per-Run bound 已滿回 deferred 且不阻塞其他 Run、per-Run entry 於 Run 結束後清理、per-process bound、分類失敗不提升 concurrency。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/scheduler.test.ts
npm run build
```

## T5 在 pipeline 接 rate-limit／circuit-breaker（backend）

> 依賴：T2、T3、T4。

- [x] `pipeline.ts` 在 concurrency classification 後、`scheduler.schedule` 前依序執行 rate-limit 判定與 circuit-breaker 判定。
- [x] `defer` 以 bounded `retryAfterMs` 等待（可被 signal 中斷）；`deny` 回 `rejected_before_dispatch`（`TOOL_RATE_LIMITED`）；`circuit_open` 回 stable deferred classification（`TOOL_CIRCUIT_OPEN`，不 dispatch）。
- [x] 於 pipeline 收斂出最終 outcome 後呼叫 `circuitBreaker.record()`，依 outcome 映射表記 `success`／`definitive_failure`／不 record（映射見 design.md circuit-breaker 章節）。
- [x] 新增 test：defer 等待後 dispatch、deny 不 dispatch、circuit_open 不 dispatch 且回 `TOOL_CIRCUIT_OPEN`、未宣告 policy 行為不變、record 映射（succeeded→success、failed_not_committed 窮盡→definitive_failure、rejected/ambiguous/cancelled→不 record）。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/pipeline.test.ts
npm run build
```

## T6 retry loop 補 backoff 與 bounded Retry-After（backend）

> 依賴：X2（已 archive）。

- [x] `tool-execution-runner.ts` 的 mutation `failed_not_committed` retry 分支，以 `computeBackoff(policy.backoffStrategy, attempt, { retryAfterMs, maxMs })` 計算延遲；`retry-after-header` 策略 bounded 於 config `toolRetryAfterMaxMs`；backoff wait 可被 `signal` 中斷（中斷回 `USER_CANCELLED`）。
- [x] 新增 test：backoff 延遲隨 attempt 遞增、Retry-After bounded、abort 中斷 backoff、definitive outcome 不 retry。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/tool-execution-runner.test.ts
npm run build
```

## T7 read-only bounded retry（backend）

> 依賴：X2（已 archive）。

- [x] `executeReadOnly` 引入「timed-out read-only 於 retry budget 內可重試」的 bounded retry（無 ledger、無 reconcile）。
- [x] 只對 definitive timeout／rate_limit／server_error 分類重試；permission_denied／business_rejected／user_cancelled／schema_invalid 不 retry。
- [x] retry 只在 `executeReadOnly` 內部對 executor outcome 重試；`outputSchema` validation 失敗由 pipeline `mapRunnerResult` 處理（`failed_not_committed`），**不重進 retry loop**。
- [x] 新增 test：timed-out read-only 於 budget 內重試成功、budget 耗盡回 terminal、非 retryable 分類不重試、abort 停止重試、output validation failed 不重試。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/tool-execution-runner.test.ts
npm run build
```

## T8 distributed Step lock／CAS 接線 dispatch（backend）

> 依賴：X5（已 archive）。

- [x] `pipeline.ts` 接 `StepLock`／`StepTransitionGuard` 保護 `taskStepAdapter.start/complete/fail` 的 Step 狀態推進。
- [x] lock lifecycle：acquire 後以 heartbeat（`TTL/3`）`extend`；complete／fail／abort／cancel 時 `release`；`extend` 失敗即停止 Tool 並回 stable error `TOOL_STEP_LOCK_EXTEND_FAILED`。
- [x] lock expiry／owner mismatch 回 stable error，不 corrupt Step state；無 Redis 時以 `NoopStepLock` 覆蓋 dev／測試路徑。
- [x] 明確 lock 只保護 transition，business-effect idempotency 由 ledger `businessEffectKey` 保證。
- [x] 新增 test：lock expiry 不 corrupt Step、owner mismatch 不覆蓋、lock 失敗不 dispatch、heartbeat extend 於長 Tool 執行期間維持 lock、extend 失敗停止 Tool、無 Redis 走 NoopStepLock、lock 不取代 idempotency。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/lock/ src/runtime/tool-dispatch/pipeline.test.ts
npm run build
```

## T9 startup config 驗證與 latency 分段（backend）

> 依賴：T4、T5。

- [x] `runtime-config.ts` 新增 `toolDispatchMaxConcurrentReads`、`toolDispatchMaxConcurrentReadsPerRun`、`toolDispatchRateLimitMaxRequestsPerWindow`、`toolDispatchRateLimitWindowMs`、`toolDispatchCircuitResetTimeoutMs`、`toolRetryAfterMaxMs`、`toolDispatchStepLockTtlMs`（單一來源、預設值、explicit override、invalid 值 fail-fast）。
- [x] 新增分段 span／metric：queue wait／permission wait／backoff／execution／reconciliation／total，接 X12 correlation。
- [x] 新增 test：config 預設與 override、invalid 值 fallback／fail-fast、分段 metric 名稱與屬性正確。

驗證命令：

```bash
cd backend
npm run test -- src/platform/runtime-config.test.ts src/runtime/tool-dispatch/
npm run build
```

## T10 fault injection 與架構測試（backend）

> 依賴：T1–T9。

- [x] fault injection 證明 retry／resume 下無 duplicate side effect（沿用 X8.6 ledger 的 `businessEffectKey`）。
- [x] 新增 architecture test：production dispatch 不得以固定 Tool 名稱清單判定 concurrency；不得 unbounded `Promise.all`；scheduler capacity 不得寫死；lock 不得取代 idempotency。
- [x] 回歸：Weather／Web／Calculator／MCP 既有 golden eval／mock smoke／live smoke 路徑不變。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/
npm run build
```

## T11 全量驗證與契約記錄（backend）

> 依賴：T1–T10。

- [x] 建立 cross-layer contract fixture：rate-limit decision／circuit state／retry outcome 單一來源，供單元與 fault-injection test 共用。
- [x] 執行 backend 完整 lint／test／build，如實記錄 skipped／未驗證項與 live 驗證缺口。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
```
