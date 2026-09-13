# Design：add-runtime-operations-slo-eval-release-gate

## 架構分層

```text
backend/src/operations/                     (X10.2 - 新增)
├── types.ts                 TaskGoal / GoalStatus / ExecutionBudget / ExecutionManifest /
│                            WorkerRecoveryClassification + runtime validation
├── metrics/
│   ├── export.ts            vendor-neutral metrics exposition/export（OTel/Prometheus-compatible）
│   └── health.ts            queue/run/worker health signal 投影
├── goal/
│   ├── task-goal.ts         persistent TaskGoal lifecycle（active/paused/completed/budget_exhausted/failed/cancelled）
│   └── execution-budget.ts  whole-goal ExecutionBudget（與 X2 Step retry 分離）
├── quality-gate.ts          versioned、deterministic-first completion gate
├── recovery/
│   ├── worker-recovery.ts   lease/heartbeat 投影 + lost/stuck run 分類
│   └── reaper.ts            heartbeat-expired / no-progress / orphaned ownership / waiting-too-long 偵測
├── drain.ts                 graceful deployment drain（stop claims → drain → reconcile → exit）
├── manifest.ts              ExecutionManifest + compatible/migratable/incompatible resume policy
├── canary.ts                live runtime canary（create → step → safe tool → interrupt → resume → verify）
├── index.ts                 barrel export
└── *.test.ts                單元／整合測試（deterministic-first；live canary 獨立 smoke）

backend/src/platform/metrics/              (X8 - 唯讀引用 recordMetric)
backend/src/platform/tracing/              (X8 - 唯讀引用 OTel spans)
backend/src/evaluation/opik/               (X8.5A - 唯讀引用 dataset/experiment)
backend/src/runtime/side-effect/           (X8.6 - 唯讀引用 reconcile)
backend/src/runtime/authorization/         (X8.7 - 唯讀引用 authorize/ResourceRef)
backend/src/runtime/interaction/           (X8.8 - 唯讀引用 ActiveRunOwnership)
backend/src/runtime/retry/                 (X2 - 唯讀引用 RetryPolicy；不取代)

bff/src/metrics-proxy.ts                   (新增 - GET /api/operations/metrics → backend /operations/metrics)
docs/operations/                           (新增 - SLO/SLI、runbooks、drain、canary、release-gate 決策)
```

X10.2 **不新增第二 queue/worker/scheduler**；worker 語意是 LangGraph Agent Server native Queue/Worker 之上的 project-level 投影。X10.2 不新增既有 `runtime/persistence` 的 migration；goal/budget/manifest 若需持久化，採 **additive migration** 並隔離既有表。

## 指標匯出與聚合（決策 1，Part A/B）

- 延用 X8 既有 `recordMetric`／OTel span；X10.2 選定 **OpenMetrics/Prometheus-compatible pull exposition**，由 OTel `MetricReader`／exporter 產生跨 process 可聚合的 exposition，不新增自建聚合器。選擇理由與 deployment scrape 設定寫入 `docs/operations/`。
- 匯出的 metric 維度：Task/Step/Tool/Token-cost、retry/compensation、side-effect reconciliation、queue/run/worker health。
- backend operations metrics endpoint 為**唯讀**；bff 新增 `metrics-proxy.ts`，以 X8.7 `authorize` 保護後轉發，MUST NOT 向公網裸露 raw runtime。
- **redaction-first**：匯出與查詢輸出不得含 raw prompt、credential、unmasked PII 或 unrestricted tool output（承 X8.6/X8.5A）。

### BFF metrics proxy 跨層契約（M3）

X10.2 的新契約不得改變 X8 既有 `GET /api/metrics` JSON snapshot；operations scrape 使用獨立 route，避免既有 consumer 因 content type 或 payload 改變而破壞。

| 邊界 | 契約 |
|---|---|
| Public route | `GET /api/operations/metrics`；`HEAD`、其他 method 與 request body 不在契約內，其他 method 回 `405` |
| Backend route | BFF 代理至由 config 決定的 backend origin 上 `GET /operations/metrics`；不得在 handler 寫死 host、port 或 credential |
| Query | 不接受 query parameter；存在任何 query parameter 時回 `400`，不得透傳成 tenant、principal 或 label selector |
| Request headers | 僅接受／轉發受控 `Accept` 與 BFF 產生的 `x-request-id`；不得轉發 client credential、Cookie 或 client-provided tenant/principal header |
| Success response | backend 回 `application/openmetrics-text; version=1.0.0; charset=utf-8`（相容 client 亦可請求 Prometheus `text/plain; version=0.0.4`）；BFF 保留 status、允許的 cache/content headers 與 body，採 bounded streaming pass-through，MUST NOT 轉成 JSON 或重新計算 metrics |
| Error response | identity/auth failure 使用 `401`／`403`；非法 query／method 使用 `400`／`405`；upstream timeout／failure 依既有 BFF safe error envelope 映射為 `504`／`502`，不得透出 upstream credential、stack 或原始敏感 body |

授權在 BFF 進行且預設拒絕。BFF 必須從已驗證的 trusted principal 建立 X8.7 `AuthorizationRequest`：

```typescript
{
  action: "operations.metrics.read",
  resource: {
    resourceType: "runtime_metrics",
    resourceId: configuredRuntimeDeploymentId,
    tenantId: configuredOperationsTenantId,
  },
  scope: {
    scopeType: "tenant",
    scopeId: trustedOperationsScopeId,
    tenantId: configuredOperationsTenantId,
  },
  principal: trustedPrincipal,
}
```

- 僅 `principalType` 為 `platform_staff` 或 `service`，且 policy 明確授與 `operations:metrics:read` scope/role 的 principal 可讀；principal、scope、resource 三者的 `tenantId` 必須一致。
- `configuredRuntimeDeploymentId`、`configuredOperationsTenantId` 與 trusted scope 均來自啟動時驗證的 server config／identity projection，不得由 query、一般 browser header 或 response payload 決定。
- `runtime_metrics` 與 `operations.metrics.read` 使用 X8.7 既有可擴充的 string resource/action contract；不修改 X8.7 engine、reason code 或既有 resource semantics。
- exposition 只含低基數、已彙總的 operations labels；tenant ID、principal ID、Task/Run/ToolCall ID 與其他高基數或敏感值不得成為 label。backend 負責產生與 redaction，BFF 負責 auth、header allowlist、timeout、abort、backpressure 與 safe error mapping。

### SLO/SLI（Part B）

| Dimension | Example SLI |
|---|---|
| Task reliability | Task Success Rate |
| Recovery | Resume Success Rate / Retry Recovery Rate |
| Side-effect safety | Duplicate Prevention / Unknown Effect Rate |
| Compensation | Compensation Success Rate |
| Latency | Task Completion P95 / Tool P95 |
| Queue | Queue Wait P95 |
| Worker | Saturation / stuck-run count / heartbeat freshness |
| Model | Fallback Rate / repair success |
| Cost | Cost per Successful Task |
| Recommendation quality | Hard Negative Leakage / Constraint Violation |

Threshold **versioned/configurable**；MUST NOT 在 business logic 寫死 production 數字。

## 核心模型

### TaskGoal（Part C）

```typescript
type TaskGoalStatus =
  | "active" | "paused" | "completed"
  | "budget_exhausted" | "failed" | "cancelled";

interface TaskGoal {
  goalId: string;
  taskId: string;
  objective: string;
  status: TaskGoalStatus;
  progressSummary?: string;
  createdAt: string;
  updatedAt: string;
}
```

- long-running work 有 explicit durable objective；pause/resume 保留同一 `goalId`（business intent 不變時）。
- completion 由 explicit completion/quality policy 決定，非 loop 耗盡。
- goal status 與 budget exhaustion 於 Task/Audit/operations output 可見。

### ExecutionBudget（Part D，與 X2 分離）

```typescript
interface ExecutionBudget {
  maxTurns: number;
  maxTokens: number;
  maxElapsedMs: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxCostUsd?: number;
}
```

```text
Goal active
  → execute next bounded iteration
  → update usage
  → quality/completion gate satisfied?
      yes → completed
      no  → budget remains?
              yes → continue
              no  → budget_exhausted
```

- **budget exhaustion is not success**；counters 存活於 checkpoint/resume；可查哪一維耗盡。
- side-effect safety 仍走 X8.6；budget exhaustion MUST NOT authorize unsafe replay。

#### ExecutionBudget checkpoint 持久化策略（M1）

`ExecutionBudget` 是限制 policy；實際使用量另以 JSON-serializable `CheckpointedExecutionBudget` 存入 LangGraph Graph State，並由現有 LangGraph checkpointer 隨同同一 `threadId`／Run checkpoint 原子保存。X10.2 不以 process memory、metrics snapshot 或另建資料表作為 resume 的 source of truth。

```typescript
type ExecutionBudgetDimension =
  | "turns" | "tokens" | "active_elapsed_ms"
  | "model_calls" | "tool_calls" | "cost_usd";

interface ExecutionBudgetUsage {
  turns: number;
  tokens: number;
  activeElapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
}

interface CheckpointedExecutionBudget {
  schemaVersion: "1";
  goalId: string;
  policyVersion: string;
  limits: ExecutionBudget;
  usage: ExecutionBudgetUsage;
  exhaustedDimensions: ExecutionBudgetDimension[];
  updatedAt: string;
}
```

| State 規則 | 設計 |
|---|---|
| Graph State 欄位 | 新增 `executionBudgetState?: CheckpointedExecutionBudget`；新建 X10.2 durable goal 時為 required，optional 僅用於讀取 pre-X10.2 checkpoint |
| Owner | `goal/execution-budget.ts` 的 budget accounting node／reducer 是唯一 writer；其他 node 只能提交非負、有限的 usage delta，不得直接覆寫累計值 |
| Write timing | goal 建立時寫入 policy/version 與零值；每個 bounded iteration 在 dispatch 前先 checkpoint 可預知的 turn/model/tool reservation，完成後以實際 token/cost/active elapsed 對帳；pause、interrupt、terminal transition 前必須再 checkpoint |
| Read path | resume 先由 LangGraph checkpointer 還原 Graph State，再對 `executionBudgetState` 做 runtime validation、確認 `goalId`／`policyVersion`／ExecutionManifest 相容，最後才執行下一個 budget guard；不得從零建立 counters 覆蓋已還原值 |
| Elapsed 語意 | `activeElapsedMs` 累加實際 active execution interval；paused／interrupt 等待時間不增加，避免以新的 process start time 重算 |
| Exhaustion | reducer 以已持久化 usage + 本次 reservation 判定；任一維達上限即寫入 `exhaustedDimensions` 並轉為 `budget_exhausted`，不得再進入 completion success |

相容與 migration 規則：

- 新 goal 的 `executionBudgetState` 與 `ExecutionManifest.policyVersion` 必須一起 checkpoint；兩者版本不一致時 fail closed。
- pre-X10.2 checkpoint 缺少 budget 欄位時，additive checkpoint migration 只能從可信 Task/Step/model/tool/cost ledger 重建 monotonic counters；資料不足或無法證明完整時標記 `incompatible` 並 `park_manual`，MUST NOT 以零值 resume。
- 若需要 operations 查詢索引，可新增以 `goalId + checkpointVersion` 為鍵的 additive projection table；它只由 checkpoint 更新投影，不得成為 budget 判定或 resume 的 source of truth，也不修改既有 persistence table 語意。
- X2 `RetryPolicy` counters 維持獨立；同一個 retry 可增加 X10.2 的 turns/model/tool/token/cost usage，但不得互相覆寫或用其中一方重建另一方。

### ExecutionManifest（Part I）

```typescript
interface ExecutionManifest {
  runtimeBuildId: string;
  graphVersion: string;
  promptVersion: string;
  modelRouteVersion: string;
  toolSchemaVersion: string;
  policyVersion: string;
  domainSchemaVersion?: string;
  catalogVersion?: string;
  embeddingVersion?: string;
  rerankerVersion?: string;
}
```

Resume policy：`compatible → resume`／`migratable → migrate then resume`／`incompatible → pin old env or park/manual-recovery`。write/side-effect Step MUST NOT 只因新 Runtime 版本部署就 blind replay。

### WorkerRecoveryClassification（Part F/G）

```text
healthy
requeue_safe
park_manual
already_completed
effect_unknown_requires_reconciliation
```

- read-only/replay-safe work MAY requeue/resume；side-effect `unknown` MUST reconcile（X8.6）first。
- exhausted retry budget／unsafe ambiguity → `park_manual`，於 Task/Audit/operations 可見。

## Worker lease/heartbeat 與 lost/stuck run 語意（決策 2，Part F/G）

不建第二 queue/worker。以 LangGraph Agent Server native Queue/Worker 的可用 signal 建立 project-level 投影：

- worker identity、active Run ownership（X8.8 `ActiveRunOwnership`）、claim/lease timestamp、heartbeat freshness、claim/lease expiry、last progress timestamp。
- `reaper.ts` 偵測：heartbeat-expired Run、no-progress Run、orphaned ownership、waiting-too-long（compensation/reconciliation）Task。
- Terminal operational decisions：`requeued`／`resumed`／`parked_manual`／`completed_elsewhere`／`reconciliation_required`；MUST NOT 盲回放 unsafe side-effect。
- **T0 spike**：apply-change 以 T0 確認 LangGraph 原生可取得的 claim/lease signal；缺失則以 `ActiveRunOwnership` + last-progress 投影替代，MUST NOT 自建 worker 註冊表。

## Graceful deployment drain（決策 2，Part H）

```text
new version ready
  → old worker stops claiming new work
  → in-flight safe work completes or persists checkpoint
  → ambiguous effects reconcile
  → old worker exits only after drain policy is satisfied
```

- stop new claims（when preventable）、bounded drain timeout。
- timed-out work persists recoverable state or parks。
- shutdown MUST NOT report success while unsafe side-effect state remains unclassified。

## Quality/Completion Gate 與 Release Gate（決策 4，Part E/K）

completion gate 採 declarative、versioned policy，不接受任意 executable callback 或自由文字條件。至少包含一個 required deterministic check，且下列所有 required check 均通過，才可考慮 optional evaluation：

| Deterministic check 類別 | 判定內容 |
|---|---|
| `schema_conformance` | candidate output、Task/Goal terminal payload 通過指定 versioned runtime schema，無未知必填欄位或型別錯誤 |
| `expected_value` | 以 versioned fixture 的 JSON Pointer 做 equality／set membership／numeric range 等封閉 operator 比對 |
| `required_evidence` | policy 指定的 artifact/audit/provenance reference 存在、可解析且版本相符 |
| `state_invariant` | Goal/Run/Step terminal state 合法；`budget_exhausted`、failed、cancelled 不得映射為 completed |
| `side_effect_invariant` | X8.6 ledger 中 duplicate effect count 為 0，且 `unknown` 已 reconcile 或使 gate fail |
| `recovery_bound` | resume/retry/drain 次數與時間不超過 versioned policy 的 configured bounds |

Gate I/O contract：

```typescript
interface CompletionGateInput {
  policyRef: { policyId: string; version: string; digest: string };
  goal: { goalId: string; status: TaskGoalStatus };
  candidate: unknown;
  facts: Record<string, unknown>; // schema 驗證後的 bounded facts，不含 raw prompt/credential
  deterministicChecks: Array<{
    checkId: string;
    kind:
      | "schema_conformance" | "expected_value" | "required_evidence"
      | "state_invariant" | "side_effect_invariant" | "recovery_bound";
    required: true;
    configRef: { version: string; digest: string };
  }>;
  evaluation?: {
    datasetId: string;
    datasetVersion: string;
    evaluatorId: string;
    evaluatorVersion: string;
    normalizedScore: number; // finite，0 <= score <= 1
    threshold: number;       // finite，0 <= threshold <= 1；來自 versioned policy
    maxJudgeCalls: number;
    timeoutMs: number;
  };
}

type CompletionGateResult =
  | {
      status: "passed" | "failed";
      policyRef: CompletionGateInput["policyRef"];
      checks: Array<{ checkId: string; passed: boolean; reasonCode: string }>;
      evaluation?: { passed: boolean; normalizedScore: number; threshold: number };
      evaluatedAt: string;
    }
  | {
      status: "invalid_policy";
      policyRef: CompletionGateInput["policyRef"];
      reasonCode: string;
      evaluatedAt: string;
    };
```

判定順序與 bounded evaluation 規則：

1. 驗證 policy/input schema、digest 與版本；缺少 deterministic check、版本或 digest 時回 `invalid_policy` 並 fail closed。
2. 依固定順序執行全部 required deterministic checks；任一失敗即 `failed`，optional evaluation 不執行或不得覆蓋結果。
3. `evaluation` 僅能使用 X8.5A version-pinned dataset/evaluator；`normalizedScore`／`threshold` 必須為 `[0,1]` 內 finite number，且 `maxJudgeCalls`／`timeoutMs` 為 policy 中的正整數上限。超界、逾時、缺版本或無法重現時 gate fail closed。
4. policy 若要求 evaluation，只有 `normalizedScore >= threshold` 才通過；evaluation 只能把 deterministic pass 收緊為 fail，不能把 deterministic failure 提升為 pass，也不能單獨構成 completion。
5. LLM-as-a-judge 若被使用，必須有 versioned evaluator/prompt/model-route、bounded calls/timeout 與已 redacted input/output reference；unversioned judge 結果視為無效訊號。

- release gate（Part K）reuse X8.5A version-pinned datasets + X10 Hard Negative：

```text
Deterministic regression suite passes
AND No Business Constraint violation regression
AND No Duplicate side-effect regression
AND Runtime recovery remains within configured bounds
AND Cost/latency regression within tolerance
AND ExecutionManifest compatibility check passes
```

gate 初期可 CI/manual release review；任一項失敗 MUST fail the gate。

## Live Runtime Canary（Part L）

成功 deploy 不以 `/health = 200` 定義。bounded live canary：

```text
Create Task → execute Step → persist Task/Step/Event → invoke safe Mock Tool
→ interrupt / checkpoint → resume → verify Audit → verify OTel trace → verify no duplicate side effect
```

- canary 記錄 Runtime Build ID／ExecutionManifest、使用 safe resources、留 cleanup trace、失敗即標記 deployment unhealthy。

## Trace → Bad Case → Dataset Feedback Loop（Part M）

```text
Bad trace → redact/minimize → versioned regression case → dataset → rerun experiment → compare before/after
```

- 承 X8.5A 的 dataset/experiment 邊界；至少一個 bad trace 成為 redacted、version-pinned regression case。

## 替代方案

| 方案 | 評估 |
|------|------|
| 自建 queue/worker/scheduler | ❌ issue Excludes 明訂；延用 LangGraph Agent Server native |
| 自建 metrics 聚合器／TSDB／dashboard | ❌ 走 OTel exporter 邊界；不新增自建基礎設施 |
| 以 X2 Step retry 充當 whole-goal budget | ❌ 語意不同；X10.2 明訂分離 |
| 以 unversioned LLM-judge 為唯一 release/completion 訊號 | ❌ 違反 deterministic-first |
| lost/stuck run 直接 requeue 不先 reconcile | ❌ unsafe side-effect 盲回放風險 |
| 版本升級後 blind replay write Step | ❌ 違反 ExecutionManifest resume 政策 |
| 在 business logic 寫死 production SLO 數字 | ❌ 違反 config/versioned threshold |
| 以 `/health=200` 定義 deploy 成功 | ❌ Part L 明訂不足以定義 |
| 暴露 raw runtime metrics 於公網 | ❌ 違反 redaction 與 X8.7 auth |

## 責任邊界

| 套件 | 責任 |
|------|------|
| backend（X10.2 operations） | `TaskGoal`／`ExecutionBudget`／quality-gate／worker-recovery／reaper／drain／`ExecutionManifest`／canary／metrics-export；唯讀引用 X8/X8.5A/X8.6/X8.7/X8.8/X2，不改其契約 |
| backend（X8/X8.5A/X8.6/X8.7/X8.8/X2） | 零變更 |
| bff（X10.2 metrics proxy） | 受 X8.7 identity/auth 保護的唯讀 metrics proxy route + drain/health signal 承接 |
| docs | `docs/operations/`：SLO/SLI、runbooks、drain、canary、release-gate 決策 |
| frontend | 本次不變動 |
