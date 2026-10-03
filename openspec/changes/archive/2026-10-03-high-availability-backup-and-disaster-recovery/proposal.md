# Proposal：high-availability-backup-and-disaster-recovery

## 變更摘要

把既有的 v4 runtime 從「單一 process／單一 worker 可安全執行」升級為「**多執行個體對共享 durable 服務安全並行運作**」，並補上目前完全缺失的**備份還原與災難復原**能力：多 web/runtime worker 不重複執行副作用、不遺失 durable work、不誤報 terminal state；授權 store 具備可驗證的備份／還原路徑與可量測的 RPO／RTO；health／readiness 能區分 process 存活、dependency 可達、可接受新工作、可 resume durable work、以及降級唯讀五種語意。

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X24**，是 Second Stage — Layer 8（Production Product Foundation）Wave 1 的 Change；前置 X16（`add-distributed-step-lock`）、X19（`version-runtime-event-and-terminal-contract`）、X20（`add-durable-hitl-and-conversation-recovery`）、X21（`enforce-runtime-production-readiness-gate`）已 archive。X24 在**不建立第二個 runtime、第二條 authorization 路徑、或 UI-only 的 durable state 近似**的前提下，把「可復原的單一 runtime」升級為「可橫向擴充、可還原、可演練的 production foundation」。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，唯讀盤點）：

1. **事件 sequence 是 process-local**：`RunSequenceAllocator`（`backend/src/runtime/event-sequence.ts:15`）以 in-memory `Map` 保存 per-run sequence；`createExecutionCompositionRoot`（`backend/src/operations/execution-composition-root.ts:247-249`）在未注入 `sequenceAllocator` 時 `new RunSequenceAllocator()`。雖然 `seed(runId, maxPersistedSequence)`（`event-sequence.ts:52`）可接上 persisted sequence，但目前 composition root 未在 resume 時 seed，跨 instance resume 會讓事件 sequence 從 0 重算，破壞 X19 event ordering。

2. **incident projection index 是 process-local**：`getIncidentProjectionIndex()`（`backend/src/operations/incident-query.ts`）是 module-level in-memory singleton，composition root 執行後直接 `record(...)` 到該 process 記憶體（`execution-composition-root.ts:311`）。多 instance 下 projection 不會共享，且 crash 後不可重建，違反 X24「projections 可由 authoritative facts 重建」的規則。

3. **lease/lock 有 Noop fallback 但無 leader election**：`RedisStepLock`（`backend/src/runtime/lock/step-lock.ts:43`）以 owner 值 + Lua 做 compare-and-release／extend（具 fencing 語意），但 `createStepLock()`（`step-lock.ts:112-115`）在無 Redis 時回退 `NoopStepLock`（always succeed）。單 instance 尚可，多 instance 下 `NoopStepLock` 等同無鎖，會造成 split-brain。目前沒有 controlled leader election，只有 per-step lock，無法安全承載「singleton maintenance work」（reaper、notification dedup sweeper、projection rebuild sweeper）。

4. **run/job ownership 有 durable 基礎但未完全接線**：`013_create_active_run_ownership.sql` 與 `reaper.ts` 的 `ownershipSchema`（含 `generation`、`supersededByRunId`、`updatedAt`）已建模 active run ownership 與 orphaned／heartbeat-expired／no-progress／waiting-too-long 偵測；`worker-recovery.ts` 有 healthy／requeue_safe／park_manual／already_completed／effect_unknown_requires_reconciliation 分類。但這些是「評估函式」（evaluateStuckRuns 回傳 findings），尚未有一致的「instance 死亡→另一 instance 依 fencing token 安全 takeover」執行路徑。

5. **health/readiness 語意不足**：`operations/metrics/health.ts` 只有 `projectRuntimeHealth`（回傳 available／degraded 與 queueDepth、stuckRunCount、workerSaturation、heartbeat freshness 的 projection 函式）；`http-app.ts` 只把 `/` 掛到 `metricsApp`（`GET /metrics` snapshot）。沒有 liveness／readiness 端點，沒有 X24 要求的五層語意（alive／reachable／accept new work／resume durable work／degraded read-only），也沒有「readiness MUST fail when 該 endpoint 宣稱的工作類別無法安全承接」。

6. **備份／還原完全缺失**：`backend/src` 沒有 backup／restore／snapshot／pg_dump／restore drill 實作（grep 僅命中 recovery／persistence 的既有語意，非備份）。Postgres 是 authoritative store（`runtime/persistence/` 20 支 migration），Redis 是 runtime cache／lock store（non-authoritative，可重建），但兩者都沒有備份程序、還原驗證、或隔離驗證環境。

7. **RTO／RPO／SLO 沒有 deployment policy 概念**：`platform/runtime-config.ts` 的 `AgentRuntimeConfig` 全為 env var 驅動的 runtime 設定，沒有任何 availability target、latency/error budget、RTO、RPO 的版本化 deployment policy；`platform/env.ts` 只做 raw env 讀取。X24 規則明確要求 RTO／RPO 來自 deployment policy 與 measured evidence，不得寫死成 source constant。

8. **migration 不支援 mixed-version**：`migration-runner.ts` 只做順序 up/down（`_migrations` 表），沒有 schema version 相容性、additive-only rolling 紀律、或 old+new instance 並存期間的相容檢查。`drain.ts`／`canary.ts` 已提供 graceful drain 與 canary 驗證原語，但尚未組合成「rolling deployment + mixed-version」的可驗證程序。

9. **crash recovery 未在多 instance 邊界被系統性演練**：X20 已有 `crash-terminal-policy`、`conversation-recovery`、`langgraph-checkpoint-adapter`，但沒有覆蓋「step boundary／approval wait／streaming／post-effect-pre-ack」且「另一 instance takeover」的 crash 矩陣。

綜合而言，v4 runtime 已具備分散式 step lock、durable ownership 評估、versioned event、durable recovery、release gate 等原語，但**尚未把它們接成多 instance 安全執行路徑，且完全沒有備份還原／DR 能力**——這正是 X24 issue 所述「survive process loss, instance replacement, dependency degradation, and data restoration」的缺口，也違反 AGENTS.md「不得以硬編碼取代設定」「不得捏造驗證結果」與 X24 Cross-Layer Invariant 的復原要求。

## 解決方案

以「多 instance 共用單一 authoritative runtime boundary + 移除 process-local 假設 + 可演練的備份還原 + 版本化 deployment policy」收斂，不重造 X16–X21 的原語：

1. **移除 process-local 假設（多 instance 安全）**：把 `RunSequenceAllocator` 於 resume 邊界 seed 自 persisted event sequence；把 `getIncidentProjectionIndex()` 改為「由 authoritative event log／side-effect ledger 重建的 read-model」並提供 rebuild 路徑；多 instance 模式（deployment policy 指定）下 `createStepLock()` 於無 Redis 時 MUST fail-closed，不得回退 `NoopStepLock`。保留單 instance／development 的 `NoopStepLock` 僅限於明確標示的開發模式。

2. **durable run/job ownership 與 fencing takeover**：以既有 `013_create_active_run_ownership.sql` 的 `generation` 作為 fencing token；instance 死亡後，另一 instance 依 `generation` 遞增執行安全 takeover，並依 `worker-recovery.ts` 的 classification 決定 requeue／resume／park_manual／reconciliation。session revocation 與 approval resumption MUST 讀取 durable store，不得依賴 process 記憶體。

3. **controlled leader election（僅 singleton work 需要）**：以 Redis `SET NX PX` + renewal + fencing token 建構 `SingletonLease`，只套用在真正需要 singleton 的維護工作——本 Change 唯一既有的 singleton 維護工作為 reaper；projection rebuild 是 on-demand／operator 觸發的 rebuild（非週期 singleton sweeper）；notification dedup 屬 X33，本 Change 不實作。split-brain 由 fencing token 與 TTL expiry 防護；不做 Raft/Paxos。非 singleton work 一律走無 leader 的 per-run lease。

4. **五層 health/readiness 語意**：新增 health/readiness 端點（liveness／readiness／resume-ready／degraded），每一層對應獨立 probe；readiness MUST 在「endpoint 宣稱的工作類別無法安全承接」時回傳 not-ready（fail-closed），不得在 durable dependency 不可用時回傳 success。複用 `projectRuntimeHealth` 並接上 shared durable 訊號。

5. **版本化 SLO／RTO／RPO deployment policy**：新增 `deploymentPolicy`（versioned schema，含 availability target、latency/error budget、RTO、RPO、backup cadence、retention、restore-drill 門檻），由 config 載入並附 safe default 與 validation；RTO／RPO 值由 policy 與 measured evidence 產生，不得寫死 source constant。

6. **備份／還原程序與隔離驗證**：為 Postgres（authoritative）建立 pg_dump／PITR 備份與還原程序；Redis 標示為 non-authoritative（可自 authoritative facts 重建，保留 RDB/AOF 僅作 warm start）；config metadata 由 versioned config 備份；encryption-key 依賴以外部 KMS／環境變數記載為 external dependency。還原先進隔離驗證環境、驗證 schema version／idempotency ledger／event integrity 後才 promote；不完整／不一致的 backup MUST 在宣告可還原前被偵測並拒絕。

7. **restore drill 與 RPO／RTO 量測**：提供 scripted restore drill（隔離環境還原→驗證→量測 RPO/RTO→產出 evidence），並對 recovery scans／retries 做 rate-limit，避免演練造成二次事故。

8. **rolling deployment 與 mixed-version migration 紀律**：migration runner 增加「additive-only 前向、backward-compatible」紀律與 schema-version 相容檢查；把既有 `drain.ts`／`canary.ts` 組合成 rolling-deploy 程序，並新增 mixed schema/event/package version 相容測試。

9. **crash recovery 矩陣**：以既有 `fault-injection.ts` 擴充 crash 矩陣（step boundary／approval wait／streaming／post-effect-pre-ack），並加入「worker 死亡後另一 instance 依 fencing token takeover」的多 instance crash 測試。

10. **operator runbook**：為 regional／service dependency 損失、corrupted projection、restore、reconciliation 產出 operator runbook（authority、decision point、rollback、escalation 路徑）。

## 受影響範圍

### 受影響套件

- `backend`：`runtime/lock`（leader election、Noop fallback fail-closed）、`runtime/event-sequence`（resume seed）、`operations/incident-query`（rebuildable read-model）、`operations/metrics/health` 與 `operations/http-app`（五層 health/readiness endpoint）、`operations/backup`（新增）、`operations/restore`（新增）、`runtime/persistence`（migration 紀律）、`platform/runtime-config` 與 `platform/env`（deployment policy）。
- `bff`：無強制變更；僅在需要對外暴露 readiness 狀態時，以 additive passthrough 代理既有 health 契約（不得自行推測後端語意）。預設不改。
- `frontend`：本 Change 標籤不含 `frontend`；不做 UI 變更（降級 banner 屬 X30 之後的 consumer experience，不在此範圍）。

### 受影響能力域

- 分散式 lock／lease 與 run/job ownership（X16）。
- runtime event ordering／versioning（X19）。
- durable wait／resume／recovery（X20）。
- production readiness gate（X21）。
- 可觀測性與 health/readiness（`operations/metrics/health`、`operations/metrics/export`）。
- 備份／還原／災難復原（本 Change 新增）。

### 既有能力原語（本 Change 接線、不重造）

- `RedisStepLock`／`StepLock`／`createStepLock`（`runtime/lock/step-lock.ts`、`redis-client.ts`，X16）。
- `RunSequenceAllocator.seed`（`runtime/event-sequence.ts`，X19）。
- `evaluateStuckRuns`／`classifyWorkerRecovery`／`mapWorkerRecoveryDecision`（`operations/recovery/reaper.ts`、`worker-recovery.ts`）。
- `drainRuntime`／`runLiveRuntimeCanary`／`createReadinessGate`（`operations/drain.ts`、`canary.ts`、`readiness-gate.ts`，X21）。
- `projectRuntimeHealth`（`operations/metrics/health.ts`）。
- `runMigrations`（`runtime/persistence/migration-runner.ts`）與 20 支 migration（含 `013_create_active_run_ownership.sql`）。
- `fault-injection.ts`、`architecture-checks.ts`、`quality-gate.ts`（X21）。
- versioned `RuntimeEventEnvelope`／`runtimeEventEnvelopeSchema`（X19）。

## 目標

- 至少兩個 application/runtime instance 可對共享 durable state 安全處理工作。
- lease／ownership 涵蓋 worker 死亡、expiry、takeover、split-brain 防護的測試。
- backup restoration 在隔離環境執行，並對 documented RPO／RTO 目標驗證。
- crash 測試覆蓋 pre-effect、post-effect/pre-ack、approval wait、stream interruption、checkpoint resume 邊界。
- rolling-deployment 測試覆蓋受支援的 mixed schema/event/package 版本。
- readiness 反映「新工作與 resume 工作能否安全承接」。
- recovery scans 有界、可觀測、抗 retry storm。
- operator runbook 標明 authority、decision point、rollback、escalation 路徑。

## 非目標

- ❌ 不宣稱「process manager 重啟單一 instance」即為高可用。
- ❌ 不做 active-active multi-region（除非有 accepted ADR；本 Change 不引入）。
- ❌ 不做 Raft/Paxos 等 full consensus；僅做 singleton work 的 controlled leader election。
- ❌ 不把 Redis 視為 authoritative store 做正式備份（僅 warm-start RDB/AOF 與重建紀律）。
- ❌ 不新增 frontend UI、不動既有 Graph ID／既有公開 BFF route 語意／既有 error-code 語意。
- ❌ 不實作 general workflow authoring、不新增第二個 scheduler（background scheduling 屬 X33）。

## 風險

- **split-brain／double side-effect**：多 instance 下若 lease 未正確 fencing，可能重複執行外部副作用。緩解：以 `generation` fencing token + Redis compare-and-release + fail-closed Noop 移除；crash 矩陣覆蓋 post-effect-pre-ack。
- **restore 覆蓋 authoritative data**：還原程序若未先隔離驗證，可能以壞 backup 覆蓋正式 store。緩解：隔離驗證環境 + integrity 檢查 + 不完整 backup 拒絕。
- **recovery scan retry storm**：演練或事故後的掃描若無 rate-limit，可能造成二次事故。緩解：有界掃描 + rate-limit + 觀測。
- **migration mixed-version 相容破壞**：rolling deploy 期間 old/new instance 並存，若 migration 非 additive-only，可能破壞相容。緩解：additive-only 紀律 + mixed-version 測試 + drain/canary 程序。
- **scope 過大**：X24 是 Layer 8 大型 Change。緩解：拆分 tasks 為可獨立驗證的增量，每批皆通過 lint/test/build；backup/restore 以 Postgres 為首個 authoritative store，object storage 與加密金鑰僅記載為 dependency。

## 回滾策略

- 每個 task 皆可獨立 revert；不引入不可逆的 schema 破壞（migration 只 add、不 drop 既有欄位）。
- 備份／還原引入的 operator 工具為 additive CLI／endpoint，不改變既有 runtime 執行路徑；回滾即移除新端點與新 CLI。
- `deploymentPolicy` 預設關閉多 instance 強化（維持既有單 instance 行為），rollback 只需還原 policy 與 feature flag。
- 若 restore drill 揭露 authoritative data 不一致，停止 promote 並以既有 backup 重建，不宣告還原完成。

## 驗證計畫

- `cd backend && npm run lint && npm run test && npm run build` 全程通過。
- 新增 deterministic unit test：leader election、fencing takeover、五層 health probe、migration additive-only 檢查、deployment policy schema。
- 新增 mock/recorded integration：兩 instance 並行處理、worker 死亡 takeover、restore drill（隔離環境）、mixed-version 相容。
- live/operator 驗證（真實多 instance 部署、真實 Postgres 還原演練、真實 RPO/RTO 量測）屬後續 L 證據，於完成回報中明確列出未驗證項，不假稱通過。

## 規格疑問（待 Qwen review-plan 前由 CCR 收斂）

1. `deploymentPolicy` 的載入來源：沿用 env var（`DEPLOYMENT_POLICY_JSON`）還是新增 versioned config file？傾向 env var + safe default，與既有 `runtime-config.ts` 一致。
2. leader election 的 Redis key 命名與 TTL 預設值，是否沿用 `toolDispatchStepLockTtlMs` 或獨立 policy key？傾向獨立 `singletonLeaseTtlMs`。
3. backup 的技術選項：`pg_dump`（logical）為先、PITR（WAL archival）列為後續；是否本 Change 就需 PITR？傾向本 Change 先做 pg_dump + restore drill，PITR 另開後續。
4. health/readiness 端點的對外暴露路徑：直接 backend（langgraph-api）還是經 bff passthrough？傾向 backend 直接暴露，bff 不代理（避免 bff 推測後端語意）。
