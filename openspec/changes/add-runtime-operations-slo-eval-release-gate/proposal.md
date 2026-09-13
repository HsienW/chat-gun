# Proposal：add-runtime-operations-slo-eval-release-gate

## 變更定位

跨 backend／bff 的第二階段 **P1 hardening** 變更。對應 `second-stage-plan-en-v3.md` 的 **X10.2**（Layer 2 Platform Governance，Dependencies: X8, X8.5A, X8.6, X8.8, X10；另 Reuse X2 Retry Budget、X8.7 authorization）。

X10.2 把 X8 telemetry 與 X8.5A evaluation 轉成**可運維的 production loop**：centralized/exportable Runtime metrics、explicit SLO、persistent long-running goals、bounded execution budgets、quality gates、worker/queue health、lost-run detection、failure drills、graceful deployment drain、execution-version manifests、live canary validation，以及 version-pinned evaluation release gates 在 release 前擋下不安全回歸。

與 X10.1（Long-Term Memory）同屬 roadmap 明訂的「Post-X10 P1 hardening」，可在 dependency 允許時平行推進；本 change 不依賴 X10.1，唯獨在 metrics／operations 資料面與 X10.1 的 memory 讀寫互不覆蓋。

## 為什麼（Why）

X8 已提供 instrumentation／OTel／model fallback／cost tracking（`backend/src/platform/metrics`、`backend/src/platform/tracing`）；X8.5A 提供 versioned datasets／experiments／evaluation（`backend/src/evaluation/opik`）；X8.6 提供 durable side-effect execution semantics（`backend/src/runtime/side-effect`）；X8.8 提供 active-run ownership（`backend/src/runtime/interaction`）。

但 production 仍缺少把「觀察」轉成「治理」的閉環：目前 metrics 只在 process 內、SLO 未成文、沒有 persistent goal／whole-goal budget 邊界（X2 只控 Step 層 retry）、沒有 lost/stuck run 偵測與 drain 語意、release 沒有 version-pinned gate。一個 long-running Agent 可能在 Step 層健康、卻在 turns／tokens／tool calls／elapsed time／cost 上失控，而系統無從察覺與攔截。

因此本變更補上 operations 那一半：**Runtime Telemetry → SLO/Alert → Failure Investigation → Lost/Stuck Run Recovery → Versioned Dataset/Experiment → Release Gate → Deployment Drain + Canary → Production Observation**。

## 問題描述

1. **metrics 未跨 process 聚合** — X8 的 `recordMetric`／OTel 輸出目前不具備「aggregate outside the originating process」的 export 契約；無 vendor-neutral 的 exposure 端點可供 dashboard 消費，也無 queue/run/worker health signal。
2. **SLO 未成文、未版本化** — 沒有明確的 SLI/SLO 文件，也無 configurable threshold；「成功」無操作性定義。
3. **無 persistent goal 與 whole-goal budget** — 只有 chat history 隱含目標；X2 Retry Budget 只控失敗 Step 的 retry，無法限制 long-running goal 的總 turns/tokens/tool calls/elapsed/cost；缺「budget 耗盡 ≠ 成功」的語意。
4. **無 lost/stuck run 偵測與恢復語意** — worker crash、heartbeat loss、no-progress run、orphaned ownership、長時間等待 compensation/reconciliation 的 Task 無操作語意，且 side-effect `unknown` 有盲回放風險。
5. **deployment 無 drain 語意** — 版本切換時沒有「停新 claim → 安全在飛工作完成 → ambiguous effect reconcile → 才退出」的契約，shutdown 可能在 side-effect 未分類時就宣稱成功。
6. **無 execution-version manifest** — resume 無法判斷 old run 是否與新 Runtime 相容；新版本部署後可能盲回放 write/side-effect Step。
7. **release 無 version-pinned evaluation gate** — 缺「deterministic regression + 無 business constraint 回歸 + 無 duplicate side-effect 回歸 + recovery 界內 + cost/latency tolerance + manifest 相容」的釋出門檻；live 只有 `/health = 200` 不足以定義成功 deploy。

## 解決方案

### 架構決策（本提案已凍結，勿再當作開放疑問）

**決策 1 — 指標匯出媒介**：不重造 telemetry。延用 X8 既有 OTel SDK 邊界（`platform/tracing`）與 metrics（`platform/metrics`），新增 **vendor-neutral 的 exposition/export 契約**：backend 提供唯讀 metrics endpoint（Prometheus-compatible 或 OTLP，實作時二擇一並寫入決策）；bff 提供受 X8.7 identity/auth 保護的 **read-only metrics proxy route**，不向公網裸露 raw runtime。跨 process 聚合由 OTel MetricReader/exporter 完成，X10.2 不新增自建聚合器。

**決策 2 — worker/queue 邊界**：**不建第二 queue/worker/scheduler**。延用 LangGraph Agent Server native Queue/Worker；X10.2 只定義 project-level **operational semantics**（worker identity、active-run ownership、claim/lease timestamp、heartbeat freshness、claim/lease expiry、last progress timestamp）與 recovery 分類，不改動 LangGraph 原生排程。

**決策 3 — Execution Budget 與 Step Retry（X2）分離**：X2 `RetryPolicy`／budget 只控「失敗 Step 的 retry」；X10.2 新增 **whole-goal `ExecutionBudget`**，橫跨成功與失敗 turns。budget 耗盡 MUST 產生 `budget_exhausted`，MUST NOT 成為 success；budget counters 必須存活於 checkpoint/resume。

**決策 4 — Quality/Completion Gate deterministic-first**：完成判定採 **versioned、reproducible、deterministic-first** 的 completion policy；MAY 混用 X8.5A 的 bounded evaluation score，但 MUST NOT 以 unversioned LLM-as-a-judge 分數作為唯一完成訊號。

**決策 5 — Recovery safety**：lost/stuck run 分類為 `healthy`／`requeue_safe`／`park_manual`／`already_completed`／`effect_unknown_requires_reconciliation`；side-effect `unknown` MUST 先走 X8.6 reconcile，MUST NOT blind replay；exhausted budget／不安全 ambiguity MUST `park_manual` 並在 Task/Audit/operations output 可見。

**決策 6 — Execution Manifest 與 resume 三態**：每個 durable Run/Task 記錄 `ExecutionManifest`（`runtimeBuildId`／`graphVersion`／`promptVersion`／`modelRouteVersion`／`toolSchemaVersion`／`policyVersion`／`domainSchemaVersion?`／`catalogVersion?`／`embeddingVersion?`／`rerankerVersion?`）。resume 政策為 `compatible → resume`／`migratable → migrate then resume`／`incompatible → pin old env or park/manual-recovery`；write/side-effect Step MUST NOT 只因新 Runtime 版本部署就 blind replay。

### Part A–M 對應（承 X10.2 issue）

- **Part A（Metrics export/aggregation）**：Task/Step/Tool/Token-cost、retry/compensation、side-effect reconciliation、queue/run/worker health 的 export contract。
- **Part B（Runtime SLO）**：versioned/configurable SLI/SLO，threshold 不 hard-code 於 business logic。
- **Part C（Persistent Goal）**：`TaskGoal`（active/paused/completed/budget_exhausted/failed/cancelled），pause/resume 保留同一 Goal identity；完成由 explicit completion/quality policy 決定，非 loop 耗盡。
- **Part D（Execution Budget）**：`ExecutionBudget { maxTurns, maxTokens, maxElapsedMs, maxModelCalls?, maxToolCalls?, maxCostUsd? }`；budget exhaustion ≠ success；可查哪一維耗盡。
- **Part E（Quality/Completion Gate）**：small、versioned、deterministic-first。
- **Part F/G（Worker lease/heartbeat/reaper）**：lost/stuck run 偵測與 `requeue_safe`／`park_manual`／`reconciliation_required` 分類；heartbeat-expired／no-progress／orphaned ownership／waiting-too-long 偵測。
- **Part H（Graceful drain）**：stop new claims → in-flight safe work completes/checkpoint → ambiguous effect reconcile → 才退出；bounded drain timeout；unsafe side-effect 未分類不得宣稱 shutdown success。
- **Part I（Execution Manifest）**：versioned manifest + compatible/migratable/incompatible resume policy。
- **Part J（Runbooks/drills）**：`docs/operations/` 下 concise runbooks；failure drills 有 documented expected behavior/recovery。
- **Part K（Evaluation release gate）**：deterministic-first，reuse X8.5A version-pinned datasets + X10 Hard Negative；可 CI/manual。
- **Part L（Live canary）**：`/health=200` 不足以定義 deploy 成功；bounded live canary（create Task → step → persist → safe mock tool → interrupt/checkpoint → resume → verify audit/OTel/no-duplicate）。
- **Part M（Trace→bad case→dataset loop）**：redact/minimize → versioned regression case → dataset → rerun experiment → before/after。

### 治理原則（承既有 X 系列邊界，本階段納入）

1. **不重造既有能力**：metrics/tracing 走 X8、evaluation 走 X8.5A、side-effect 走 X8.6、interaction/ownership 走 X8.8、authorization 走 X8.7；X10.2 只在其上定義 operations 語意，不另起平行 runtime。
2. **deterministic-first、no fake numbers**：SLO threshold、completion gate、release gate 皆 versioned/configurable；MUST NOT 在 business logic 寫死 production 數字。
3. **safe-first recovery**：所有 lost/stuck run 的分類與重放決策以「不盲回放 side-effect」為最高原則；`unknown` 一律先 reconcile。
4. **observability-first、redaction-first**：runbook/canary/gate 的可觀測輸出不得洩漏 raw prompt、credential、unmasked PII 或 unrestricted tool output（承 X8.6/X8.5A redaction）。

## 目標

- ✅ backend 提供 vendor-neutral metrics export（OTel/Prometheus-compatible），bff 提供受 X8.7 保護的唯讀 metrics route
- ✅ versioned/configurable SLO/SLI 文件（`docs/operations/`）
- ✅ `TaskGoal` persistent lifecycle + `ExecutionBudget` whole-goal budget（budget exhaustion ≠ success）
- ✅ versioned、deterministic-first quality/completion gate
- ✅ worker lease/heartbeat/stuck-run 偵測 + `requeue_safe`／`park_manual`／`reconciliation_required` 恢復語意（不建第二 scheduler）
- ✅ graceful deployment drain + `ExecutionManifest` resume 三態（compatible/migratable/incompatible）
- ✅ `docs/operations/` 下 failure-drill runbooks
- ✅ version-pinned evaluation release gate（reuse X8.5A + X10 hard negative）
- ✅ live runtime canary + trace→bad-case→dataset feedback loop

## 非目標

- ❌ 自建 queue／worker／scheduler／worker pool 或第二 Run Runtime（延用 LangGraph Agent Server native）
- ❌ 自建 metrics 聚合器、自建 dashboard 平台、自建 TSDB（走 OTel exporter 邊界）
- ❌ 企業級 Kubernetes／autoscaling、多區域 DR
- ❌ 取代 X8 OTel、X8.5A Opik evaluation、X8.6 ToolExecution/Reconciliation、X8.8 interaction、X2 retry
- ❌ 以 unversioned LLM-as-a-judge 作為唯一 release/completion 訊號
- ❌ 強制 Opik self-hosting
- ❌ 持久化 command sandbox、cron platform、multi-agent workspace architecture
- ❌ 寫死 production SLO 數字、threshold、URL、credential 於 business logic
- ❌ blind replay 不安全 side-effect（含 version 升級後）— 一律先 reconcile
- ❌ 修改 X8／X8.5A／X8.6／X8.7／X8.8／X2 既有契約

## 規格疑問

本提案已由協調仲裁凍結架構決策（見上），故不列為開放疑問。唯二待 apply-change 實作時以證據鎖定、不改契約方向：

1. **metrics exposition 路徑（Prometheus-compatible endpoint vs OTLP exporter）**：實作時依 X8 既有 `platform/tracing` 的 exporter 配置二擇一，擇定後寫入 `docs/operations/` 決策；兩者皆屬決策 1 的 vendor-neutral 邊界。
2. **worker heartbeat 的可取得 signal**：LangGraph Agent Server 原生可觀測信號（run status、`createdAt`/`updatedAt`、interrupt 狀態）須由 apply-change 以 T0 spike 確認並記錄可用的 claim/lease 投影；若原生未暴露，則以 project-level `ActiveRunOwnership`（X8.8）＋ last-progress timestamp 為替代，MUST NOT 自建 worker 註冊表。

## Capabilities

### New Capabilities

- `runtime-operations-slo-eval-release-gate`：在 X8/X8.5A/X8.6/X8.8 之上提供 production operations 閉環（metrics export/aggregation、SLO/SLI、persistent `TaskGoal`、whole-goal `ExecutionBudget`、quality/completion gate、worker lease/heartbeat/stuck-run recovery、graceful drain、`ExecutionManifest` resume、failure-drill runbooks、version-pinned release gate、live canary、trace→bad-case feedback loop）。

## 受影響範圍

| 套件 | 影響 |
|------|------|
| backend | 新增 `src/operations/`（goal、execution-budget、quality-gate、worker-recovery、drain、execution-manifest、canary、metrics-export + 測試） |
| backend | 唯讀引用 X8 `platform/metrics`／`platform/tracing`、X8.5A `evaluation/opik`、X8.6 `runtime/side-effect`、X8.7 `runtime/authorization`、X8.8 `runtime/interaction`、X2 `runtime/retry`；不修改其契約 |
| backend | 新增 metrics exposition endpoint（唯讀）與 canary executor |
| bff | 新增受 X8.7 identity/auth 保護的唯讀 metrics proxy route；drain/health signal 承接 |
| docs | 新增 `docs/operations/`（SLO/SLI、runbooks、drain、canary、release-gate 決策） |

> frontend 本次不變動。

## 與既有系統的關係

| 既有系統 | 關係 |
|---------|------|
| X8 Metrics/OTel/Cost | 唯讀引用 `recordMetric`／OTel spans；新增 export/aggregation 契約，不重造 telemetry |
| X8.5A Opik evaluation | 唯讀引用 version-pinned datasets/experiments；Part K/M 消費其 dataset 與 judge 配置 |
| X8.6 Side-effect | lost/stuck run 與 canary 的 `unknown` 一律先 `reconcile`；Part K 驗證 no duplicate side-effect |
| X8.7 Authorization | metrics proxy route 與 canary 的 read/auth 邊界；operations 查詢受 tenant/scope 保護 |
| X8.8 Interaction | `ActiveRunOwnership` 作為 lost-run 偵測與 drain 的 project-level 信號來源之一 |
| X2 Retry Budget | 分離：X2 控 Step retry；X10.2 `ExecutionBudget` 控 whole-goal；不取代 |
| X10 Mock/Hard Negative | Part K/L/M 的 concrete regression workload |
| X10.1 Memory | 無依賴；資料面互不覆蓋 |

## 風險

| 風險 | 緩解 |
|------|------|
| LangGraph Agent Server 原生未暴露 worker lease/heartbeat signal | T0 spike 確認可用 signal；缺失則以 X8.8 `ActiveRunOwnership` + last-progress 投影替代，MUST NOT 自建 worker 註冊表 |
| metrics exposition 引入資安面（raw runtime 洩漏） | bff proxy route 受 X8.7 identity/auth 保護；backend endpoint 唯讀、redaction；spec 有未授權 deny Scenario |
| Execution Budget 誤把耗盡當成功 | spec 明訂 `budget_exhausted` ≠ success；可查耗盡維度 |
| lost/stuck run 盲回放 side-effect | recovery 分類強制 `unknown → reconcile`；spec 有 unsafe 不盲回放 Scenario |
| version 升級後 resume 盲回放 write Step | `ExecutionManifest` 三態政策；write/side-effect 不得只因版本部署盲回放 |
| release gate 被 unversioned LLM-judge 綁架 | gate deterministic-first；LLM-judge 僅 bounded、versioned、recorded |
| drain 時 unsafe side-effect 未分類就宣稱 shutdown success | drain 契約明訂「未分類不得宣稱成功」；bounded drain timeout 落 park |
| SLO 數字 hard-code 於 business logic | threshold versioned/configurable；spec 有 config Scenario |

## 回滾策略

- 新增 `backend/src/operations/` 為全新模組，刪除即可回滾。
- metrics endpoint／bff proxy route 為新增唯讀面，可獨立關閉（feature flag／config）而不影響既有 flow。
- 不新增 project migration 於既有 `runtime/persistence`（goal/budget/manifest 若需持久化，採 additive migration 並隔離既有表）；無既有資料遷移、無破壞性 schema 變更。
- 唯讀引用既有 `platform/`、`evaluation/`、`runtime/` 模組，不改其契約；無 frontend 變更。
- runbooks／canary／release-gate 為 docs 與 scripts，可獨立移除。
