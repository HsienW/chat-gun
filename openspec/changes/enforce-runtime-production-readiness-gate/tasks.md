# Tasks: enforce-runtime-production-readiness-gate

> 對應 `second-stage-plan-en-v4.md` X21（Layer 7 Durable Recovery and Production Gate，Dependencies: X10.2、X11–X20）。每個 Task 只有在實作完成、測試新增、驗證實際執行通過後才勾選 `- [x]`。驗證命令沿用根 `AGENTS.md` §10。T0 為 hard gate：確認 X11–X20 已 archive、canary 目前未走真實 composition root，且 X12/X14/X18/X19/X20 的 public entry 可被 import 組裝；任一未確認即停止並回報。

## Phase 0：前置確認（hard gate）

### Task 0.1：確認依賴已 archive 且關鍵 interface 可組裝

- [x] 確認 X10.2、X11–X20 對應 change 已 archive（`openspec/changes/archive/`）
- [x] 唯讀盤點 `backend/src/operations/`（canary.ts、manifest.ts、release-gate.ts、metrics/、quality-gate.ts、drain.ts、recovery/）與 X12/X14/X18/X19/X20 既有模組
- [x] 記錄 canary 目前未走真實 composition root 的證據（`CanaryDependencies` 9 個 DI 方法未呼叫真實模組）
- [x] 確認 X12 execution-context、X14 tool-dispatch pipeline、X18 context assembly、X19 event envelope schema、X20 recovery sanitizer 的 public entry **可被 import**，記錄其 signature 至 change evidence；任一缺入口 → fail-closed 回報，不硬接

**驗證：** `cd backend && ls src/operations/`；盤點 script 記錄各 module public entry signature；缺入口即停止。

---

## Phase 1：建立 ExecutionCompositionRoot（核心交付，MJR-01）

### Task 1.1：定義 CanonicalExecutionRequest/Result 型別與 runtime validation

- [x] 定義 `CanonicalExecutionRequest`（`executionManifest`、`principal`、`input`、`scope`）與 `CanonicalExecutionResult`（`runId`、`terminal`、`output`、`evidence`）
- [x] 以 strict runtime schema（Zod）驗證輸入，缺欄位 fail-closed
- [x] 測試：schema 驗證、缺欄位 fail-closed

**驗證：** `cd backend && npx vitest run src/operations/execution-composition-root.test.ts`

### Task 1.2：接線 X12/X17/X18 執行上下文與輸入

- [x] 接線 X12 `readExecutionContext`（trusted principal + `runId`）→ X17 normalized input → X18 governed context
- [x] 依 Phase 0 盤點結果組裝，MUST NOT 重寫既有模組契約
- [x] 測試：context 建立、normalized input 驗證、governed context 組裝

**驗證：** `cd backend && npx vitest run src/operations/execution-composition-root.test.ts`

### Task 1.3：接線 X14 unified dispatch 與 X19/X20

- [x] 接線 X14 unified dispatch（validate → authorize → side-effect prepare → dispatch → reconcile）→ X19 event envelope producer → X20 recovery（interrupt/checkpoint/resume）
- [x] mutation Tool MUST 經 side-effect ledger/reconciliation；read-only Tool 走 typed executor
- [x] 測試：dispatch 接線、event envelope 產生、recovery 接線

**驗證：** `cd backend && npx vitest run src/operations/execution-composition-root.test.ts`

### Task 1.4：組裝單一 execute() 入口

- [x] 建立 `backend/src/operations/execution-composition-root.ts`，暴露單一 `execute()` 入口
- [x] 組裝順序固定：X12→X17→X18→X14→X19→X20；輸出 frontend-consumable output + evidence
- [x] MUST NOT 每個 Agent 各自複製 dispatcher/context 組裝路徑
- [x] contract test：完整路徑以 safe test resource 走通，evidence 含 audit/OTel/no-duplicate/runId

**驗證：** `cd backend && npx vitest run src/operations/execution-composition-root.test.ts`

---

## Phase 2：ReadinessGate composition root（backend）

### Task 2.1：建立 ReadinessGate 型別與 composition root

- [x] 定義 `ReadinessGateInput`／`ReadinessGateResult`（`passed`／`failed`／`invalid_policy`）與 `GateReasonCode`
- [x] 建立 `backend/src/operations/readiness-gate.ts`，固定組合：architecture checks → canary → deterministic gate → fault-injection negative checks → correlated SLI tolerance
- [x] 任一 fail → `failed`；policy/dataset/版本缺失 → `invalid_policy` 並 fail-closed；release-gate.ts 既有 CLI 成為 required check
- [x] 測試：各組合項 fail → gate fail；缺失 policy → invalid_policy；子項 fail 不回傳 passed

**驗證：** `cd backend && npx vitest run src/operations/readiness-gate.test.ts`

---

## Phase 3：ExecutionManifest 強制與 migration（backend，MNR-02）

### Task 3.1：強制 manifest 於 Run/Task 建立時

- [x] 每個 durable Run/Task 建立時 MUST 附 `ExecutionManifest`；缺漏 fail-closed（不 dispatch、`invalid_policy`）
- [x] resume 相容性以 manifest 為權威（compatible／migratable／incompatible）
- [x] 測試：缺 manifest fail-closed、compatible resume、incompatible park

**驗證：** `cd backend && npx vitest run src/operations/manifest.test.ts`

### Task 3.2：additive migration 機制（deployment hook + bounded timeline）

- [x] 建立 deployment hook：啟動時掃描缺 manifest 的 durable Run/Task，以可信 ledger 重建 manifest
- [x] bounded timeline：backfill 期限 versioned/configurable（預設 ≤ 24h），超時停
- [x] `migration_pending` 狀態：缺 manifest 的 Run/Task 補齊前 MUST NOT resume
- [x] 資料不足/無法證明完整 → `incompatible` + park，MUST NOT 空值 resume
- [x] 測試：migration_pending 不 resume、超時停、資料不足 park

**驗證：** `cd backend && npx vitest run src/operations/manifest.test.ts`

---

## Phase 4：correlated SLI、結果分離與 incident query（backend + bff，MNR-03）

### Task 4.1：以 canonical runId 關聯 SLI（backend）

- [x] 擴充 `metrics/export.ts`：以 X12 `runId` 為查詢鍵關聯 Run/Task/Step/model/Tool/permission/reconciliation/compensation/context/stream/cost
- [x] `runId` 進 redacted 查詢索引，MUST NOT 成 exposition label
- [x] 測試：依 runId 可查完整執行鏈；exposition 不含高基數 runId label

**驗證：** `cd backend && npx vitest run src/operations/metrics/export.test.ts`

### Task 4.2：執行結果四類分離（backend）

- [x] 定義 `RunOutcomeMetricClass`（success／recovered_attempt_error／terminal_failure／user_visible_failure）
- [x] 四類以新增獨立 metric family 表示，MUST NOT 改變既有 X10.2 metric 語意
- [x] 測試：retry/resume 恢復 → recovered_attempt_error；未恢復 → terminal_failure；結構化降級 → user_visible_failure

**驗證：** `cd backend && npx vitest run src/operations/metrics/export.test.ts`

### Task 4.3：correlated metrics 透傳與 incident query route（bff）

- [x] correlated metrics 關聯鍵透傳（沿用 X13 trusted identity、X19 透傳），不做語意改寫
- [x] 新增唯讀 route `GET /api/incidents/:runId`：以 canonical `runId` 查詢 event/audit/trace/ToolExecution/terminal result 的 redacted 投影，受 X13 auth 保護，回結構化 JSON
- [x] 既有 `GET /api/operations/metrics`（Prometheus/OpenMetrics 透傳）不變
- [x] 測試：授權通過可查、未授權 deny、`/incidents/:runId` 與 metrics proxy 分離

**驗證：** `cd bff && npx vitest run src/metrics-proxy.test.ts`（若無既有 test script，補測試入口）

---

## Phase 5：version-pinned fault-injection 與 release gate（backend）

### Task 5.1：建立 fault-injection dataset

- [x] 建立 version-pinned fault-injection fixture（`datasetId` + `datasetVersion`），全 in-process/memory_only，不觸發外部 mutation
- [x] deliberate 回歸類別：decoder、authorization、side-effect duplicate、recovery、context overflow、event terminal-monotonicity
- [x] 測試：每筆 fault 預期使 release gate `failed`；gate 在 fault 下仍 passed 視為 negative check 失敗

**驗證：** `cd backend && npx vitest run src/operations/fault-injection.test.ts`

### Task 5.2：release-gate negative checks 擴充

- [x] release gate 保持 X10.2 deterministic-first；negative checks 為 additive
- [x] MUST NOT 以 unversioned LLM-judge 作為唯一訊號
- [x] 測試：deliberate 六類回歸 → gate fail；正常 fixture → gate 不誤 fail

**驗證：** gate script 實際執行；deliberate regression fail the gate。

---

## Phase 6：architecture checks 與 operator override（backend，MNR-04）

### Task 6.1：runtime fail-closed 強制

- [x] mutation Tool 無 `side-effect` descriptor → 註冊失敗
- [x] production registry 無 authorization 配置 → 初始化失敗
- [x] dispatch 無 canonical context → 派發拒絕
- [x] 測試：三類 runtime bypass 皆 fail-closed

**驗證：** `cd backend && npx vitest run src/operations/architecture-checks.test.ts`

### Task 6.2：靜態 archguard test 與 operator override

- [x] 建立 `backend/src/operations/architecture-checks.test.ts`（沿用 `context-architecture.test.ts` source-scan pattern），覆蓋六類 bypass
- [x] 建立 operator override：config/CLI override（`ARCHGUARD_OVERRIDE_ALLOWED=<checkId>:<reasonCode>:<expiry>`）、reason code、audit log、bounded TTL（預設 ≤ 24h）
- [x] override 不靜默豁免，audit 可見，TTL 過期自動失效
- [x] 測試：deliberate bypass 使 test 失敗；正常 production code 不誤擋；override 有 audit 且 TTL 過期失效

**驗證：** `cd backend && npx vitest run src/operations/architecture-checks.test.ts`

---

## Phase 7：per-boundary rollback/disable switch（backend + bff，MJR-02）

### Task 7.1：建立 rollback switch 契約（完整停用語意）

- [x] 每個 integration boundary（X12/X13/X14/X15/X16/X17/X18/X19/X20）新增 `runtime-config` feature flag
- [x] 依 design §8 表實作停用語意：auth → default-deny；mutation 安全不隨 flag 停用；terminal monotonicity 不隨 flag 停用；不 revert DB 歷史
- [x] 每筆 switch 記錄 boundary、default（production=on）、停用後行為、狀態收斂語意、連鎖影響
- [x] 測試：各 switch 停用後回退安全前一行為、不 revert DB 歷史、auth 停用仍 deny、mutation 停用 X14 仍走 ledger/reconciliation

**驗證：** `cd backend && npx vitest run src/platform/runtime-config.test.ts`（或既有 runtime-config test 擴充）

---

## Phase 8：canary 擴充至 ExecutionCompositionRoot（backend）

### Task 8.1：canary 走 ExecutionCompositionRoot

- [x] 以 safe test resource 呼叫 Phase 1 的 `ExecutionCompositionRoot`（取代既有 `CanaryDependencies` 的 default wiring 指向）
- [x] verify：audit、OTel trace、`duplicateEffectCount === 0`、四類結果 metric 依 runId 可查、terminal output 可被 frontend envelope 解析
- [x] 失敗標記 deployment unhealthy；記錄 `ExecutionManifest` 與 `runtimeBuildId`
- [x] 測試：canary 成功路徑、duplicate effect 偵測、失敗標記 unhealthy

**驗證：** `cd backend && npx vitest run src/operations/canary.test.ts`

---

## Phase 9：operations runbooks 與 incident queries（docs + bff）

### Task 9.1：以 canonical correlation 更新 runbook

- [x] 更新 `docs/operations/` runbook，以 X12 canonical correlation schema 改寫 incident queries
- [x] incident query 以 canonical `runId` 一次定位 event、audit、trace、ToolExecution、terminal result（對應 `GET /api/incidents/:runId`）
- [x] 每個 parked/manual 狀態的 operator 動作維持可查

**驗證：** runbook 存在且 incident queries 涵蓋 canonical `runId` 關聯與 `GET /api/incidents/:runId`。

---

## Phase 10：全量驗證（backend + bff + frontend）

### Task 10.1：barrel export 與全量驗證

- [x] 擴充 `backend/src/operations/index.ts` barrel export
- [x] 驗證不修改 X10.2–X20 既有 module 契約
- [x] 驗證不新增第二 queue/worker/scheduler
- [x] `cd backend && npm run lint` 通過
- [x] `cd backend && npm run test` 通過（含既有 operations/runtime/platform 回歸）
- [x] `cd backend && npm run build` 通過
- [x] `cd bff && npm run build` 通過
- [x] `cd frontend && npm run lint && npm run test && npm run build` 通過
- [x] 驗證無不必要 `any`；封閉列舉有單一來源與未知值處理
- [x] `openspec validate enforce-runtime-production-readiness-gate --strict` 通過
- [x] 如實標記未驗證項目（hosted live canary 受限者標「未驗證」）（本工作區未提供 hosted deployment／credential，已如實標記「未驗證」；未宣稱 live 通過）

**驗證：** Backend lint/test/build、bff build、frontend lint/test/build 通過；OpenSpec strict validation 0 issues。
