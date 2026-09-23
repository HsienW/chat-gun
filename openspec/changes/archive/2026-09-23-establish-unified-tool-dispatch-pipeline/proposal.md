# Proposal：establish-unified-tool-dispatch-pipeline

## 變更摘要

把既有分散的 Tool governance、authorization、retry、Task/Step、side-effect ledger、reconciliation、compensation、audit、tracing 原語，收斂成**一條由 registry 擁有、所有 production Agent 共用的統一 Tool dispatch pipeline**：以單一 composition root 組裝 `ToolExecutionRunner`（side-effect ledger + retry budget + reconciliation + result reference）、X13 的 authorization composition、retry budget、Task/Step adapter、compensation/saga、audit/metric/trace，並以統一 `RuntimeToolDescriptor` 驅動。所有 Chatbot、Math、MCP、Deep Research 的 Tool 呼叫都經同一 dispatcher；mutation Tool 必須在註冊前宣告 stable replay／business-effect identity；新增 architecture test 阻斷任何 production Agent 繞過 dispatcher 直接呼叫受保護 Tool。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X14**，是 Layer 5（Tool Execution Hardening）的第一個 Change。前置 X12（`add-canonical-execution-context`）、X13（`wire-trusted-identity-authorization-hitl`）已 archive：`ExecutionContext` 的 canonical correlation（`readExecutionContext`）、production Tool authorization composition root（`createRuntimeToolAuthorizationComposition`）與 durable confirmation 橋（`createToolAuthorizationGraphNodes`）已就緒，但**這些原語尚未與 `ToolExecutionRunner`（side-effect ledger、retry、reconciliation、compensation、Task/Step、structured result）接成同一條 production dispatch 路徑**。X2（retry budget）、X3（idempotency）、X4（side-effect ledger）已 archive，`ToolExecutionRunner`、`BusinessEffectLedger`、`ResultReferenceStore`、`SideEffectToolDescriptor`、`SagaOrchestrator`、`executeWithRetry` 原語均已存在且有測試，但 production 從未接線。

> 前置約束（X11 Decision Record §決策與 X13 §Durable confirmation）：本 Change 的 durable 語意（replay key、business-effect key、reconciliation、compensation）依賴「Agent Server checkpoint 於 interrupt／resume／restart 間的可恢復性」與「持久化副作用身份的可查性」。凡設計假設依賴這些未經 L（正式部署）驗證的行為，MUST 於 design 標記「基於未驗證假設」，直到後續 Change 取得 L 證據。X14 的驗收以 deterministic test + mock integration 證明契約，live 驗證另列。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時）：

1. **production dispatch 只有 governance wrapper，沒有 ledger／retry／reconciliation／Task/Step／output-schema**：`applyToolGovernance`（`backend/src/platform/tool-governance.ts:697-707`）把每個 Tool 包成 `GovernanceExecutor`（`tool-governance.ts:510-660`），只做 input size limit（非 schema validation，依賴 LangChain 內建）、authorization、timeout／abort、output truncation、audit/metric/Opik span。沒有 retry budget、沒有 side-effect ledger、沒有 reconciliation、沒有 compensation、沒有 Task/Step lifecycle、沒有 output schema validation、沒有 concurrency scheduling、沒有 structured result 版本化。

2. **`ToolExecutionRunner` 已完整組合 ledger + retry + reconciliation + result reference，但 production 從未實例化**：`ToolExecutionRunner`（`backend/src/runtime/side-effect/tool-execution-runner.ts:145-805`）已把 replay key、business-effect identity、ledger prepare/claim/commit、retry budget、reconciliation、result reference、authorization（`authorizeTyped`/`executeAuthorizedTyped`）、audit/metric/span 全部接好。但 grep `new ToolExecutionRunner` 於 production 程式碼零命中，只有 class 定義與 unit test 引用；沒有任何 production caller 把 Tool dispatch 路由進去。

3. **production 存在三條分歧 dispatch 路徑，無一經過 `ToolExecutionRunner`**：
   - Deep Research（`backend/src/agents/deep-researcher.ts:292,678`）：`loadAgentTools` → `toolByName` map → `selectedTool.invoke(input, toolConfig)`（governed wrapper 的 `.invoke`）。
   - Math（`backend/src/agents/math-agent.ts:47`）：直接 `calculatorTool.invoke({ expression })`，import raw tool，**完全繞過 governance／authorization／audit／timeout**。
   - MCP（`backend/src/agents/mcp-agent.ts:30-36`）：`loadAgentToolRuntime` + 手寫 `createToolAuthorizationGraphNodes`，直接呼叫 `authorizeTyped`／`executeAuthorizedTyped`。

4. **沒有統一 `RuntimeToolDescriptor`**：授權用 `ToolRiskPolicy`（`backend/src/runtime/authorization/tool-risk.ts`）、副作用用 `SideEffectToolDescriptor`（`backend/src/runtime/side-effect/side-effect-descriptor.ts:50-56`）、治理用 env 驅動 `ToolPolicy`（`backend/src/platform/tool-governance.ts:35-44`）三者分離，沒有一個 descriptor 同時承載 `inputSchema`／`outputSchema`／`isReadOnly`／`isConcurrencySafe`／`timeoutPolicy`／`retryPolicy`／`interruptBehavior`／`sideEffect`。

5. **mutation Tool 沒有 `SideEffectToolDescriptor`，無法進 ledger**：MCP filesystem 的 `write_file`／`edit_file`／`create_directory`／`move_file` 被宣告為 `riskTier: "sensitive"` + `requireConfirmation: true`（`backend/src/tools/authorization/tool-authorization.ts:80-86`），但**沒有任何 mutation Tool 宣告 `SideEffectToolDescriptor`**（stable replay + business-effect identity）。因此它們只能經 governance wrapper（authz + timeout）dispatch，沒有 business-effect identity、ledger、reconciliation、compensation，違反 X11 Cross-Layer Invariant #4／#5。

6. **retry 未接 dispatch**：production governance 不傳任何 `retryBudget`；`ToolExecutionRunner` 雖可使用 `RetryBudget`（`backend/src/runtime/retry/retry-budget.ts`）但未被 production 呼叫。`executeWithRetry`（`backend/src/runtime/retry/retry-executor.ts:91`）是 Task/Step-aware 的 retry loop，也未接上 Tool dispatch。

7. **Task/Step lifecycle 未接 dispatch**：`runtime/state-machine.ts`、task/step repositories 與 events 存在，但每個 Tool call 的 dispatch 前後沒有啟動／完成對應 Task/Step，Tool 結果不進 Task/Step event。

8. **compensation 未接 dispatch**：`SagaOrchestratorImpl`（`backend/src/runtime/compensation/saga-orchestrator.ts`）與 `CompensationRegistryImpl`（`compensation-registry.ts`）存在，但沒有 production composition 把它接進 Tool dispatch 的 ambiguous／compensation 分支。

9. **沒有 structured result 版本化，且 legacy string 是唯一的 presentation 相容層**：`GovernedToolOutcome.succeeded` 只回傳 raw result（僅 truncation），非 success 一律 downgrade 成 legacy error string（`legacyErrorForOutcome`，`backend/src/platform/tool-governance.ts:359-381`）；沒有 versioned structured tool result，沒有 output schema validation。

綜合而言，X2/X3/X4/X13 的原語「各自存在且測試通過」，但 production 的實際 dispatch 路徑**是 governance wrapper 的簡化版，另一條完整的 `ToolExecutionRunner` 卻完全未接線**，且 Math 更有一條完全繞過治理的裸呼叫。這正是 X14 issue「Compose the existing … primitives into one registry-owned execution path」與 Evidence Baseline「side-effect and retry runtimes are not the mandatory dispatch path」的根因，也違反 AGENTS.md「不得以 Prompt／固定分支掩蓋不存在的 Tool／權限能力」與 X11 Invariant #4（「Mutation Tools never bypass authorization, durable effect identity, reconciliation, audit, or cancellation policy」）。

## 解決方案

以「單一 registry + 單一 dispatcher + 單一 `RuntimeToolDescriptor` + 強制 architecture test」收斂：

1. **建立統一 `RuntimeToolDescriptor<TInput, TOutput>`**：一個 descriptor 承載 `toolName`、`toolVersion`、`inputSchema`、`outputSchema`、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior` 與 `sideEffect?`（`SideEffectToolDescriptor`）；由單一 registry 組裝點供給，MUST NOT 散落於各 Tool，亦不得以 Tool 名稱硬編碼 policy。

2. **建立單一 composition root**：新增 factory（例如 `createRuntimeToolDispatchPipeline(...)`）組裝：descriptor registry、`ToolExecutionRunner`（`BusinessEffectLedger` + `ResultReferenceStore`）、X13 authorization composition（`ToolRiskRegistry`/`AuthorizationEngine`/`DecisionStore`/`confirmationStore`）、retry budget factory、Task/Step adapter、`SagaOrchestrator`／`CompensationRegistry`、audit/metric/trace；產出所有 Agent 共用的 dispatcher。

3. **所有 Agent 經同一 dispatcher**：Chatbot、Math、MCP、Deep Research 的 Tool 呼叫都改經 pipeline；Math 的 raw `calculatorTool.invoke` 與 Deep Research 的 `selectedTool.invoke` 必須改接 pipeline，MCP 的手寫 authorization graph 改由 pipeline-owned dispatch（或其 graph-node adapter）承接，不保留每 Agent 一份 dispatch 邏輯。

4. **read-only 走 typed executor（無 ledger），mutation 必須宣告 side-effect descriptor**：read-only Tool 可經 typed executor 直接執行；mutation Tool MUST 在註冊成功前宣告 stable replay key + business-effect identity（`SideEffectToolDescriptor`），否則 registration fail-closed（deny）。目前無 descriptor 的 MCP write tools 必須補 descriptor 或於 registration 被拒。

5. **replay／business-effect 語意強制**：同一 replay key 重放複用相容結果而不 redispatch；同一 business-effect key 即使 request-dedup 過期也不得 commit 兩次（idempotency）。

6. **ambiguous → reconcile → 才可 retry**：dispatch 後 timeout／斷線回傳 `ambiguous_after_dispatch`，必須先 reconcile（`SideEffectReconciler`）判定 committed／not_committed／unknown，再依 retry budget 與 reconciliation 結果決定 retry／park；MUST NOT blind retry。

7. **versioned structured tool result**：typed execution outcome 轉成 versioned structured tool result；legacy string 只作為 presentation 相容層，不得承擔機讀語意。Tool result 於 model feedback、Task event、frontend fallback 與 audit 全程維持 structured。

8. **output-schema validation 與 committed-effect 分離**：output 通過 `outputSchema` 才回 `succeeded`；若 output-schema 失敗但 effect 已 commit，MUST 先 persist effect truth（ledger committed + result reference），再分開 park／repair result，不得抹除 execution outcome。

9. **mandatory dependency unavailable → fail-closed**：ledger、authorization、retry、Task/Step、audit 等 mandatory dependency 於 dispatch 前 unavailable 時 fail-closed（deny/defer，不 dispatch）；audit／telemetry exporter 失敗不得抹除已發生 outcome，本地 durable audit policy 決定 protected dispatch 是否可續行。

10. **architecture test 阻斷繞過**：新增 architecture test，當任何 production Agent import 或 invoke 受保護 Tool 卻未經 dispatcher 時 fail；並涵蓋「mutation Tool 無 side-effect descriptor」「production registry 無 authorization」「unversioned runtime event producer」等 X21 前置檢查。

## 受影響範圍

### 受影響套件

- `backend`（本 Change 唯一套件）：統一 `RuntimeToolDescriptor`、composition root、`ToolExecutionRunner` 接線、Agent dispatch 路徑遷移、structured tool result、output-schema validation、architecture test。

### 受影響能力域

- Tool dispatch（統一 pipeline）。
- Side-effect／replay／business-effect identity（ledger 接線）。
- Retry budget 與 reconciliation（ambiguous → reconcile → retry）。
- Compensation／manual parking。
- Task/Step lifecycle 與 events。
- Structured tool result 版本化。
- Tool registry 與 Agent 組裝。

### 既有能力原語（本 Change 接線、不重造）

- `ToolExecutionRunner`／`BusinessEffectLedger`／`ResultReferenceStore`／`SideEffectToolDescriptor`／`SideEffectReconciler`／`createReplayKey`／`hashBusinessEffectKey`（`add-side-effect-tool-execution-runtime`，X4）。
- `RetryBudget`／`checkBudget`／`recordAttempt`／`executeWithRetry`（`add-agent-retry-budget`，X2）。
- idempotency guard／key（`add-agent-idempotency-audit`，X3）。
- `ToolRiskRegistry`／`AuthorizationEngine`／`DecisionStore`／`ConfirmationStore`／`createRuntimeToolAuthorizationComposition`（X13）。
- `SagaOrchestrator`／`CompensationRegistry`（`add-agent-compensation-runtime`）。
- Task/Step `state-machine`、repositories、events（`add-agent-task-state-machine`）。
- `ExecutionContext`／`readExecutionContext`（X12）。
- `applyToolGovernance`／`GovernedToolExecutor`／`GovernedToolOutcome`（`platform/tool-governance.ts`，本 Change 的接線與遷移對象）。

## 目標

- 所有 production Agent Tool 經 unified registry 被發現。
- 一條 registry-owned dispatch pipeline 成為所有 Agent 的強制路徑；無 per-Agent 重複 dispatcher。
- mutation Tool 未宣告 side-effect／reconciliation 語意不得註冊成功。
- 同一 replay key 重放複用相容結果，不 redispatch。
- 同一 business-effect key 即使 request-dedup 過期也不 commit 兩次。
- ambiguous timeout 於任何 retry 前 reconcile。
- Tool result 於 model feedback、Task events、frontend fallback、audit 全程維持 structured。
- architecture test 阻斷直接 protected Tool invocation。
- 既有 Weather、Web、Calculator、MCP 行為保持相容。

## 非目標

- ❌ 不以 Tool-name switch statement 作為主要 policy 機制。
- ❌ 不建立每 Agent 一份 dispatcher；只有一條 registry-owned pipeline。
- ❌ 不宣稱 distributed exactly-once；以 durable identity、idempotency、reconciliation 達成語意。
- ❌ 不在本 Change 建立 X15 的 bounded typed JSON decode（provider envelope 與 Tool argument 的 `JsonDecodeResult`）；本 Change 只在 pipeline 保留 decode 接縫並接既有 input schema validation，詳細 decode hardening 屬 X15。
- ❌ 不在本 Change 建立 X16 的 descriptor-driven rate-limit／circuit-breaker／Retry-After 完整政策；本 Change 的 concurrency scheduling 只做結構層（mutation／unknown serial、read-only 依 `isConcurrencySafe` 分類），詳細 resilience policy 屬 X16。
- ❌ 不變更既有 Graph ID、公開 BFF route 或既有 error-code 語意。
- ❌ 不在本 Change 完成 X20 的完整 crash-safe recovery 與 resume sanitization。
- ❌ 不新增 user-facing authorization approval UI（沿用 X13 的 trusted operator／integration harness 驗收契約）。
- ❌ 不變更正式 Agent Server PG／Redis 持久化行為；相關 durable 假設標記「基於未驗證假設」。

## 風險

| 風險 | 緩解 |
|---|---|
| 統一 pipeline 接線後既有 Agent 行為回歸（Weather／Web／Calculator／MCP） | 以現有 golden eval／mock smoke／live smoke 回歸；分階段遷移，先 read-only 後 mutation；保留 legacy string presentation 相容層 |
| `ToolExecutionRunner` 強制 ledger 後，read-only 誤入 ledger 造成延遲／依賴 | read-only 走 typed executor（無 ledger）；僅 mutation 進 ledger；以 test 證明分派正確 |
| mutation Tool 補 descriptor 時 business-effect key 定義不穩定 | `deriveBusinessEffectKey` 由 descriptor 單一來源，stable replay/business-effect identity；缺 descriptor 註冊 fail-closed |
| ambiguous timeout 誤判為可 blind retry 造成重複副作用 | reconcile-first 強制：`ambiguous_after_dispatch` 必先 reconcile，retry 只接 `not_committed` 或 external idempotency guarantee |
| 持久化依賴（ledger/result-store/decision-store）unavailable 被誤當放行 | dispatch 前 mandatory dependency fail-closed；fault-injection test |
| 三條既有 dispatch 路徑遷移時漏接 | architecture test 以 import/invoke 靜態＋測試攔截直接 protected Tool invocation |
| structured result 版本化與 legacy string 相容的契約漂移 | versioned envelope 單一來源；contract fixture；frontend fallback 只讀 structured，不依 legacy string 反推 |
| Agent Server checkpoint／restart 對 durable replay/reconciliation 的影響未經 L 驗證 | 依 X11 約束標記「基於未驗證假設」；deterministic + mock 證明契約，live 另列 |

## 回滾策略

本 Change 為「接線 + 遷移」型變更：統一 dispatcher 為 additive composition root，可經 feature flag／profile 停用回到既有「governance wrapper 直接 dispatch」行為；`RuntimeToolDescriptor` 為 descriptor 層新增，不變更既有 `ToolRiskPolicy`／`SideEffectToolDescriptor` 型別語意；Math 的裸呼叫改接 pipeline 是收斂既有漏接，不改變計算語意。若實作驗證失敗，可逐 Agent、逐 descriptor 回退，不影響既有系統行為，亦不回退資料庫 schema 歷史（ledger／decision／result-reference 表格早已存在）。
