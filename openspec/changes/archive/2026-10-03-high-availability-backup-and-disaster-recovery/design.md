# Design：high-availability-backup-and-disaster-recovery

## 1. 責任邊界

本 Change 把既有 X16–X21 的「單 instance 原語」接成「多 instance 安全 + 可還原 + 可演練」的 production foundation。責任分界不變：

- **backend（主要）**：分散式 lease／fencing takeover、事件 sequence resume seed、rebuildable read-model、五層 health/readiness endpoint、備份／還原程序、migration mixed-version 紀律、deployment policy、crash 矩陣、operator runbook。
- **bff（預設不改）**：不承擔 health/readiness 的語意判斷，也不承擔 backup/restore；若未來需對外暴露 readiness，僅 additive passthrough，不得自行推測後端語意。
- **frontend（不改）**：本 Change 標籤不含 frontend；降級 banner／readiness 呈現屬 X30 之後。

## 2. 資料流

```text
Browser → bff → backend (langgraph-api instance A/B/…)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   Redis (shared)    Postgres (shared)   Object storage (N/A 本 Change)
   lock/lease        authoritative facts   （記載為 future dependency）
        │                 │
        └── fencing token ─┘
```

- **run/job ownership**：以 `active_run_ownership`（`013_create_active_run_ownership.sql`）的 `generation` 作為 fencing token；instance 死亡後，另一 instance 以 `generation+1` 遞增 take over，並依 `classifyWorkerRecovery` 決定 requeue／resume／park_manual／reconciliation。
- **事件 sequence**：resume 時以 persisted max sequence `seed(runId, maxPersistedSequence)`，跨 instance resume 不重算 sequence。
- **projection**：incident projection 改為「由 authoritative event log／side-effect ledger 重建」的 read-model，crash 後可 rebuild；不把 process 記憶體當 fact。
- **health/readiness**：backend 直接暴露五層 probe；readiness 依 durable dependency 可達性與「可安全承接的工作類別」判定。

## 3. 設計決策

### 3.1 多 instance 安全（移除 process-local 假設）

| 現況 process-local | 變更 |
| --- | --- |
| `RunSequenceAllocator` in-memory `Map`，composition root 預設 `new` | resume 邊界 seed 自 persisted sequence；composition root 注入 seeded allocator |
| `getIncidentProjectionIndex()` in-memory singleton | 改為 rebuildable read-model，提供 rebuild 入口；record 改寫入 authoritative event log 後投影 |
| `createStepLock()` 無 Redis 回退 `NoopStepLock` | 多 instance 模式 fail-closed；`NoopStepLock` 僅限明確標示的 development 單 instance 模式 |
| session revocation／approval resumption 若殘留 process-local cache | 於每次新 step 與 resume 邊界讀取 durable store（X22 identity status、X20 durable approval/wait）；revocation 跨 instance 生效、不需 process restart |

### 3.2 controlled leader election（僅 singleton work）

- 新增 `SingletonLease`：Redis `SET NX PX` acquire + periodic renew + fencing token；split-brain 由 fencing token + TTL expiry 防護。
- 只套用在真正需要 singleton 的維護工作。本 Change 唯一既有的 singleton 維護工作為 `reaper`（`evaluateStuckRuns`／`classifyWorkerRecovery`）；`projection rebuild` 是 on-demand／operator 觸發的 rebuild（見 §3.3），非週期 singleton sweeper；`notification dedup` 屬 X33，本 Change 不實作。
- 非 singleton work 一律走既有 per-run `StepLock`，不做 leader election。
- 不做 Raft/Paxos；不引入 active-active multi-region。

### 3.3 五層 health/readiness

| 層級 | 語意 | probe |
| --- | --- | --- |
| alive | process 存活 | process-level liveness |
| reachable | dependency 可達 | Redis ping、Postgres `pg_isready`、checkpoint store reachable |
| accept new work | 可安全承接新工作 | 所有必要 dependency + 必要 migration schema version + 非 drain 中 |
| resume durable work | 可 resume durable work | checkpoint store + recovery port reachable |
| degraded | 唯讀降級 | 必要 dependency 可用但部分 write dependency 降級，且已宣告唯讀 |

- readiness MUST 在「endpoint 宣稱的工作類別無法安全承接」時回傳 not-ready（fail-closed）。
- 以五層 model 取代 `projectRuntimeHealth` 中 hardcoded 的二元 `signalStatus`（`available`／`degraded`），五層語意各有獨立 typed 欄位；接上 shared durable 訊號（queue depth、stuck run、ownership heartbeat）。

### 3.4 deployment policy（版本化 SLO/RTO/RPO）

- 新增 `DeploymentPolicy` schema（versioned）：availability target、latency/error budget、RTO、RPO、backup cadence、retention、restore-drill 門檻。
- 由 env（`DEPLOYMENT_POLICY_JSON`）載入 + safe default + Zod validation；未知欄位 fail-closed。
- RTO/RPO 值由 policy + measured evidence 產生，不得寫死 source constant。

### 3.5 備份／還原

| Store | 角色 | 備份策略 |
| --- | --- | --- |
| Postgres | authoritative | pg_dump（logical）本 Change；PITR（WAL）列後續 |
| Redis | non-authoritative | 標示為可重建；RDB/AOF 僅 warm start |
| config metadata | versioned config | 隨 config 版本備份 |
| encryption key | external dependency | 記載為外部 KMS／環境變數依賴，不進 repo |

- 還原程序：先隔離驗證環境 → 驗證 schema version／idempotency ledger／event integrity → 才 promote。
- 不完整／不一致 backup MUST 在宣告可還原前被偵測並拒絕。
- restore drill 對 recovery scans／retries rate-limit，避免二次事故。

### 3.6 migration mixed-version 紀律

- migration 前向只 add（backward-compatible）；不 drop 既有欄位。
- **additive-only 強制機制**：以 build-time 靜態檢查（獨立 script + Vitest test）掃描每支 migration 的 `-- migrate:up` 區塊，拒絕 DROP TABLE／DROP COLUMN／ALTER COLUMN … TYPE／RENAME COLUMN／DROP CONSTRAINT 等非 additive 語句；此為 lint/build-time 檢查，非 runtime SQL 解析。另以 runtime schema-version 相容檢查，讓 old+new instance 並存期間共用 additive-only schema，不相容組合回報 typed compatibility failure。
- 組合既有 `drainRuntime`／`runLiveRuntimeCanary` 成 rolling-deploy 程序（以 operator CLI/script 形式交付）。

## 4. 替代方案與取捨

| 方案 | 取捨 | 結論 |
| --- | --- | --- |
| full consensus（Raft/Paxos） | 完整但有重量依賴、超出 scope | 不採用；僅 controlled leader election |
| active-active multi-region | 完整但需 accepted ADR、超出 scope | 不採用 |
| PITR（WAL archival） | 較小 RPO，但需 operator 建置 WAL 管理 | 列後續；本 Change 先 pg_dump + drill |
| 把 Redis 視為 authoritative 做正式備份 | 增加備份面，但 Redis 可自 authoritative facts 重建 | 不採用；標示 non-authoritative |

## 5. 安全與權限分析

- backup/restore 工具與端點屬 operator-only capability；不得由普通 agent/tool 路徑觸發。
- backup 檔案含 authoritative data，存放與存取需 least-privilege；不得進入 model context、events、logs。
- encryption-key 依賴只在 operator 邊界解析；不得寫入 repo、checkpoint、或 runtime state。
- 五層 health/readiness 端點不得洩漏內部 dependency topology、credential、或 stack trace；回傳型別化、non-leaking 狀態。
- leader election 的 fencing token 不得被 client 或 model 偽造（由 server 端自 durable/generation 導出）。

## 6. 相容性

- 不變更既有 Graph ID、既有公開 BFF route 語意、既有 error-code 語意。
- `NoopStepLock` 於 development 單 instance 模式維持；多 instance 模式 fail-closed，屬 additive 強化。
- migration 只 add；既有 20 支 migration 不倒轉語意。
- deployment policy 預設關閉多 instance 強化，維持既有單 instance 行為。
