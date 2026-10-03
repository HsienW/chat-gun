# multi-instance-operation Specification

## Purpose
TBD - created by archiving change high-availability-backup-and-disaster-recovery. Update Purpose after archive.
## Requirements
### Requirement: 多 instance 對 shared durable state 安全並行

至少兩個 application/runtime instance MUST 能對共享 durable 服務（Postgres authoritative、Redis lock/lease）安全處理工作，且任一 instance 的 process loss MUST NOT 造成 side effect 重複執行、durable work 遺失或 terminal state 誤報。

#### Scenario: 兩 instance 並行處理不重複副作用

- GIVEN 兩個 instance 連至同一 shared Redis 與 Postgres
- AND 兩個 run 各自以 stable idempotency key 執行外部副作用
- WHEN 兩 instance 同時處理
- THEN 同一邏輯 operation MUST 只產生一次外部副作用
- AND side-effect ledger MUST 記錄冪等去重證據

#### Scenario: 任一 instance 死亡不遺失 durable work

- GIVEN instance A 持有一個 run 的 ownership 且該 run 已寫入 durable state
- WHEN instance A 崩潰且另一 instance B 依 fencing token 接手
- THEN durable work MUST 由 B resume 或依 policy requeue／park
- AND 不得因 A 死亡而回報 false success 或 false failure

#### Scenario: 未共享 durable state 時 fail-closed

- GIVEN 一個 instance 嘗試以多 instance 模式啟動
- WHEN 無法連至 shared Redis 或 Postgres
- THEN MUST fail-closed（拒絕承接新工作）
- AND MUST NOT 回退為 process-local 近似

### Requirement: run/job ownership 以 fencing token 安全 takeover

run/job ownership MUST 以 durable `generation` 作為 fencing token；instance 死亡後，另一 instance MUST 以遞增 generation 執行 takeover，並依 recovery classification 決定 requeue／resume／park_manual／reconciliation。split-brain MUST 被 fencing token 防護。

#### Scenario: expired ownership 被遞增 generation takeover

- GIVEN 一個 run 的 active ownership 心跳已過期
- WHEN 另一 instance 偵測到 heartbeat_expired 且 side-effect 分類為 replay-safe
- THEN MUST 以 generation+1 執行 takeover 並 requeue 或 resume
- AND 舊 instance 若仍活著，其舊 generation 的寫入 MUST 被拒絕

#### Scenario: effect unknown 進入 reconciliation 而非盲目重試

- GIVEN 一個 run 在外部副作用後、local ack 前死亡，side-effect state 為 unknown
- WHEN 另一 instance 接手
- THEN MUST 進入 reconciliation（以 provider state 與原 idempotency key 對帳）
- AND MUST NOT 盲目重試該外部 mutation

#### Scenario: superseded ownership 不復活

- GIVEN 一個 run 的 ownership 已被標記 superseded（有 supersededByRunId）
- WHEN 舊 instance 或 replay 嘗試寫入該 run
- THEN MUST 被拒絕
- AND MUST NOT 讓已 superseded 的 execution 回到 running

### Requirement: 事件 sequence 跨 instance resume 不重算

runtime 事件 sequence MUST 在 resume 邊界自 persisted max sequence seed，跨 instance resume 不得把 sequence 從 0 重算，也不得產生重複或倒退的 sequence。

#### Scenario: resume 後 sequence 延續 persisted 值

- GIVEN 一個 run 已 persist 至 sequence N 的事件
- WHEN 於另一 instance 自 checkpoint resume
- THEN 下一事件 sequence MUST 為 N+1
- AND MUST NOT 重算為 1 或與既有事件重複

#### Scenario: persisted sequence 低於目前 sequence 時拒絕

- GIVEN 已 seed 的 sequence 高於 persisted max sequence
- WHEN 嘗試以較低的 persisted sequence seed
- THEN MUST 拒絕（回報 sequence 不一致）
- AND MUST NOT 以倒退 sequence 繼續發事件

### Requirement: projection 由 authoritative facts 重建

user-visible／operator projection（含 incident projection）MUST 為可自 authoritative event log／side-effect ledger 重建的 read-model；projection 的 process 記憶體快取 MUST NOT 成為 fact，crash 後 MUST 能 rebuild 且與 authoritative facts 一致。

#### Scenario: projection crash 後可重建

- GIVEN 一個 instance 的 in-memory projection 於 crash 中遺失
- WHEN 以 authoritative event log 重建
- THEN MUST 重建出等價 projection
- AND MUST NOT 遺失已由 authoritative facts 記錄的 run／incident

#### Scenario: projection failure 不改變 runtime 執行

- GIVEN projection rebuild 失敗
- WHEN runtime 繼續處理工作
- THEN authoritative runtime 執行狀態 MUST NOT 被 projection failure 改變
- AND 失敗 MUST 為可觀測、可重試

### Requirement: multi-instance 模式禁止 NoopStepLock

多 instance 模式（deployment policy 指定）下，`StepLock` 於無法取得 shared Redis 時 MUST fail-closed，MUST NOT 回退 `NoopStepLock`。`NoopStepLock` 僅限於明確標示的 development 單 instance 模式。

#### Scenario: 無 Redis 且多 instance 模式 fail-closed

- GIVEN deployment policy 指定多 instance 模式
- AND shared Redis 不可用
- WHEN 嘗試建立 StepLock
- THEN MUST fail-closed（回報 lock infrastructure unavailable）
- AND MUST NOT 回退為 always-succeed 的 NoopStepLock

#### Scenario: development 單 instance 維持 Noop fallback

- GIVEN deployment policy 指定 development 單 instance 模式
- WHEN 無 Redis 可用
- THEN 可回退 NoopStepLock
- AND 該模式 MUST 於 health 輸出中明確標示為非多 instance 安全

### Requirement: session revocation 與 approval resumption 讀取 durable store

session revocation 與 approval resumption MUST 於每次新 step 與 resume 邊界讀取 durable store（identity status、durable approval/wait state），不得依賴 process 記憶體 cache；revocation MUST 跨 instance 生效，不需 process restart。

#### Scenario: 跨 instance session revocation 即時生效

- GIVEN instance A 撤銷某 session
- WHEN instance B 於該 session 上嘗試新 step 或 resume
- THEN MUST 讀取 durable revocation 狀態並拒絕
- AND MUST NOT 因 instance B 的 process-local cache 而放行已撤銷 session

#### Scenario: approval resumption 讀取 durable wait state

- GIVEN 一個 approval 等待狀態已寫入 durable store
- WHEN 另一 instance 接手 resume 該 approval
- THEN MUST 自 durable wait state 恢復，而非自 process 記憶體
- AND MUST 不重複前置副作用

### Requirement: controlled leader election 僅限 singleton work

MUST 提供 `SingletonLease`（Redis `SET NX PX` acquire + renew + fencing token）承接真正需要 singleton 的維護工作；本 Change 唯一既有的 singleton 維護工作為 reaper。projection rebuild 為 on-demand／operator 觸發（非週期 singleton sweeper），notification dedup 屬 X33（本 Change 不實作）。split-brain MUST 由 fencing token 與 TTL expiry 防護。非 singleton work MUST 走既有 per-run StepLock，不使用 leader election。

#### Scenario: singleton 維護工作單一 leader 執行

- GIVEN 多個 instance 同時嘗試取得同一個 singleton maintenance lease
- WHEN 一個 instance 已持有 lease
- THEN 其他 instance MUST 無法取得
- AND 維護工作 MUST 只由持有 lease 的 instance 執行

#### Scenario: leader 死亡後 lease 過期可被取得

- GIVEN leader instance 持有 lease 但不再 renew（死亡）
- WHEN lease TTL 過期
- THEN 另一 instance MUST 能以新 fencing token 取得 lease
- AND 舊 leader 若復活，其舊 token 的寫入 MUST 被拒絕

#### Scenario: 非 singleton work 不使用 leader election

- GIVEN 一個一般 run 的 tool step
- WHEN 執行該 step
- THEN MUST 走既有 per-run StepLock
- AND MUST NOT 依賴 singleton leader
