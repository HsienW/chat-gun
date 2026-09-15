# Tasks：add-runtime-operations-slo-eval-release-gate

> 對應 `second-stage-plan-en-v3.md` X10.2（Layer 2 Platform Governance 的 Runtime Operations/SLO/Eval Release Gate），backend + bff + docs。每個 Task 只有在實作完成、測試新增、驗證實際執行通過後才勾選 `- [x]`。T0 為 hard gate：worker heartbeat signal 無法確認即停止並回報 ADR，不得自建 worker 註冊表。

## Phase 0：T0 worker/queue signal spike（hard gate）

### Task 0.1：確認 LangGraph 原生可取得的 claim/lease/heartbeat signal

- [x] 以真實 LangGraph Agent Server 確認可取得的 run/worker signal：run status、`createdAt`/`updatedAt`、interrupt 狀態、是否暴露 claim/lease 或 heartbeat
- [x] 記錄可用的 lease/claim 投影方案；若原生未暴露，則以 X8.8 `ActiveRunOwnership` + last-progress timestamp 為替代
- [x] 產出 spike 結論，MUST NOT 自建 worker 註冊表／第二 scheduler

**驗證：** spike 腳本與結論記錄至 change evidence；`cd backend && npx vitest run src/operations/__spike__`

---

## Phase 1：型別與 runtime validation（backend）

### Task 1.1：TaskGoal / ExecutionBudget / ExecutionManifest / WorkerRecoveryClassification 型別

- [x] 建立 `backend/src/operations/types.ts`
- [x] 定義 `TaskGoal`／`TaskGoalStatus`（active/paused/completed/budget_exhausted/failed/cancelled）
- [x] 定義 `ExecutionBudget`（maxTurns/maxTokens/maxElapsedMs/maxModelCalls?/maxToolCalls?/maxCostUsd?）
- [x] 定義 `ExecutionManifest`（runtimeBuildId/graphVersion/promptVersion/modelRouteVersion/toolSchemaVersion/policyVersion/domainSchemaVersion?/catalogVersion?/embeddingVersion?/rerankerVersion?）
- [x] 定義 `WorkerRecoveryClassification`（healthy/requeue_safe/park_manual/already_completed/effect_unknown_requires_reconciliation）與 terminal operational decisions（requeued/resumed/parked_manual/completed_elsewhere/reconciliation_required）
- [x] runtime validation：封閉列舉 + 未知值 fail-closed reject；`maxTurns`/`maxTokens`/`maxElapsedMs` 必填且 finite non-negative

**驗證：** `cd backend && npx vitest run src/operations/types.test.ts`

---

## Phase 2：metrics export/aggregation 與 SLO（backend + bff）

### Task 2.1：vendor-neutral metrics export（Part A）

- [x] 建立 `backend/src/operations/metrics/export.ts`：以 OTel/Prometheus-compatible 匯出 Task/Step/Tool/Token-cost、retry/compensation、side-effect reconciliation、queue/run/worker health
- [x] 唯讀引用 X8 `recordMetric`／OTel spans，不重造 telemetry
- [x] 匯出輸出 redaction：不含 raw prompt、credential、unmasked PII、unrestricted tool output
- [x] 測試：metric 可匯出、redaction 過濾、不影響既有 flow

**驗證：** `cd backend && npx vitest run src/operations/metrics/export.test.ts`

### Task 2.2：queue/run/worker health signal 投影（Part A/B）

- [x] 建立 `backend/src/operations/metrics/health.ts`：依 T0 結論投影 queue/run/worker health signal（saturation、stuck-run count、heartbeat freshness）
- [x] 測試：health signal 可投影、缺失 signal 時降級而不報錯

**驗證：** `cd backend && npx vitest run src/operations/metrics/health.test.ts`

### Task 2.3：bff 受保護 metrics proxy route（Part A）

- [x] 建立 `bff/src/metrics-proxy.ts`：以 X8.7 identity/auth 保護的唯讀 metrics route
- [x] MUST NOT 向公網裸露 raw runtime；未授權 MUST deny
- [x] 測試：授權通過轉發、未授權 deny

**驗證：** `cd bff && npx vitest run src/metrics-proxy.test.ts`（若 bff 無既有 test script，補測試入口）

### Task 2.4：SLO/SLI 文件（Part B）

- [x] 建立 `docs/operations/slo-sli.md`：versioned/configurable SLO/SLI 表（threshold 不 hard-code 於 business logic）

**驗證：** 文件存在且 threshold 標註 config 來源。

---

## Phase 3：Persistent Goal 與 Execution Budget（backend）

### Task 3.1：TaskGoal lifecycle（Part C）

- [x] 建立 `backend/src/operations/goal/task-goal.ts`：active/paused/completed/budget_exhausted/failed/cancelled
- [x] pause/resume 保留同一 `goalId`；completion 由 explicit completion/quality policy 決定，非 loop 耗盡
- [x] goal status 於 Task/Audit/operations output 可見
- [x] 測試：pause/resume 同 goal identity、completion 由 gate 決定、budget_exhausted 不為 completed

**驗證：** `cd backend && npx vitest run src/operations/goal/task-goal.test.ts`

### Task 3.2：ExecutionBudget 與 budget exhaustion（Part D）

- [x] 建立 `backend/src/operations/goal/execution-budget.ts`：whole-goal budget 橫跨成功與失敗 turns
- [x] budget exhaustion → `budget_exhausted`（MUST NOT success）；counters 存活於 checkpoint/resume；可查耗盡維度
- [x] side-effect safety 仍走 X8.6；budget exhaustion MUST NOT authorize unsafe replay
- [x] 測試：任一維耗盡 → budget_exhausted、非 success；counters resume 保留；耗盡維度可查

**驗證：** `cd backend && npx vitest run src/operations/goal/execution-budget.test.ts`

### Task 3.3：quality/completion gate（Part E）

- [x] 建立 `backend/src/operations/quality-gate.ts`：small、versioned、deterministic-first
- [x] MAY 混用 X8.5A bounded evaluation score/assertion；MUST NOT 以 unversioned LLM-judge 為唯一訊號
- [x] 測試：deterministic invariant 通過 → complete；gate 失敗但 budget 剩餘 → 有界續跑

**驗證：** `cd backend && npx vitest run src/operations/quality-gate.test.ts`

---

## Phase 4：worker recovery、reaper 與 drain（backend）

### Task 4.1：worker recovery 分類（Part F）

- [x] 建立 `backend/src/operations/recovery/worker-recovery.ts`：healthy/requeue_safe/park_manual/already_completed/effect_unknown_requires_reconciliation
- [x] side-effect `unknown` MUST 先走 X8.6 reconcile；exhausted budget／unsafe ambiguity → `park_manual`
- [x] manual parking 於 Task/Audit/operations 可見
- [x] 測試：replay-safe 可 requeue、unknown 需 reconcile、unsafe 需 park

**驗證：** `cd backend && npx vitest run src/operations/recovery/worker-recovery.test.ts`

### Task 4.2：stuck-run reaper（Part G）

- [x] 建立 `backend/src/operations/recovery/reaper.ts`：偵測 heartbeat-expired、no-progress、orphaned ownership、waiting-too-long
- [x] terminal operational decisions：requeued/resumed/parked_manual/completed_elsewhere/reconciliation_required
- [x] MUST NOT 盲回放 unsafe side-effect
- [x] 測試：heartbeat-expired 分類、no-progress 分類、orphaned ownership 分類、unsafe 不 requeue

**驗證：** `cd backend && npx vitest run src/operations/recovery/reaper.test.ts`

### Task 4.3：graceful deployment drain（Part H）

- [x] 建立 `backend/src/operations/drain.ts`：stop new claims → in-flight safe work completes/checkpoint → ambiguous effect reconcile → 才退出
- [x] bounded drain timeout；timed-out work persists recoverable state or parks
- [x] shutdown MUST NOT report success while unsafe side-effect state remains unclassified
- [x] 測試：stop claims、in-flight 完成、ambiguous reconcile、unsafe 未分類不得宣稱 success

**驗證：** `cd backend && npx vitest run src/operations/drain.test.ts`

---

## Phase 5：Execution Manifest 與 resume（backend）

### Task 5.1：ExecutionManifest resume 三態（Part I）

- [x] 建立 `backend/src/operations/manifest.ts`：compatible → resume、migratable → migrate then resume、incompatible → pin old env or park/manual-recovery
- [x] 每個 durable Run/Task 記錄 ExecutionManifest
- [x] write/side-effect Step MUST NOT 只因新版本部署就 blind replay
- [x] 測試：compatible resume、migratable migrate、incompatible park；version 升級不盲回放 write Step

**驗證：** `cd backend && npx vitest run src/operations/manifest.test.ts`

---

## Phase 6：release gate、canary 與 feedback loop（backend + docs）

### Task 6.1：evaluation release gate（Part K）

- [x] 建立 release gate script（reuse X8.5A version-pinned datasets + X10 Hard Negative）：deterministic regression + no business constraint 回歸 + no duplicate side-effect 回歸 + recovery 界內 + cost/latency tolerance + manifest 相容
- [x] 任一失敗 MUST fail the gate；初期可 CI/manual
- [x] 測試：deliberate Hard Negative 或 side-effect 回歸 → gate fail

**驗證：** gate script 實際執行；deliberate regression fail the gate。

### Task 6.2：live runtime canary（Part L）

- [x] 建立 `backend/src/operations/canary.ts`：create Task → step → persist → safe mock tool → interrupt/checkpoint → resume → verify audit/OTel/no-duplicate
- [x] canary 記錄 Runtime Build ID／ExecutionManifest、safe resources、cleanup trace、失敗標記 unhealthy
- [x] 測試：canary 成功路徑；side-effect duplicate 偵測；失敗標記 unhealthy

**驗證：** `cd backend && npx vitest run src/operations/canary.test.ts`

### Task 6.3：trace → bad case → dataset feedback loop（Part M）

- [x] 建立 bad-trace → redact/minimize → versioned regression case → dataset → rerun experiment 流程
- [x] 至少一個 bad trace 成為 redacted、version-pinned regression case
- [x] 測試：bad case 入 dataset、rerun 可 compare before/after

**驗證：** feedback loop script 執行；dataset 版本可比對。

### Task 6.4：failure-drill runbooks（Part J）

- [x] 建立 `docs/operations/` 下 concise runbooks：graceful shutdown/drain、worker restart、heartbeat loss、Redis unavailable、PostgreSQL unavailable、stream reconnect、stuck-run recovery、compensation failure、side-effect reconciliation after crash、incompatible-version resume
- [x] 每個 drill 有 documented expected behavior/recovery

**驗證：** runbooks 存在且涵蓋列舉 drill。

---

## Phase 7：全量驗證（backend + bff）

### Task 7.1：barrel export 與全量驗證

- [x] 建立 `backend/src/operations/index.ts` barrel export
- [x] 驗證不修改 X8/X8.5A/X8.6/X8.7/X8.8/X2 契約
- [x] 驗證不新增第二 queue/worker/scheduler
- [x] `cd backend && npm run lint` 通過
- [x] `cd backend && npm run test` 通過（含既有 platform/evaluation/runtime 回歸）
- [x] `cd backend && npm run build` 通過
- [x] `cd bff && npm run build` 通過
- [x] 驗證無不必要 `any`；封閉列舉有單一來源與未知值處理
- [x] `openspec validate add-runtime-operations-slo-eval-release-gate --strict` 通過

**驗證：** Backend lint/test/build、bff build 通過；OpenSpec strict validation 0 issues。
