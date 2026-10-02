# Tasks：high-availability-backup-and-disaster-recovery

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。T0 先建立 `DeploymentPolicy` schema 與多 instance feature flag，後續 Task 一律引用該 policy，避免循環依賴。未完成的驗證如實標記，不假稱通過。live/operator 驗證（真實多 instance 部署、真實 Postgres 還原演練、真實 RPO/RTO 量測）屬後續 L 證據，於完成回報中明確列出未驗證項。

## T0 建立版本化 `DeploymentPolicy` schema 與多 instance feature flag

> 前置：無。本 Task 必須最先完成，T1–T14 皆引用此 policy。

- [x] 新增 strict `DeploymentPolicy` schema（versioned）：availability target、latency/error budget、RTO、RPO、backup cadence、retention、restore-drill 門檻、`multiInstanceEnabled` flag；未知欄位 fail-closed，缺 policy 用 safe default 並標示 default。
- [x] 以 env `DEPLOYMENT_POLICY_JSON` 載入 + Zod validation；RTO/RPO 不得寫死為 source constant。
- [x] 新增 unit test：policy 通過、未知欄位 fail-closed、RTO≥RPO 一致性、default 標示。

驗證命令：

```bash
cd backend
npm run test -- src/platform/
npm run build
```

## T1 移除事件 sequence 的 process-local 假設（resume seed）

> 依賴：T0。引用 `RunSequenceAllocator.seed`。

- [x] 於 resume 邊界自 persisted max sequence `seed(runId, maxPersistedSequence)`。
- [x] 移除 `createExecutionCompositionRoot` 的 `sequenceAllocator ?? new RunSequenceAllocator()` 預設 fallback：sequenceAllocator 改為 required 注入（由 composition root 建置時提供 seeded allocator），不得再於執行期無條件 `new`。
- [x] 新增 test：跨 instance resume 後 sequence 為 N+1、persisted sequence 低於目前值時拒絕、無倒退／重複、composition root 未注入 allocator 時於建置期即失敗。
- [x] 對應 `specs/multi-instance-operation/spec.md`「事件 sequence 跨 instance resume 不重算」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/event-sequence.test.ts src/operations/execution-composition-root.test.ts
npm run build
```

## T2 incident projection 改為 rebuildable read-model

> 依賴：T0。

- [x] 把 `getIncidentProjectionIndex()` 的 in-memory singleton 改為由 authoritative event log／side-effect ledger 重建的 read-model，提供 on-demand（operator／crash 後觸發）的 rebuild 入口；record 先寫 authoritative event log 再投影。
- [x] projection rebuild 為 on-demand 重建，不是週期 singleton sweeper（singleton 維護工作只屬 reaper，見 T6）。
- [x] 新增 test：crash 後 rebuild 等價、projection failure 不改變 runtime 執行。
- [x] 對應 `specs/multi-instance-operation/spec.md`「projection 由 authoritative facts 重建」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/incident-query.test.ts
npm run build
```

## T3 多 instance 模式禁止 NoopStepLock

> 依賴：T0。

- [x] 多 instance 模式（`multiInstanceEnabled`）下 `createStepLock()` 於無 Redis 時 fail-closed；`NoopStepLock` 僅限 development 單 instance 模式並於 health 標示。
- [x] 新增 test：多 instance 無 Redis fail-closed、development 單 instance 維持 Noop。
- [x] 對應 `specs/multi-instance-operation/spec.md`「multi-instance 模式禁止 NoopStepLock」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/lock/
npm run build
```

## T4 session revocation 與 approval resumption 讀取 durable store（跨 instance 生效）

> 依賴：T0。引用 X22 的 identity status enforcement（`runtime/authorization/identity-status.ts`）與 X20 的 durable approval/wait（`runtime/recovery/`）。

- [x] 盤點並確保 session revocation 檢查於每次新 step 與 resume 邊界讀取 durable store，不依賴 process 記憶體 cache；approval resumption 讀取 durable decision/wait state。
- [x] 關閉任何 process-local cache 繞過 durable revocation 的缺口（若有）。
- [x] 新增 cross-instance 測試：於 instance A 撤銷 session，instance B 對該 session 的新 step／resume MUST 被拒，且不需 process restart；approval resumption 自 durable wait state 恢復且不重複前置副作用。
- [x] 對應 `specs/multi-instance-operation/spec.md`「session revocation 與 approval resumption 讀取 durable store」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/authorization/ src/runtime/recovery/
npm run build
```

## T5 run/job ownership 以 fencing token 安全 takeover

> 依賴：T0、T1。引用既有 `013_create_active_run_ownership.sql` 的 `generation` 與 `classifyWorkerRecovery`。

- [x] 把 `evaluateStuckRuns` 的 findings 接上執行路徑：instance 死亡後另一 instance 以 generation+1 依 classification（requeue／resume／park_manual／reconciliation）takeover。
- [x] 新增 test：heartbeat_expired takeover、effect_unknown 進 reconciliation、superseded ownership 不復活。
- [x] 對應 `specs/multi-instance-operation/spec.md`「run/job ownership 以 fencing token 安全 takeover」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/recovery/
npm run build
```

## T6 controlled leader election（SingletonLease，僅 reaper）

> 依賴：T0、T3。

- [x] 新增 `SingletonLease`（Redis `SET NX PX` + renew + fencing token），只套用本 Change 唯一既有的 singleton 維護工作：reaper。不實作 notification dedup（屬 X33）或週期 projection rebuild sweeper。
- [x] 新增 test：單一 leader、leader 死亡後 TTL 過期可取得、舊 token 寫入被拒、非 singleton work 不走 leader election。
- [x] 對應 `specs/multi-instance-operation/spec.md`「controlled leader election 僅限 singleton work」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/lock/
npm run build
```

## T7 五層 health/readiness endpoint

> 依賴：T0、T3。引用 `projectRuntimeHealth`。

- [x] 於 `operations/http-app.ts` 新增 liveness／readiness／resume-ready／degraded 端點，五層語意對應獨立 probe；readiness fail-closed，durable dependency 不可用不回報 success。
- [x] 以五層 typed model 取代 `projectRuntimeHealth` 中 hardcoded 的二元 `signalStatus`（`available`／`degraded`）。
- [x] 新增 test：五層可獨立觀測、durable dependency 不可用 not-ready、無法 resume 不宣稱 resume-ready、degraded 與 ready 並存、五層 model 取代二元 signalStatus。
- [x] 對應 `specs/health-readiness-slo/spec.md`「五層 health/readiness 語意」與「readiness fail-closed」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/metrics/ src/operations/http-app.test.ts
npm run build
```

## T8 Postgres 備份程序與完整性檢查

> 依賴：T0。

- [x] 新增 Postgres 備份程序（pg_dump logical），產出含 schema version、timestamp、checksum 的 backup artifact；Redis 標示 non-authoritative；encryption-key 記載為 external dependency。
- [x] 新增完整性檢查：checksum 不符、缺 idempotency/side-effect ledger 判定不 restorable。
- [x] 對應 `specs/backup-restore/spec.md`「authoritative store 具備備份程序」與「不完整 backup 拒絕」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/backup/
npm run build
```

## T9 隔離驗證還原與 promote

> 依賴：T8。

- [x] 新增 restore 程序：先還原至隔離驗證環境，驗證 schema version／idempotency ledger／event integrity 後才 promote；未通過中止且不覆蓋正式 store。
- [x] 新增 test：隔離驗證通過才 promote、schema version 不一致中止、drill 不寫入正式 store。
- [x] 對應 `specs/backup-restore/spec.md`「還原先隔離驗證再 promote」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/restore/
npm run build
```

## T10 restore drill 與 RPO/RTO 量測

> 依賴：T9。

- [x] 新增 scripted restore drill（隔離環境還原→驗證→量測 RPO/RTO→與 policy 比較→產出 evidence）；recovery scans/retries rate-limit。
- [x] 新增 test：drill 產出 RPO/RTO 證據、未達標標示、recovery 掃描 rate-limited、重試有界達界 park。
- [x] 對應 `specs/backup-restore/spec.md`「restore drill」與「recovery 掃描有界」。

驗證命令：

```bash
cd backend
npm run test -- src/operations/restore/
npm run build
```

## T11 migration additive-only 紀律與 mixed-version 相容檢查

> 依賴：T0。

- [x] **additive-only 強制機制**：新增 build-time 靜態檢查（獨立 script + Vitest test，例如 `migration-additive.test.ts` 掃描 `runtime/persistence/migrations/`）解析每支 migration 的 `-- migrate:up` 區塊，拒絕 DROP TABLE／DROP COLUMN／ALTER COLUMN … TYPE／RENAME COLUMN／DROP CONSTRAINT 等非 additive 語句。此為 lint/build-time 檢查，不是 runtime SQL 解析，也不以命名慣例單獨取代。
- [x] 將該檢查接入 `npm run lint`（或新增 `migrations:check` script 並由 lint 串接）。
- [x] 新增 runtime schema-version 相容檢查：old+new instance 並存期間讀取同一 schema，version 不相容 MUST 回報 typed compatibility failure。
- [x] 新增 test：前向只 add 不 drop（以範例 migration 驗證靜態檢查拒 DROP）、old+new instance 並存可運作、不相容 version 被拒、未測試組合標示 unknown。
- [x] 對應 `specs/rolling-deployment-migration/spec.md`。

驗證命令：

```bash
cd backend
npm run lint
npm run test -- src/runtime/persistence/
npm run build
```

## T12 rolling deployment 程序（組合 drain 與 canary）

> 依賴：T11。引用既有 `drainRuntime` 與 `runLiveRuntimeCanary`。

- [x] 以 operator CLI/script 形式交付 rolling-deploy 程序（例如 `operations:rolling-deploy` CLI）：舊 instance stop new claims + drain，canary 驗證 new instance 後才放量；resume 於不相容 version 拒絕。deliverable 為可執行的 operator 程序，不是僅文件描述。
- [x] 新增 test：drain 區分 completed/checkpointed/parked/reconciled/unresolved、canary unhealthy 停止放量、不相容 checkpoint version 拒絕 resume。
- [x] 對應 `specs/rolling-deployment-migration/spec.md`。

驗證命令：

```bash
cd backend
npm run test -- src/operations/drain.test.ts src/operations/canary.test.ts
npm run build
```

## T13 crash recovery 矩陣（多 instance takeover）

> 依賴：T5、T6。引用既有 `fault-injection.ts`。

- [x] 擴充 `fault-injection.ts` 的 `FAULT_INJECTION_CATEGORIES` 以涵蓋新 crash 邊界：step boundary、approval wait、streaming、post-effect-pre-ack，並加入 worker 死亡後另一 instance 依 fencing token takeover。
- [x] 新增 test：各 crash 邊界不重複副作用、不誤報 terminal、post-effect-pre-ack 進 reconciliation。
- [x] 對應 `specs/multi-instance-operation/spec.md` 與 X24「crash tests」acceptance。

驗證命令：

```bash
cd backend
npm run test -- src/operations/fault-injection.test.ts src/runtime/recovery/
npm run build
```

## T14 operator runbook

> 依賴：T8–T12 完成後。

- [x] 產出 operator runbook：regional/service dependency 損失、corrupted projection、restore、reconciliation 的 authority、decision point、rollback、escalation 路徑。
- [x] runbook 標明 RTO/RPO 來源（deployment policy + measured evidence），不寫死 source constant。
- [x] 對應 X24「operator runbook」acceptance（無自動化 test，屬文件驗證）。

驗證命令：

```bash
# 文件審查：確認 runbook 覆蓋 authority／decision point／rollback／escalation
```
