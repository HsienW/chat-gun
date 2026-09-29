# Design: enforce-runtime-production-readiness-gate

## 責任邊界

### backend（operations 擴充，X21 新增/擴充）
- 建立單一 `ExecutionCompositionRoot`（組裝 X12→X17→X18→X14→X19→X20 的真實執行路徑）。
- 建立 `ReadinessGate` composition root，組合 release gate、canary、architecture checks、fault-injection。
- 擴充 `canary.ts`：以 safe test resource 呼叫 `ExecutionCompositionRoot`。
- 強制每個 durable Run/Task 附 `ExecutionManifest`（fail-closed）與 additive migration 機制。
- 擴充 `metrics/export.ts`：以 canonical `runId` 關聯，分離四類執行結果。
- 新增 version-pinned fault-injection datasets 與 release-gate negative checks。
- 新增 architecture checks（runtime fail-closed + 靜態 archguard）與 operator override 機制。
- 新增 per-boundary rollback/disable switch（`runtime-config` feature flag，含完整停用語意表）。

### backend（X12/X14/X18/X19/X20 既有模組）
- 零契約變更；`ExecutionCompositionRoot` 唯讀引用其 public entry 並組裝。

### bff（transport 邊界）
- correlated metrics 關聯鍵透傳（沿用 X13 trusted identity、X19 透傳契約），不做語意改寫。
- 新增唯讀 incident query route（`GET /api/incidents/:runId`），以 canonical `runId` 查詢事件/audit/trace/ToolExecution/terminal result 的 redacted 投影，受 X13 auth 保護；與既有 metrics proxy（`GET /api/operations/metrics`）分離。

### frontend（呈現）
- 僅以既有 X19 envelope 驗證 canary 的 frontend-consumable output；不新增 UI 行為。

### docs（operations）
- 以 X12 canonical correlation schema 更新 runbook 與 incident queries。

## 資料流

```text
ExecutionCompositionRoot（單一真實執行路徑，X21 核心交付）：
  trusted identity（X13）
    → canonical ExecutionContext（X12）
    → normalized input（X17）
    → governed context assembly（X18）
    → unified Tool dispatch（X14：validate → authorize → side-effect prepare → dispatch → reconcile）
    → versioned runtime event（X19）
    → persistence（Task/Step + ExecutionManifest）
    → interrupt/checkpoint → recovery（X20）
    → frontend-consumable output + evidence（audit / OTel / no-duplicate / runId 可查）
```

```text
ReadinessGate 執行（CI/manual release）：
  1. 讀取 version-pinned fault-injection dataset + release policy
  2. 靜態 architecture checks（六類 bypass 掃描 + operator override 驗證）
  3. live canary（safe test resource → 呼叫 ExecutionCompositionRoot）
  4. deterministic release gate（X10.2 Part K + negative fault-injection checks）
  5. correlated SLI 結果分離與 tolerance 比對
  任一 fail → gate fail；全部 pass → gate pass
```

## 核心元件

### 1. ExecutionCompositionRoot（核心交付，MJR-01）

X21 的核心新模組是「單一真實執行 composition root」。現有 `canary.ts` 透過 `CanaryDependencies`（9 個 DI 方法）抽象掉真實模組，從未呼叫 X12/X14/X18/X19/X20 的實際實作；因此本 change 先建立一個可被 canary 與 future production path 共用的單一執行入口：

```typescript
interface CanonicalExecutionRequest {
  executionManifest: ExecutionManifest;
  principal: PrincipalContext;              // X13 trusted identity
  input: NormalizedAgentInput;              // X17 normalized input
  scope: RuntimeScope;
}

interface CanonicalExecutionResult {
  runId: string;                            // X12 canonical correlation
  terminal: TerminalStatus;                 // X19 terminal contract
  output: FrontendConsumableOutput;
  evidence: {
    auditRef?: string;
    otelTraceRef?: string;
    duplicateEffectCount: number;
    correlatedSliRef?: string;
  };
}
```

- 組裝順序固定：X12 `readExecutionContext` → X17 normalized input → X18 governed context → X14 unified dispatch → X19 event envelope producer → X20 recovery（interrupt/checkpoint/resume）。
- 唯一寫入者：`ExecutionCompositionRoot` 是該路徑的 composition 邊界；各原語仍由 X12/X14/X18/X19/X20 既有模組負責，X21 不重寫其契約。
- MUST NOT 每個 Agent 各自複製 dispatcher 或 context 組裝路徑；所有 production Agent 一律經此單一入口。
- 依賴的 public entry signature 於 Phase 0 spike 盤點並記錄（見 tasks Phase 0，MNR-01）；若某模組無可 import 的 public entry，Phase 0 fail-closed 並回報，不硬接。

### 2. ReadinessGate composition root

```typescript
interface ReadinessGateInput {
  policyRef: { policyId: string; version: string; digest: string };
  runtimeBuildId: string;
  executionManifest: ExecutionManifest;
  faultInjectionDataset: { datasetId: string; datasetVersion: string };
  canarySpec: { canaryId: string; timeoutMs: number };
}

type ReadinessGateResult =
  | { status: "passed"; evaluatedAt: string; evidence: GateEvidenceRef[] }
  | { status: "failed"; evaluatedAt: string; reasons: GateReasonCode[] }
  | { status: "invalid_policy"; evaluatedAt: string; reasonCode: string };
```

- 組合順序固定：architecture checks → canary → deterministic gate → fault-injection negative checks → correlated SLI tolerance。
- 任一 fail → `failed`；policy/dataset/版本缺失 → `invalid_policy` 並 fail-closed。
- 不新增第二個 gate 平台；release-gate.ts 既有 CLI 成為本 gate 的其中一個 required check。

### 3. canary 擴充至 ExecutionCompositionRoot

- safe resource：`memory_only` effect、read-only Tool、獨立 `canaryId`/nonce、cleanup trace。
- 以 safe test resource 呼叫 `ExecutionCompositionRoot`（而非既有 `CanaryDependencies` 抽象），使 canary 證明整合原語在實際路徑中啟用。
- verify：audit 存在、OTel trace 存在、`duplicateEffectCount === 0`、四類結果 metric 可依 `runId` 查、terminal output 可被 frontend envelope 解析。
- 失敗即標記 deployment unhealthy；記錄 `ExecutionManifest` 與 `runtimeBuildId`。
- 既有 `CanaryDependencies` 抽象保留為 canary 的輸入/輸出契約，但其 default wiring 指向 `ExecutionCompositionRoot`。

### 4. ExecutionManifest 強制與 additive migration（MNR-02）

- 每個 durable Run/Task 建立時 MUST 附 `ExecutionManifest`；缺漏 → fail-closed（不 dispatch、`invalid_policy`）。
- additive migration 機制（明確指定）：
  - 採 **deployment hook**（啟動時）掃描缺 manifest 的 durable Run/Task，以可信 Task/Step/model/tool/cost ledger 重建 manifest；
  - **bounded timeline**：backfill 期限 versioned/configurable（預設 ≤ 24h），超時未補齊即停；
  - **`migration_pending` 狀態**：缺 manifest 的 Run/Task 在補齊前 MUST NOT resume；
  - 資料不足或無法證明完整 → `incompatible` + park（manual recovery），MUST NOT 以空值 resume。
- resume 相容性以 manifest 為權威（compatible／migratable／incompatible），沿用 X10.2 三態與 X20 `ExecutionManifestRef` 相容規則。

### 5. correlated SLI 與結果分離

- 關聯鍵：canonical `runId`（X12）為查詢鍵；`threadId`/`taskId`/`stepId`/`toolCallId` 為次級投影。
- 匯出維度：Run、Task、Step、model、Tool、permission、reconciliation、compensation、context、stream、cost。
- 結果分離為四類獨立 metric family，MUST NOT 改變既有 X10.2 metric 語意：

```typescript
type RunOutcomeMetricClass =
  | "success"
  | "recovered_attempt_error"   // 嘗試失敗但已由 retry/resume/reconcile 恢復
  | "terminal_failure"          // 未恢復、terminal failed/cancelled/timed_out/crashed
  | "user_visible_failure";     // 有結構化 user-visible 錯誤/降級輸出
```

- exposition 只含 low-cardinality 彙總 label；`runId` 進 redacted 查詢索引，MUST NOT 成 exposition label（高基數）。
- SLO threshold versioned/configurable；MUST NOT 在 business logic 寫死。

### 6. version-pinned fault-injection 與 release-gate negative checks

- fault-injection dataset 為 version-pinned fixture（`datasetId` + `datasetVersion`），全部 in-process／memory_only，不觸發外部 mutation。
- deliberate 回歸類別（對應 X21 End-to-End Matrix）：decoder、authorization、side-effect duplicate、recovery、context overflow、event terminal-monotonicity。
- 每筆 fault 預期使 release gate `failed`；gate 若在 fault 下仍 `passed`，代表 gate 失效（negative check 失敗）。
- release gate 保持 X10.2 既有 deterministic-first；negative checks 為 additive，MUST NOT 以 unversioned LLM-judge 作為唯一訊號。

### 7. architecture checks 禁止六類 bypass 與 operator override（MNR-04）

- runtime fail-closed（composition root 註冊/派發時強制）：mutation Tool 無 `side-effect` descriptor → 註冊失敗；production registry 無 authorization 配置 → 初始化失敗；dispatch 無 canonical context → 派發拒絕。
- 靜態 archguard test（沿用 `context-architecture.test.ts` source-scan pattern，擴充為 `architecture-checks.test.ts`）：六類 bypass。
- **operator override 機制**（避免 false-positive 只能停用整個 flag）：
  - config/CLI override（如 `ARCHGUARD_OVERRIDE_ALLOWED=<checkId>:<reasonCode>:<expiry>`）；
  - 每筆 override 附 reason code、audit log；
  - bounded TTL（預設 ≤ 24h 或單一 release），過期自動失效；
  - override 不靜默豁免，audit 可見。

### 8. per-boundary rollback/disable switch（完整停用語意，MJR-02）

每個 integration boundary 有 `runtime-config` feature flag。停用回退至「安全前一行為」，MUST NOT revert DB 歷史；下表明確定義 9 個 boundary 的 flag、預設、停用後行為與連鎖影響：

| Boundary | Flag | 預設 | 停用後安全前一行為 | 連鎖影響 |
|---|---|---|---|---|
| X13 trusted-authorization | `x13.authorization.enabled` | on | **default-deny**：受保護 Tool 一律拒絕，MUST NOT 退成 anonymous allow | X14/X16 dispatch 全部拒絕 |
| X12 canonical-context | `x12.context.enabled` | on | 經 compatibility adapter 映射 legacy BFF correlation headers；身份/correlation 無法建立時 fail-closed，MUST NOT 無 context dispatch | X14/X16 依賴；停用時 context 採 legacy adapter |
| X14 unified-dispatch | `x14.dispatch.enabled` | on | read-only Tool 可退回 per-Agent registry dispatch；mutation Tool MUST 仍經 side-effect ledger/reconciliation（Invariant #4 不隨 flag 停用） | X16 scheduling 對 unified path 失效 |
| X15 bounded-decode | `x15.decode.enabled` | on | 嚴格 `JSON.parse` 無 repair；失敗回 typed `invalid`，MUST NOT 靜默回 `{}` | 影響 X14 Tool argument 解碼 |
| X16 scheduling-resilience | `x16.scheduling.enabled` | on | 保守 serial 執行（ToolNode 預設），無 concurrency；retry/circuit 仍由 X2/X14 強制 | 需 X14 unified path |
| X17 normalized-input | `x17.input.enabled` | on | raw input 直通，但仍需 runtime validation（attachment identity）與 trusted identity，MUST NOT 跳過安全驗證 | X18 仍需 input；clarification/cancel 仍走 interaction policy |
| X18 context-budget | `x18.context.enabled` | on | per-Agent context assembly（非 deprecated last-N，受 archguard 防線），仍受 hard model limit 與 deterministic truncation 約束 | 需 X17 input |
| X19 event-contract | `x19.events.enabled` | on | legacy unversioned adapter（X19 既有 compatibility adapter）；terminal monotonicity 由 state machine 維持，MUST NOT 停用 | 影響 BFF/frontend envelope |
| X20 durable-recovery | `x20.recovery.enabled` | on | 不自動 resume；interrupted Run 一律 park/`manual_intervention_required`，MUST NOT blind replay | X13 confirmation 仍由 decision store 一次性消費 |

- 停用語意統一規則：auth 類 → default-deny；mutation 安全不隨 flag 停用；terminal monotonicity 不隨 flag 停用；不 revert DB 歷史。
- 每筆 switch 記錄 boundary、default、停用後行為、狀態收斂語意（見上表）。

### 9. runbooks 與 incident queries（含新 route，MNR-03）

- 以 X12 canonical correlation schema 更新 `docs/operations/` runbook。
- 區分兩個不同邊界：
  - `GET /api/operations/metrics`（既有 metrics proxy）：Prometheus/OpenMetrics text 透傳，不變。
  - `GET /api/incidents/:runId`（**新增**唯讀 route）：以 canonical `runId` 查詢 event、audit、trace、ToolExecution、terminal result 的 redacted 投影，受 X13 auth 保護，回結構化 JSON（非 metrics text）。

## 替代方案

| 方案 | 結論 |
|---|---|
| 為 gate 建立獨立驗證平台／第二 runtime | ❌ 違反 Invariant #1，composition 即足夠 |
| canary 繼續用 `CanaryDependencies` 抽象不接真實模組 | ❌ 無法證明整合路徑，MJR-01 核心問題 |
| 只靠 LLM-as-a-judge 判定 deploy ready | ❌ 違反 deterministic-first |
| 以 `/health=200` 定義 deploy 成功 | ❌ X10.2 Part L 已否決 |
| 回滾以 revert 資料庫歷史實現 | ❌ 採 feature flag 停用，不 revert DB |
| 直接把 `runId` 當 exposition label | ❌ 高基數，進 redacted 查詢索引而非 label |
| architecture checks 只用 runtime 不做靜態掃描 | ❌ runtime 只擋 dispatch 時點，靜態掃描才能證明 Agent 不 bypass |
| fault-injection 只做正向成功 | ❌ negative checks 才能證明 gate 真正 gate |
| 非 auth boundary 停用後無定義直接放行 | ❌ MJR-02；每 boundary 有明確安全前一行為 |

## 風險

| 風險 | 緩解 |
|---|---|
| ExecutionCompositionRoot 組裝暴露 interface 不相容 | Phase 0 spike 先盤點 public entry signature；缺入口 fail-closed 回報 |
| canary 污染 production path | safe resource、獨立 cleanup、可停用 flag |
| manifest 強制誤殺 legacy Run | additive migration（deployment hook + bounded timeline + migration_pending）；資料不足 park |
| 高基數 label 衝擊 metrics | runId 進 redacted 查詢索引，exposition 只彙總 label |
| archguard false-positive | operator override（reason code + audit + TTL） |
| rollback switch 連鎖影響 | 上表明確定義 9 boundary 停用語意與連鎖影響 |
| fault-injection 誤連外部效應 | 全 in-process fixture、不觸發外部 mutation |

## 驗證策略

- deterministic unit/contract test：`ExecutionCompositionRoot`、`ReadinessGate`、`ExecutionManifest` 強制 + migration、四類結果分離、correlated metrics、rollback switch 停用語意、archguard override。
- 靜態 architecture checks：六類 bypass 各至少一個 scenario，deliberate bypass 使 gate/test fail；override 有 audit 與 TTL。
- integration test：canary 走 `ExecutionCompositionRoot`（含 interrupt/checkpoint/resume），驗證 audit/OTel/no-duplicate/runId 可查。
- fault-injection：六類 deliberate 回歸使 release gate `failed`。
- live spike（視 X11 已知限制）：hosted deployment 的 live canary；無法 live 者標記「未驗證」，MUST NOT 假稱通過。
