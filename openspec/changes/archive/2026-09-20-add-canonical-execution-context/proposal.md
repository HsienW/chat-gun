# Proposal：add-canonical-execution-context

## 變更摘要

建立一個 runtime-validated 的 canonical execution identity，讓同一份 `ExecutionContext` 從 Browser → BFF → LangGraph Agent Server → Graph → model → Tool → authorization → audit → tracing（OTel／Opik）→ metrics → Task/Step events → terminal responses 全程一致流動，並以單一 Backend adapter 收斂今日散落在多個模組、以不同 key name 與位置讀取關聯 ID 所造成的 correlation drift。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X12**，是 Layer 4（Runtime Integration Foundation）的第二個 Change；其前置 X11（`reverify-current-langgraph-runtime-boundary`）已 archive，Decision Record `docs/decisions/current-langgraph-runtime-boundary.md` 已通過獨立 review。

> 前置約束（X11 Decision Record §決策）：X12 起任何涉及**正式部署持久化**的決策，MUST 明示「基於未驗證假設」，直到後續 Change 取得 L 證據。本 Change 不引入正式 Agent Server PG／Redis 持久化行為變更，故不觸發此約束；但若任何設計假設需依賴「Agent Server 會將 `config.configurable` 完整持久化」，必須於 design 中標記為「基於未驗證假設」。

## 問題描述

今日程式碼確實攜帶 `requestId`、`threadId`、`runId`、`taskId`、`stepId`、`toolCallId`，但多個模組各自以不同 key name、不同位置（top-level `RunnableConfig` vs `config.configurable`）、不同命名慣例（snake_case／camelCase／kebab-case）獨立讀取同一邏輯值，造成「看起來有埋點、實則與 authoritative Run 斷線」的 correlation drift。經盤點確認的具體 drift 包括：

1. **`runId` 位置分裂**：`deep-researcher.ts:1720` 的 `getRunId` 只讀 top-level `config.runId`，不 fallback `configurable.run_id`；`evaluation/opik/experiment.ts:280` 寫入 snake `configurable.run_id`；`interaction-runtime.ts:258` 與 `opik-graph.ts:29-30` 兩者都讀。結果：以 experiment harness 只給 `configurable.run_id` 時，weather-clarification 的 `runId` 會是空值。

2. **`requestId` 對 tracing 不可見**：`langgraph.json:14` 與 `interaction-runtime.ts:267` 使用 header key `x-request-id`，但 `opik-graph.ts:34` 只讀 `request_id`/`requestId`，`ToolExecutionRunInput.requestId` 是 camelCase。同一 request identity 進得了 interaction governance、進不了 Opik span。

3. **`taskId` 三套 key set**：`deep-researcher.ts:119` `getTracingTaskId` 只讀 snake `task_id/thread_id/run_id`（且靜默以 `thread_id`/`run_id` 當作 task id）；`tool-governance.ts:109-126` `resolveDecisionCorrelation` 只讀 camel `taskId`；`interaction-runtime.ts:265` 與 `opik-graph.ts:33` 兩者都讀。

4. **`stepId` 寫讀不一致**：寫入 `configurable.step_id = nodeName`（`deep-researcher.ts:684`），讀回 camel `stepId`（`traceNode`→`getTracingStepId`、`opik-tracer.ts:30`）。

5. **`toolCallId`／`tool_call_id`**：寫入 `configurable.tool_call_id`（`deep-researcher.ts:681`）與 `ToolMessage`（`:731`），讀 `tool_call_id`/`toolCallId`（`tool-governance.ts:633`），Opik/`ReplayIdentityInput` 用 camel `toolCallId`。

6. **`AuditEvent` 丟失 run/thread identity**：`audit-events.ts:7-23` 與 `audit_events`（migration 005）**沒有** `request_id/thread_id/run_id` 欄位，`runId`/`threadId` 只存活在 opaque `payload` JSON 內，無法索引／查詢關聯。

7. **correlation 優先序在同一檔案內不一致**：`provenance-integration.ts:61-67` 偏好 `requestId > taskId > runId > threadId > stepId`，`provenance-integration.ts:186-191` 偏好 `runId > requestId > taskId > threadId`。

8. **`AbortSignal` 寫入 checkpointed state**：`tool-governance.ts:239-259` `withGovernanceSignal` 把 `abortSignal: signal` 寫進 `config.configurable`，而 LangGraph 會 checkpoint `configurable`，導致不可序列化的執行期物件可能進入 checkpoint。

9. **前端事件無 correlation**：`AgentRuntimeEvent` union（`agent-runtime-events.ts:8-32`）每個 variant 只有 `ts`，無 `eventId`/`sequence`/`runId`/`threadId`/`toolCallId`；關聯靠遞迴、key-flexible 的深層搜尋（`interaction_runtime`/`data`/`taskEvent`/`payload`/`events`），脆弱且無型別契約。`runId` 對前端只是「hint」：client 只能被動 echo superseded 事件回傳值，首次 submit 前 `activeRunHintRef` 為 undefined。

10. **無單一 `ExecutionContext` 型別**：今日只有多個部分型別（`InteractionRunContext`、`ToolAuthorizationContext`、`DecisionCorrelation`、`RecommendationInput`、`AgentRunMetadata`、`ToolExecutionRunInput`、`DecisionRecord`），各自重複宣告重疊欄位，沒有一個 runtime-validated 的權威型別貫穿全鏈。

若直接在此狀態上疊加 X13（Authorization/HITL）、X14（Tool Dispatch）、X19（Event Envelope）、X21（Readiness Gate），correlation drift 會被放大到 authorization、audit 與 release gate 的查詢層，形成「可觀測性宣稱成立、實則與 Run 斷線」的隱性缺陷。

## 解決方案

以「單一權威型別 + 單一 adapter + 單一命名邊界」收斂：

1. **Domain 型別與 strict schema**：於 Backend 定義 `ExecutionContext`（見 X12 issue 的 interface），組合既有 `PrincipalContext`（`runtime/authorization/principal.ts:17-25`）與 `RuntimeScope`（`runtime/authorization/scope.ts:10-15`），並以 Zod 建立 runtime schema，對外部輸入執行 Runtime Validation。

2. **單一 Backend adapter**：以一個 `readExecutionContext(config)` 取代／收斂今日多個 `read*` 函式（`readRunContext`、`readAgentRunMetadata`、`resolveDecisionCorrelation`、`getTracingTaskId`/`getTracingStepId`、`getRunId` 等），作為 LangGraph request/config metadata → `ExecutionContext` 的唯一映射點；所有 snake_case／kebab-case／camelCase 對映只在此一處發生，內部模組只使用單一 naming convention。

3. **Transport type 與 domain type 分離**：BFF 的 trusted headers、`config.configurable` 的 raw key、前端的 `InteractionRequestMetadata` 屬 transport type，不得與 domain `ExecutionContext` 混用；adapter 是唯一橋接。

4. **BFF 產生／驗證 `requestId` 並覆寫所有 trusted identity 欄位**：修補 `getRequestId`（`server.ts:231-233`）目前「client 值零驗證直採」的缺口；reject duplicate、incomplete、oversized、malformed 的 correlation headers。

5. **傳播至全鏈**：Task/Step events、ToolExecution、authorization、audit、OTel、Opik、metrics、terminal envelopes 一律由 canonical `ExecutionContext` 提供 correlation；補上 `AuditEvent` 缺的 `request_id/thread_id/run_id`。

6. **Parent/child Run correlation**：以 `parentRunId` 表達父子關係，且明確不把 `threadId`、user prompt ID、request attempt 與 `runId` 混為一談。

7. **checkpoint 序列化安全**：`ExecutionContext` 與 checkpoint state 只含 JSON 可序列化欄位；修補 `withGovernanceSignal` 把 `AbortSignal` 寫入 `configurable` 的缺陷，改用 LangGraph 標準 top-level `config.signal` 傳遞取消訊號。

## 受影響範圍

### 受影響套件

- `backend`：定義 `ExecutionContext` + schema + adapter，並把 correlation 傳播至 events、ToolExecution、authorization、audit、tracing、metrics、terminal。
- `bff`：`requestId` 產生／驗證、correlation headers 的 reject／overwrite、trusted identity 覆寫。
- `frontend`：收斂 transport metadata 型別、對送出前 correlation 做驗證、容忍新欄位。

### 受影響能力域

- 執行身份與 correlation（本 Change 主體）。
- 事件／ToolExecution／Authorization／Audit／OTel／Opik／Metrics／terminal envelope 的 correlation 欄位。

### 既有能力原語（本 Change 收斂、不重造）

- `PrincipalContext`／`RuntimeScope`（`add-runtime-identity-permission-governance`）。
- `InteractionRunContext`／`readRunContext`（`add-agent-interaction-runtime`）。
- `AgentRunMetadata`（`integrate-opik-agent-tracing-evaluation`）。
- `ToolExecutionRecord`／`ReplayIdentityInput`（`add-side-effect-tool-execution-runtime`）。
- `TaskEvent`／`AgentTask`／`AgentStep`（`add-agent-task-state-machine`）。
- `AuditEvent`（`add-agent-idempotency-audit`）。

## 目標

- 以單一 `runId` 從 BFF request 一路跟到 model、Tool、audit、trace、event 與 terminal response。
- 平行 Run 不得互相覆寫 context。
- Child Run 帶 `parentRunId` 且保有獨立 `runId`。
- Production 下缺 mandatory context 時 fail-closed。
- checkpoint 序列化不含 client、signal、stream、function 或 credential。
- 以 contract test 涵蓋 legacy key mapping、unknown fields、malformed IDs 與 concurrent Runs。
- frontend、bff、backend 三套件 build／test 通過。

## 非目標

- ❌ 不建立 process-global mutable current Run variable。
- ❌ 不把 `threadId` 或 `requestId` 改名為 `runId`。
- ❌ 不由 user text、display name 或 model output 推導 identity。
- ❌ 不變更任何 Graph ID、公開 BFF route 或既有 error-code 語意。
- ❌ 不在本 Change 引入 versioned event envelope（屬 X19）。
- ❌ 不建立第二套通用 Run Runtime（X11 invariant）。
- ❌ 不修改正式 Agent Server PG／Redis 持久化行為。

## 風險

| 風險 | 緩解 |
|---|---|
| correlation 欄位變更破壞既有事件消費者 | 既有 headers 僅經 explicit compatibility adapter 接受；既有 events 在 bounded migration window 內可省略新欄位，新 producer MUST 發 canonical context |
| adapter 收斂不完整，仍有模組自行讀 config key | 以 architecture test／contract test 阻止直接讀 raw config key，並在 design 明確單一 adapter 邊界 |
| `config.configurable` 的完整持久化行為未經 L 驗證 | 遵循 X11 Decision Record：凡設計假設依賴「configurable 會持久化」者，MUST 標記「基於未驗證假設」，不宣稱正式部署已證實 |
| `AbortSignal` 移出 checkpointed state 破壞取消語意 | 改採 LangGraph 標準 `config.signal`（top-level，非 checkpointed），並以取消回歸測試驗證 |
| 三套件同步改動造成跨層契約不一致 | 以 contract fixture 單一來源；三套件 lint/test/build 全量執行 |

## 回滾策略

本 Change 為加欄位、收斂 adapter 的向後相容變更：既有 headers 經 compatibility adapter 保留、既有 events 可省略新欄位、不變更任何 Graph ID／route／error-code。若實作驗證失敗，可逐套件 revert 至「既有各模組獨立讀 config key」的狀態，不影響既有系統行為。compatibility adapter 與 canonical schema 為 additive，可獨立停用（feature flag）而不回退資料庫 schema 歷史。
