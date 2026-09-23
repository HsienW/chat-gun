# Design：establish-unified-tool-dispatch-pipeline

## 定位

本 Change 是 **backend-only 的接線 + 收斂型變更**：核心是「一個 `RuntimeToolDescriptor` 單一事實來源 + 一個 registry-owned composition root + 一條所有 Agent 共用的 dispatch pipeline」，把既有 `ToolExecutionRunner`（side-effect ledger + retry + reconciliation + result reference）從 unit-test-only 接到 production 強制路徑，並把三條分歧 dispatch 路徑收斂為一條。實作以 additive 組裝 + 分階段遷移為主，不做破壞性遷移。frontend／bff 本 Change 無程式碼變更。

## 現況盤點（已驗證的事實）

| 事實 | 位置 | 對本設計的意義 |
|---|---|---|
| production dispatch = governance wrapper，無 ledger/retry/reconciliation/Task-Step/output-schema | `backend/src/platform/tool-governance.ts:510-707` | 既有 wrapper 是注入點，需接上完整 pipeline |
| `ToolExecutionRunner` 已完整組合但 production 零實例化 | `backend/src/runtime/side-effect/tool-execution-runner.ts:145-805` | 本 Change 的強制 dispatch 核心，不重造 |
| `SideEffectToolDescriptor` 已定義 `deriveBusinessEffectKey`/`reconcile`/`resultReferencePolicy` | `backend/src/runtime/side-effect/side-effect-descriptor.ts:50-56` | mutation 註冊門檻 |
| `BusinessEffectLedger`／`ResultReferenceStore` 已存在（PG 實作） | `backend/src/runtime/side-effect/business-effect-ledger.ts`、`result-reference-store.ts` | composition root 組裝對象 |
| `RetryBudget`／`checkBudget`／`recordAttempt` 已存在 | `backend/src/runtime/retry/retry-budget.ts` | retry 階段的 policy 輸入 |
| `executeWithRetry` 是 Task/Step-aware retry loop | `backend/src/runtime/retry/retry-executor.ts:91` | Task/Step 接線基礎，視需要由 pipeline 調用 |
| `SagaOrchestrator`／`CompensationRegistry` 已存在未接線 | `backend/src/runtime/compensation/*` | compensation/manual-parking 分支 |
| Task/Step state machine、repositories、events 已存在 | `backend/src/runtime/state-machine.ts`、`persistence/task-repository.ts`、`step-repository.ts` | Task/Step Start 階段的接線對象 |
| X13 authorization composition 已就緒 | `backend/src/tools/authorization/tool-authorization.ts:248-280` | authorization 階段的接線對象 |
| 三條分歧 dispatch 路徑 | `agents/deep-researcher.ts:292,678`、`agents/math-agent.ts:47`、`agents/mcp-agent.ts:30-36` | 收斂遷移對象 |
| mutation Tool（MCP filesystem write）無 `SideEffectToolDescriptor` | `backend/src/tools/authorization/tool-authorization.ts:80-86` | 補 descriptor 或註冊 fail-closed |
| 無統一 descriptor，三種 policy 分離 | `tool-risk.ts`、`side-effect-descriptor.ts`、`tool-governance.ts:35-44` | 建立 `RuntimeToolDescriptor` 統一起來 |

## Pipeline 契約

### 統一 RuntimeToolDescriptor

以單一 registry-owned descriptor 取代三種分散 policy 作為 dispatch 的單一事實來源：

```typescript
interface RuntimeToolDescriptor<TInput, TOutput> {
  toolName: string;
  toolVersion: string;
  inputSchema: RuntimeSchema<TInput>;
  outputSchema: RuntimeSchema<TOutput>;
  riskTier: ToolRiskTier;
  isReadOnly: boolean;
  isConcurrencySafe(input: TInput): boolean;
  timeoutPolicy: TimeoutPolicy;
  retryPolicy: RetryPolicy;
  interruptBehavior: "cancel_safe" | "finish_current" | "reconcile_first";
  sideEffect?: SideEffectToolDescriptor<TInput, TOutput>;
}
```

- `inputSchema`／`outputSchema` 承接既有 Tool 的 Zod schema；input validation 由 pipeline 在 dispatch 前執行，output validation 在 dispatch 後執行，取代「依賴 LangChain 內建 + 只 truncate output」的現況。
- `riskTier` 對映既有 `ToolRiskPolicy.riskTier`，不新增 business 分支；`isReadOnly` 決定是否進 ledger；`isConcurrencySafe` 承接 X16 的 scheduling 分類點（本 Change 只做結構層，見下）。
- `timeoutPolicy`／`retryPolicy` 取代 env 驅動 `ToolPolicy` 的分散來源，改由 descriptor 單一來源；既有 `TOOL_*` env 仍作為 descriptor 組裝時的預設來源，不變更既有 env 語意。
- `interruptBehavior` 定義 cancel 時的語意（`cancel_safe`／`finish_current`／`reconcile_first`），避免以 Tool 名稱或字串反推。
- `sideEffect?`：read-only 為 `undefined`；mutation 必須提供，否則註冊 fail-closed。

### 單一 composition root

新增 factory（例如 `createRuntimeToolDispatchPipeline(...)`）回傳 dispatcher，組裝：

- `descriptorRegistry`：收集所有 production Tool 的 `RuntimeToolDescriptor`，含 local（calculator/weather/weatherForecast/web-fetch/web-search）與 MCP（filesystem/brave_search）工具。
- `toolExecutionRunner`：`new ToolExecutionRunner(PgBusinessEffectLedger, PgResultReferenceStore, observability)`。
- `authorization`：X13 `createRuntimeToolAuthorizationComposition()` 產出的 `ToolAuthorizationGovernanceConfig` 與 `confirmationStore`。
- `retryBudgetFactory`：依 descriptor `retryPolicy` 建立 `RetryBudget`。
- `taskStepAdapter`：Task/Step start/complete 與 event 發射。
- `compensation`：`SagaOrchestrator`／`CompensationRegistry` 供 ambiguous／parking 分支使用。
- `observability`：audit、metric、span。

composition root MUST 於 dispatch 前驗證所有 mandatory dependency 存在；缺任一 dependency 即 fail-closed，不得以空值降級。

### 強制 dispatch 路徑（所有 Agent 共用）

```text
Tool Call Decode（pipeline 接縫，X15 填 detailed decode）
  → Input Schema Validation（inputSchema，先於 authorization）
  → Runtime Tool Descriptor Resolution（registry 單一來源；未註冊 → deny）
  → Authorization / Durable HITL（X13 composition；deny/confirm/unavailable 不 dispatch）
  → Concurrency Scheduling（結構層：mutation/unknown → serial；read-only → isConcurrencySafe 分類）
  → Task/Step Start（taskStepAdapter，emit event）
  → Side-effect Prepare（mutation only；ledger prepare/claim + replay/business-effect identity）
  → Retry Budget（retryBudgetFactory；deny/cancel/reject 不進 retry）
  → Tool Dispatch（executor，timeout/abort）
  → Output Schema Validation（outputSchema；失敗且已 commit → persist effect truth + park/repair）
  → Reconciliation when ambiguous（SideEffectReconciler；committed/not_committed/unknown）
  → Compensation / Manual Parking（compensation 分支）
  → Structured Tool Result（versioned envelope）
  → Task Event + Audit + Trace
```

- 各階段由 pipeline 依 descriptor 驅動，不以 Tool 名稱 switch。
- 每一階段為可獨立測試的純函式／port；pipeline 只是組合它們，不重新實作。

### 收斂三條分歧路徑

- **Math**：`math-agent.ts:47` 的 `calculatorTool.invoke({expression})` 改經 pipeline dispatcher（read-only 分支），移除 raw import 呼叫。
- **Deep Research**：`deep-researcher.ts:678` 的 `selectedTool.invoke(input, toolConfig)` 改經 pipeline dispatcher。
- **MCP**：`mcp-agent.ts:30-36` 的手寫 `createToolAuthorizationGraphNodes` 改由 pipeline-owned dispatch 承接，或保留 graph-node 結構但節點內部改呼叫 pipeline dispatcher（單一 execute 入口），不保留與 dispatcher 並行的第二套 dispatch 邏輯。

### Read-only vs mutation

- read-only Tool：`sideEffect` 為 `undefined`，pipeline 走 typed executor（`executeTyped`），無 ledger、無 replay/business-effect identity。
- mutation Tool：`sideEffect` 必填，pipeline 走 `ToolExecutionRunner.execute`（ledger prepare/claim/commit + reconciliation + result reference）。
- 註冊時驗證：mutation 缺 descriptor 或 descriptor 與 identity 不符 → 註冊 fail-closed（deny）。

### Structured tool result 版本化

- 新增 versioned structured tool result envelope（`schemaVersion` + stable kind + correlation + payload），取代「raw result + legacy error string」。
- `GovernedToolOutcome.succeeded` 的 raw result 先過 `outputSchema`，再包進 envelope；非 success 一律以 typed outcome 進入 envelope，legacy string 僅由 presentation adapter 產生（frontend fallback／舊 client 相容），不承擔機讀語意。
- Tool result 於 model feedback、Task event、frontend fallback、audit 全程維持 structured，不得以 legacy string 反推狀態。

### 失敗語意

- mandatory dependency（ledger／authorization／retry／Task-Step）於 dispatch 前 unavailable → fail-closed（deny/defer，不 dispatch）。
- dispatch 後 timeout／斷線 → `ambiguous_after_dispatch` → reconcile（`SideEffectReconciler`）判定 committed／not_committed／unknown → 依 retry budget 與 reconciliation 決定 retry／park；MUST NOT blind retry。
- output-schema 失敗且 effect 已 commit → persist effect truth（ledger committed + result reference），result 分開 park/repair；不得抹除 outcome。
- audit／telemetry exporter 失敗 → 不抹除 outcome；本地 durable audit policy 決定 protected dispatch 是否可續行。
- authorization deny／user cancel／business reject／invalid schema／unknown side-effect state → 不進 retry。

### Concurrency scheduling（本 Change 的結構層範圍）

- 依 descriptor `isConcurrencySafe` 與 `isReadOnly` 分類：mutation／unknown → serial；read-only 且 `isConcurrencySafe(input)` → 可 bounded concurrent（上限由 config 提供）。
- 分類拋錯或 input validation 失敗 → conservative serial/no-dispatch，不得提升 concurrency。
- 本 Change 不實作 rate-limit／circuit-breaker／`Retry-After` 完整政策（X16）；僅保留 scheduling 階段的結構與分類點。

## 分層設計

### backend

1. 新增 `RuntimeToolDescriptor` 型別與 registry 組裝點；local tools 依既有 schema／risk 補 descriptor，MCP tools 依 versioned server config 補 descriptor（含 mutation write tools 的 `SideEffectToolDescriptor`）。
2. 新增 `createRuntimeToolDispatchPipeline` composition root，組裝 `ToolExecutionRunner`、X13 authorization、retry budget、Task/Step adapter、compensation、observability。
3. 改 `registry.ts`／`mcp-loader.ts` 產出 descriptor registry 並注入 pipeline；改 `deep-researcher.ts`／`math-agent.ts`／`mcp-agent.ts` 改經 pipeline dispatcher。
4. 新增 versioned structured tool result envelope 與 presentation adapter（legacy string）。
5. 新增 architecture test：production Agent 直接 invoke 受保護 Tool 必須失敗；mutation Tool 缺 side-effect descriptor 不得註冊；production registry 無 authorization 不得 dispatch。

### bff

- 無變更。既有 `/api/langgraph/*` proxy 原樣透傳 tool result 與事件；structured result envelope 為 additive，舊 client 經 presentation adapter 降級，BFF 不解析或重寫 domain payload。

### frontend

- 無變更。frontend 已能承接 unknown 事件與 tool result fallback；structured envelope 為 additive，本 Change 只凍結 backend 產出契約，不新增 UI。

## 相容性設計

1. **既有 error-code 語意不變**：`denied_by_authorization`／`rejected_before_dispatch`／`ambiguous_after_dispatch`／`cancelled` 等 typed outcome 語意不變；新增 structured envelope 為 additive。
2. **既有 env 語意不變**：`TOOL_*` env 作為 descriptor 組裝預設來源，不變更既有 override 行為。
3. **Agent 行為回歸**：Weather／Web／Calculator／MCP 依現有 golden eval／mock smoke／live smoke 回歸；分階段遷移 read-only 先行，mutation 後行。
4. **legacy string 相容**：presentation adapter 保留 legacy string，舊 client 安全降級。
5. **不變更 Graph ID／公開 BFF route**。

## 資料流

```text
Browser → BFF（既有 proxy，原樣透傳）
  → LangGraph Agent Server（Run/queue/checkpoint authority，X11 界線不變）
  → backend Agent node（Chatbot/Math/MCP/Deep Research）
    → unified dispatch pipeline（composition root 擁有）
      → decode → input schema validation → descriptor resolution → authorization/durable HITL
      → scheduling（結構層）→ Task/Step start → side-effect prepare（mutation）
      → retry budget → dispatch（timeout/abort）→ output schema validation
      → reconcile（ambiguous）→ compensate/park → structured tool result
      → Task event + audit + trace
```

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 維持 governance wrapper 為唯一 dispatch（現況） | 零遷移成本 | side-effect ledger/retry/reconciliation/compensation/Task-Step 全未接，違反 X11 Invariant #4/#5，不採用 |
| 每 Agent 各寫一份 dispatch | 遷移簡單 | 產生 N 份重複 dispatcher，policy 漂移，違反 X14「No duplicate dispatcher per Agent」，不採用 |
| 直接讓 governance wrapper 內 new `ToolExecutionRunner` | 少一個 composition root | 組裝邏輯散落、descriptor 無單一來源、難以架構測試，不採用 |
| composition root + 統一 descriptor（本方案） | 單一 registry + 單一 dispatcher | 需遷移三條路徑；以 architecture test + 分階段回歸守護 |
| mutation 全數不進 ledger（只接 read-only） | 省 descriptor 工作 | 不滿足「mutation 必用 ledger」與 business-effect idempotency，不採用 |

## 風險與緩解

- **接線後既有 Agent 回歸**：golden eval／mock smoke／live smoke 全量回歸；read-only 先行遷移。
- **強制 ledger 誤傷 read-only**：read-only 走 typed executor，僅 mutation 進 ledger；分派正確性以 test 證明。
- **business-effect key 不穩定造成誤 commit／誤 replay**：`deriveBusinessEffectKey` 單一來源；缺 descriptor 註冊 fail-closed。
- **ambiguous timeout 被誤 blind retry**：reconcile-first 強制，retry 只接 `not_committed` 或 external idempotency guarantee。
- **mandatory dependency unavailable 被誤放行**：dispatch 前 fail-closed；fault-injection test。
- **三條路徑遷移漏接**：architecture test 以 import/invoke 靜態攔截。
- **structured envelope 與 legacy string 漂移**：versioned envelope 單一來源；contract fixture；frontend fallback 只讀 structured。
- **durable replay/reconciliation 依賴未經 L 驗證的 checkpoint 行為**：依 X11 約束標記「基於未驗證假設」；deterministic + mock 證明契約，live 另列。
