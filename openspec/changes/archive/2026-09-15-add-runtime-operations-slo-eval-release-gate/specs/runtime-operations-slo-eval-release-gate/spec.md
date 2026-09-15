# Specs：add-runtime-operations-slo-eval-release-gate

## ADDED Requirements

### Requirement: Runtime metrics MUST aggregate outside the originating process 且匯出 MUST 經 redaction 與授權保護

Runtime metrics（Task/Step/Tool/Token-cost、retry/compensation、side-effect reconciliation、queue/run/worker health）MUST 透過 vendor-neutral 路徑（OTel/Prometheus-compatible）匯出，使 metrics 能於 originating process 之外聚合。metrics exposition endpoint MUST 為唯讀，bff 的 metrics proxy route MUST 經 X8.7 authorization 保護。匯出與查詢輸出 MUST NOT 含 raw prompt、credential、unmasked PII 或 unrestricted tool output。

#### Scenario: metrics 於 originating process 之外可聚合

GIVEN Runtime 產生 metrics
WHEN 檢查 metrics 是否可匯出
THEN MUST 可經 vendor-neutral 路徑於 originating process 之外聚合
AND MUST NOT 僅存在於 process 內部記憶體

#### Scenario: 未授權無法存取 metrics proxy

GIVEN principal 未經 X8.7 authorization
WHEN 嘗試經 bff 存取 metrics
THEN MUST deny
AND MUST NOT 回傳 raw runtime 資料

#### Scenario: 匯出內容 redaction

GIVEN metrics 匯出
WHEN 檢視輸出
THEN MUST NOT 含 raw prompt、credential、unmasked PII 或 unrestricted tool output

---

### Requirement: SLO/SLI MUST 版本化且 threshold 可設定，MUST NOT 在 business logic 寫死 production 數字

Runtime SLO/SLI（含 task reliability、recovery、side-effect safety、compensation、latency、queue、worker、model、cost、recommendation quality）MUST 有 versioned、configurable threshold。MUST NOT 在 business logic 寫死 production 數字。

#### Scenario: threshold 可設定

GIVEN 需要調整某 SLO threshold
WHEN 修改設定
THEN MUST 可經 config 調整
AND MUST NOT 修改 business logic 才能變更 threshold

---

### Requirement: long-running work MUST 有 persistent goal，pause/resume MUST 保留同一 goal identity

long-running work MUST 具 explicit durable objective（`TaskGoal`）而非僅依 chat history。goal status MUST 為 active/paused/completed/budget_exhausted/failed/cancelled 之一。business intent 不變時 pause/resume MUST 保留同一 `goalId`。goal completion MUST 由 explicit completion/quality policy 決定，MUST NOT 僅因 loop 耗盡。

#### Scenario: pause/resume 保留同一 goal identity

GIVEN 一個 active `TaskGoal` 被 pause
WHEN 以相同 business intent resume
THEN MUST 保留同一 `goalId`
AND MUST NOT 產生新 goal identity

#### Scenario: completion 由 gate 決定而非 loop 耗盡

GIVEN goal loop 已達迭代上限但 completion/quality gate 未通過
WHEN 判定 goal 狀態
THEN MUST NOT 標記為 completed
AND MUST 依 policy 標記為 budget_exhausted 或繼續（若 budget 剩餘）

---

### Requirement: ExecutionBudget MUST 控 whole-goal 預算且 budget exhaustion MUST NOT 為 success

`ExecutionBudget`（maxTurns/maxTokens/maxElapsedMs/maxModelCalls?/maxToolCalls?/maxCostUsd?）MUST 控 long-running goal 的總 turns/tokens/elapsed/model calls/tool calls/cost，橫跨成功與失敗 turns，與 X2 Step retry 分離。budget exhaustion MUST 產生 `budget_exhausted` 且 MUST NOT 為 success。counters MUST 存活於 checkpoint/resume。operators MUST 可查哪一維耗盡。

#### Scenario: budget exhaustion 非 success

GIVEN `ExecutionBudget` 任一維耗盡
WHEN 判定 goal 結果
THEN goal status MUST 為 `budget_exhausted`
AND MUST NOT 為 `completed` 或 success

#### Scenario: counters 存活於 resume

GIVEN 一個 goal 已消耗部分 budget 並 checkpoint
WHEN resume
THEN 已消耗的 counters MUST 保留
AND MUST NOT 歸零重算

#### Scenario: 可查耗盡維度

GIVEN budget 耗盡
WHEN operators 檢查
THEN MUST 可識別是哪一維（turns/tokens/elapsed/model/tool/cost）耗盡

---

### Requirement: quality/completion gate MUST 為 versioned、reproducible、deterministic-first

completion gate MUST 為 versioned、reproducible 且 deterministic-first。MAY 混用 X8.5A bounded evaluation score/assertion，MUST NOT 以 unversioned LLM-as-a-judge 分數作為唯一 completion 訊號。

#### Scenario: 不依賴 unversioned LLM-judge 作為唯一訊號

GIVEN 完成判定
WHEN 檢視 gate 訊號
THEN MUST NOT 僅以 unversioned LLM-as-a-judge 分數作為唯一 completion 訊號
AND 核心判定 MUST 具 deterministic/reproducible 基礎

---

### Requirement: lost/stuck run 偵測 MUST 分類，side-effect unknown MUST 先 reconcile，unsafe MUST NOT blind replay

lost/stuck run MUST 依可用 signal（heartbeat freshness、no-progress、orphaned ownership、last progress timestamp）偵測並分類為 healthy/requeue_safe/park_manual/already_completed/effect_unknown_requires_reconciliation。read-only/replay-safe work MAY requeue/resume；side-effect `unknown` MUST 先經 X8.6 reconcile；exhausted retry budget 或 unsafe ambiguity MUST `park_manual` 且於 Task/Audit/operations 可見。MUST NOT 盲回放 unsafe side-effect。

#### Scenario: side-effect unknown 先 reconcile

GIVEN lost run 的 side-effect 狀態為 `unknown`
WHEN 決定是否重放
THEN MUST 先經 X8.6 reconcile
AND MUST NOT 直接 blind replay

#### Scenario: unsafe ambiguity park 而非 requeue

GIVEN lost run 存在 unsafe ambiguity 或 exhausted retry budget
WHEN 決定 recovery
THEN MUST `park_manual`
AND MUST NOT requeue
AND manual parking MUST 於 Task/Audit/operations 可見

#### Scenario: replay-safe work 可 requeue

GIVEN lost run 為 read-only 或 replay-safe
WHEN 決定 recovery
THEN MAY requeue/resume

---

### Requirement: graceful deployment drain MUST 停止新 claim 並在不安全 side-effect 未分類前不得宣稱 shutdown success

deployment drain MUST 依序停止新 claim → in-flight safe work completes 或 checkpoint → ambiguous effect reconcile → 才退出。drain MUST 有 bounded timeout；timed-out work MUST persist recoverable state or park。shutdown MUST NOT 在 unsafe side-effect state 未分類時 report success。

#### Scenario: unsafe side-effect 未分類不得宣稱 shutdown success

GIVEN drain 過程中仍有 unsafe side-effect state 未分類
WHEN 判定 shutdown 結果
THEN MUST NOT 宣稱 shutdown success
AND MUST 先 reconcile 或 park

#### Scenario: drain 停止新 claim

GIVEN 新版本 ready
WHEN 執行 drain
THEN old worker MUST 停止 claim 新 work
AND in-flight safe work MUST 完成或 checkpoint

---

### Requirement: 每個 durable Run/Task MUST 記錄 ExecutionManifest，resume MUST 依 compatible/migratable/incompatible 政策

每個 durable Run/Task MUST 記錄 `ExecutionManifest`（runtimeBuildId/graphVersion/promptVersion/modelRouteVersion/toolSchemaVersion/policyVersion 等）。resume MUST 依 `compatible → resume`／`migratable → migrate then resume`／`incompatible → pin old env or park/manual-recovery` 政策。write/side-effect Step MUST NOT 只因新 Runtime 版本部署就 blind replay。

#### Scenario: incompatible resume 不盲回放

GIVEN 舊 Run 的 ExecutionManifest 與新 Runtime 不相容
WHEN resume
THEN MUST 依政策 pin old env 或 park/manual-recovery
AND write/side-effect Step MUST NOT blind replay

#### Scenario: compatible resume 直接續跑

GIVEN 舊 Run 的 ExecutionManifest 與新 Runtime 相容
WHEN resume
THEN MAY 直接 resume

---

### Requirement: evaluation release gate MUST 為 version-pinned 且 deliberate regression MUST fail the gate

release gate MUST reuse X8.5A version-pinned datasets 與 X10 Hard Negative cases，涵蓋 deterministic regression、business constraint violation、duplicate side-effect、runtime recovery 界內、cost/latency tolerance 與 ExecutionManifest 相容。任一項失敗 MUST fail the gate。deliberate Hard Negative 或 side-effect regression MUST fail the gate。

#### Scenario: deliberate hard negative regression fails gate

GIVEN 注入 deliberate Hard Negative 或 side-effect regression
WHEN 執行 release gate
THEN gate MUST fail
AND MUST NOT 放行 release

#### Scenario: 比較同一 dataset 版本

GIVEN 兩個 model/prompt/agent 配置
WHEN 執行 release gate
THEN MUST 使用同一 dataset version 比較

---

### Requirement: live deployment MUST 以 bounded canary 驗證，成功 deploy 不得僅以 /health=200 定義

live deployment MUST 執行 bounded canary：create Task → step → persist → safe mock tool → interrupt/checkpoint → resume → verify audit/OTel/no-duplicate side-effect。canary MUST 記錄 Runtime Build ID／ExecutionManifest、使用 safe resources、留 cleanup trace、失敗即標記 deployment unhealthy。

#### Scenario: canary 失敗標記 unhealthy

GIVEN canary 任一步失敗（含 no-duplicate side-effect 檢查失敗）
WHEN 判定 deployment 狀態
THEN MUST 標記 unhealthy
AND MUST NOT 僅以 `/health = 200` 視為成功 deploy

#### Scenario: canary 驗證無 duplicate side-effect

GIVEN canary 執行 interrupt/resume
WHEN resume
THEN MUST 驗證無 duplicate side-effect

---

### Requirement: bad trace MUST 可轉為 redacted、version-pinned regression case 進入 dataset 並可比對 before/after

bad trace MUST 經 redact/minimize 後成為 versioned regression case 進入 X8.5A dataset，MUST 可 rerun experiment 並比較 before/after。redaction MUST 移除 raw prompt、credential、unmasked PII 與 unrestricted tool output。

#### Scenario: bad trace 成為 version-pinned regression case

GIVEN 一個 bad trace
WHEN 執行 feedback loop
THEN MUST 經 redact/minimize 成為 versioned regression case
AND MUST 進入 dataset
AND MUST 可 rerun experiment 比較 before/after

#### Scenario: feedback loop redaction

GIVEN bad trace 含 raw prompt／credential／unmasked PII
WHEN 轉為 regression case
THEN MUST 移除上述內容
AND MUST NOT 將未遮蔽內容寫入 dataset
