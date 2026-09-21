# Design：add-canonical-execution-context

## 定位

本 Change 是**跨三套件的契約型變更**，核心是「一個 canonical `ExecutionContext` + 一個 Backend adapter + 一個命名邊界」，把散落的 correlation identity 收斂為單一事實來源。實作以 **additive 加欄位 + adapter 收斂** 為主，不做破壞性遷移。

- `frontend`：收斂 transport metadata 型別、送出前驗證、容忍新欄位。
- `bff`：`requestId` 產生／驗證、correlation header reject／overwrite、trusted identity 覆寫。
- `backend`：定義 domain type + schema + adapter，並把 context 傳播至 events／ToolExecution／authorization／audit／tracing／metrics／terminal。

## 現況盤點（已驗證的 drift 事實）

盤點（本 Change 建立時）確認的關鍵事實與缺陷：

| 事實 | 位置 | 對本設計的意義 |
|---|---|---|
| 唯一統一關聯 ID 的地方是 `readRunContext` | `backend/src/platform/interaction-runtime.ts:251-290` | 作為 canonical adapter 的實作起點與取代對象 |
| `PrincipalContext` 已存在 | `backend/src/runtime/authorization/principal.ts:17-25` | `ExecutionContext.principal` 直接沿用 |
| `RuntimeScope` 已存在 | `backend/src/runtime/authorization/scope.ts:10-15` | `ExecutionContext.scope` 直接沿用 |
| configurable headers 白名單只有 4 個 | `backend/langgraph.json:12-19`（`x-request-id`、`x-idempotency-key`、`x-active-run-id`、`x-active-run-generation`） | `thread_id`/`run_id`/`task_id`/`step_id` 必須由 caller 放入 `configurable`，非由 header 進入 |
| `AbortSignal` 寫入 checkpointed `configurable` | `backend/src/runtime/tool-governance.ts:239-259` | 必須改用 top-level `config.signal` |
| `AuditEvent` 無 run/thread 欄位 | `backend/src/runtime/audit/audit-events.ts:7-23`、migration `005` | 補 `request_id/thread_id/run_id` 欄位 |
| `AgentRuntimeEvent` 只有 `ts` | `backend/src/platform/agent-runtime-events.ts:8-32` | terminal/stream event 需帶 canonical correlation |
| 前端 `AgentRuntimeEvent` union 只有 `ts` | `frontend/src/types/agent-runtime-events.ts:8-32` | 前端消費端需容忍新欄位（bounded migration） |
| BFF 直採 client `x-request-id` 零驗證 | `bff/src/server.ts:231-233` | 修補為 generate／validate |
| `RequestContext` 丟棄 principalType/roles/scopes/authSource | `bff/src/server.ts:71-77`、`:1173-1176` | correlation 應由 canonical trusted headers 組成，不在 `RequestContext` 重複 |

## ExecutionContext 契約

### Domain 型別（Backend 單一事實來源）

```typescript
interface ExecutionContext {
  requestId: string;
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  toolCallId?: string;
  toolExecutionId?: string;
  parentRunId?: string;
  agentId?: string;
  attempt: number;
  principal: PrincipalContext;   // 既有 runtime/authorization/principal.ts
  scope: RuntimeScope;           // 既有 runtime/authorization/scope.ts
}
```

- 型別只含 JSON 可序列化欄位；`AbortSignal`、client、function、credential、stream MUST NOT 出現於此型別或任何 checkpointed state。
- `attempt` 由 adapter 依 config 的 retry/attempt 訊號解析，預設 `1`；未知時 fail-closed 為 explicit 預設，不得由 model output 推導。
- `stepId`/`toolCallId`/`toolExecutionId`/`parentRunId`/`agentId` 為 optional，因其於不同執行階段才具值（node 前無 `stepId`、Tool dispatch 前無 `toolCallId`）。

### Zod runtime schema

對 `ExecutionContext` 建立 Zod schema，作為唯一 runtime validation 來源：

- `requestId`/`threadId`/`runId`/`taskId`：非空 string、符合既有的 ID 字元集（字母／數字／`_`／`-`／`.`／`:`，與 BFF `validateIdempotencyHeader`／`validateActiveRunHint` 的既有 pattern 一致）、有長度上限（oversized 拒絕）。
- `principal`／`scope`：沿用既有 `isPrincipalContext` 與 scope 驗證。
- unknown fields：strict（`strict()`）以偵測 typo／未來欄位，避免靜默通過。

### 單一 adapter（命名邊界）

新增 `readExecutionContext(input, config)`，作為「LangGraph request/config metadata → `ExecutionContext`」的唯一映射點，取代／收斂下列散落讀取：

- `interaction-runtime.ts` `readRunContext`（`thread_id/run_id/task_id/step_id/tool_call_id/scope_id/request_id/x-request-id/x-idempotency-key/x-active-run-*`）
- `opik-graph.ts` `readAgentRunMetadata`／`readStepId`
- `tool-governance.ts` `resolveDecisionCorrelation`／`getConfigString`
- `deep-researcher.ts` `getTracingTaskId`/`getTracingStepId`/`getRunId`

adapter 內部依序處理：

```text
raw config 讀取（top-level RunnableConfig + config.configurable）
  → 單一 key 對映表（snake_case/kebab-case/camelCase → domain 欄位）
  → 欄位補全（stepId/toolCallId 由 node/tool 階段注入）
  → 值驗證（ID 字元集、長度、型別）
  → Zod parse → ExecutionContext
  → principal/scope 解析（parseTrustedPrincipal + scope projection）
```

**命名規則**：內部 domain 一律 camelCase；snake_case／kebab-case 只出現在 adapter 的對映表內，MUST NOT 散落於 events、ToolExecution、audit、tracing、metrics 或 terminal 消費端。

### 傳播機制（無 global mutable state）

canonical context 的傳播採用**顯式 config + 參數**，不引入 process-global mutable：

1. Graph 入口以 `readExecutionContext` 建立並 Zod-validate `ExecutionContext`。
2. 將 JSON 可序列化的 canonical context（**不含 `AbortSignal`**）寫入單一 `configurable.execution_context` key，供 LangGraph 於 node／Tool 間自動攜帶。
3. 取消訊號走 LangGraph 標準 top-level `config.signal`（非 checkpointed），修補 `withGovernanceSignal` 不得再寫 `configurable.abortSignal`。
4. 需要 context 的模組透過 adapter 自 `config` 讀回，MUST NOT 各自解析 raw config key。

> **基於未驗證假設（X11 約束）**：上述設計假設「Agent Server 會將 `config.configurable` 於 Run 間完整持久化」。此為 D（官方文件）與 V（`langgraph dev`）支持但**尚未取得 L（正式部署）證據**的假設；正式部署的 checkpoint 持久化行為仍待後續 Change 以 L 證據確認。本 Change 不依賴此假設做任何正式部署持久化決策。

### 傳播目標與既有模組的對應

| 傳播目標 | 現況 | 本 Change 動作 |
|---|---|---|
| Task/Step events | `TaskEvent`（`types.ts:101-108`）有 `eventId/taskId/stepId`，無 `runId/threadId/requestId` | 於事件 payload 或結構化 correlation 欄位補上 canonical `requestId/threadId/runId` |
| ToolExecution | `ToolExecutionRecord`（`business-effect-ledger.ts:50-61`）欄位於 DB columns 有 `request_id/thread_id/run_id/task_id/step_id` | 確保 record 產生時自 `ExecutionContext` 一次取得，不再各自讀 config |
| Authorization | `ToolAuthorizationContext` 已有 `principal/scope` | 補 `requestId/threadId/runId/taskId` correlation |
| Audit | `AuditEvent` 缺 run/thread 欄位 | 補 `request_id/thread_id/run_id`（欄位 + migration），並由 `ExecutionContext` 供給 |
| OTel | span attributes 散落（`interaction.*`、`step.id`、`task.id`） | 以 canonical context 供給統一 correlation attributes |
| Opik | `AgentRunMetadata` 已有 `threadId/runId/taskId/requestId` | 改由 `readExecutionContext` 供給，取代 `readAgentRunMetadata` |
| Metrics | `TaskMetric/StepMetric/ToolMetric` 以 `taskId/stepId` 為主，無 `runId/threadId/requestId` | 補 `runId/threadId/requestId` |
| Terminal envelopes | 無專屬 envelope type；錯誤 envelope 於 `platform/errors.ts` | 終端回應／錯誤 envelope 帶 canonical correlation |

## 分層設計

### backend

- 新增 `ExecutionContext` domain type + Zod schema + `readExecutionContext` adapter。
- `readRunContext` 收斂／改呼叫 adapter，保留既有 `InteractionRunContext` 的 consumer 以 compatibility adapter 過渡。
- 補 `AuditEvent` 的 `request_id/thread_id/run_id` 欄位（migration，additive）。
- 修補 `withGovernanceSignal`：取消訊號改走 `config.signal`。
- 加 architecture／contract test 阻止直接讀 raw config key。

### bff

- `getRequestId` 改為：client 提供值必須通過格式／長度驗證（與既有 `validateIdempotencyHeader` 的 ID 字元集一致），否則 reject 或取代為 server-generated UUID；duplicate／malformed 時 reject（400）。
- 保留既有 trusted identity 覆寫（`copyRequestHeaders` 已寫 `x-bff-principal-*`），並確認 correlation headers（`x-request-id` 等）由 BFF 覆寫、不 trust client raw 值。
- 新增 `node:test` 覆蓋：合法／非法 requestId、duplicate header、oversized、malformed、trusted identity 覆寫。

### frontend

- 收斂 `InteractionActiveRunHint` 與 `TaskEventActiveRunHint` 的重複型別。
- 送出前驗證 `requestId`／`idempotencyKey`／`activeRunHint`（格式／長度），malformed 時不送出或採 client 端 safe 降級。
- 事件消費端容忍 canonical 新欄位（未知欄位安全降級）；「以 `runId` 取代脆弱 deep-search」的完整 envelope 契約屬 X19，本 Change 只做容忍與型別對齊。

## 相容性設計

1. **既有 headers**：`x-request-id`、`x-idempotency-key`、`x-active-run-id`、`x-active-run-generation` 只經 explicit compatibility adapter 接受，不新增任何 header 語意變更。
2. **既有 events**：bounded migration window 內可省略新 correlation 欄位；新 producer MUST 發 canonical context。
3. **不變更**：Graph ID、公開 BFF route、既有 error-code 語意。
4. **legacy key mapping**：adapter 對映表同時保留 snake_case／kebab-case／camelCase，作為 contract test 的明確覆蓋對象。

## 資料流

```text
Browser
  → 前端送出（requestId/idempotencyKey/activeRunHint，送出前驗證）
  → BFF（generate/validate requestId、覆寫 trusted identity、reject malformed correlation）
  → LangGraph Agent Server（configurable_headers 白名單）
  → backend readExecutionContext（單一 adapter + Zod）
  → ExecutionContext 寫入 configurable.execution_context（不含 AbortSignal）
  → node / model / Tool / authorization / audit / OTel / Opik / metrics（自 canonical context 讀取）
  → Task/Step events / terminal envelope（帶 canonical correlation）
  → BFF 透傳
  → 前端消費（容忍新欄位）
```

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 各模組繼續自行讀 config key（現況） | 零成本 | 維持 correlation drift，X13/X14/X19/X21 會放大缺陷，不採用 |
| AsyncLocalStorage 隱式傳遞 context | 減少參數傳遞 | 需額外跨 async 邊界治理、與 LangGraph checkpoint 交互相對隱晦，且易形成「隱式 global 狀態」；本 Change 採顯式 config + 參數，較易驗證與 checkpoint-safe |
| 單一 adapter + 顯式 config（本方案） | 收斂單一事實來源 | 需改多個消費端；以 additive 與 compatibility adapter 控制影響 |
| 一次完成 versioned envelope（併入 X19） | 省一次契約變更 | 超出 X12 範圍，會使 correlation 與 versioning 兩件正交議題耦合；分離處理較可獨立驗證 |

## 風險與緩解

- **跨三套件契約漂移**：以 contract fixture 單一來源；三套件 lint/test/build 全量執行。
- **adapter 收斂不完整**：architecture test 阻止直接讀 raw config key。
- **checkpoint 序列化回歸**：以「序列化後不含 `AbortSignal`/function/credential」的 contract test 守護。
- **取消語意回歸**：`AbortSignal` 改走 `config.signal` 後，以既有取消／supersede 回歸測試驗證。

## MAJ-1 仲裁：principal／scope 的 canonical sourcing（review-plan 後補記）

Qwen review-plan 於 APPROVE 下提出 MAJ-1：`principal`／`scope` 進入 `readExecutionContext` 的具體路徑（擴充 `configurable_headers` 白名單 vs caller 注入）。經原始碼驗證現況：

- `parseTrustedPrincipal`（`runtime/authorization/principal.ts:109`）已定義並有 unit test，但 production code 只有 import、無 call site；Graph 內無任何路徑把 trusted `x-bff-*` headers 解析成 `PrincipalContext`。
- `http.configurable_headers.includes`（`langgraph.json:12-19`）僅含 4 個 correlation header，**不含** `x-bff-principal-*`／`x-bff-tenant-id` 等 trusted identity headers，故 Agent Server 不會把這些 header 暴露進 `config.configurable`。
- `tool-governance.ts:414` 已有 `createDevelopmentAuthorizationContext()`，以 `anonymous` principal + `development-public-anonymous` scope 作為 development fallback。

仲裁決策：

1. **canonical sourcing 採「擴充 `configurable_headers` 白名單」**：`principal`／`scope` 由 trusted `x-bff-*` headers 經 Agent Server `configurable_headers.includes` 進入 `config.configurable`，再由 `readExecutionContext` 以 `parseTrustedPrincipal` 解析。**不採「caller 注入 body」**——client 不可信（frontend MUST NOT 持有 trusted identity）、BFF 不應改寫 payload 語意。
2. **白名單擴充屬 X13**：把 `x-bff-*` 加入 allowlist 是安全邊界變更（Agent Server 必須只經 BFF 進入，否則 client 可偽造 trusted identity），歸 X13——其 scope 已明示「Add only the required trusted BFF headers to the Agent Server configurable-header allowlist」。
3. **X12 邊界**：`readExecutionContext` 定義 `principal`／`scope` 的解析介面（自 `config.configurable` 的 trusted header keys 讀取）。`ExecutionContext.principal`／`scope` 為 type-level mandatory。**X12 MUST NOT 自行擴充 allowlist。**
4. **environment-gated identity（仲裁修訂）**：identity 的補齊規則 MUST 依「明確的環境 profile／feature flag」分支，MUST NOT 以「`principal`／`scope` 欄位缺失」反向推斷環境：
   - **development**（經明確 development profile／flag 判定）：採隔離的 development identity（`createDevelopmentAuthorizationContext` 語意：`anonymous` principal + `development-public-anonymous` scope），僅供 X12 自身測試／build 使用。
   - **production 或環境無法明確判定**：缺 `principal`／`scope` 時 MUST fail-closed（Zod validation failure），MUST NOT 以 development identity 或空值補齊，使未建立的身份呈現為已驗證的執行脈絡。
5. **啟用依賴（X13）**：production 的 trusted identity 供給、`configurable_headers` allowlist 擴充與「缺 identity 時 deny protected execution」的 authorization boundary 屬 X13。故依賴 canonical context 的 production 路徑，MUST 待 X13 提供 trusted identity 後才啟用；在此之前，X12 的 production 行為保持 fail-closed，不承擔也不削弱授權強制。

### review-plan Minor 裁示

- **MIN-2（taskId fallback）**：canonical `readExecutionContext` MUST 嚴格要求 `taskId`，MUST NOT fallback 到 `runId`／`thread_id`（消除 `interaction-runtime.ts:263` 與 `deep-researcher.ts:119` 的混用）。既有 caller 的 fallback 行為由 compatibility adapter 保留，且 MUST 標記為 legacy，於 bounded migration window 結束後移除。
- **MIN-3（requestId 驗證 pattern）**：BFF 對 `requestId` 的格式／長度驗證，沿用既有 `validateIdempotencyHeader`（`server.ts:144-172`）的 ID 字元集 `^[A-Za-z0-9_\-:.]+$` 與長度上限 1–256，避免另立一套不一致 pattern。
- **MIN-4（weather.ts signal 路徑）**：T4 修補 `withGovernanceSignal` 的同時 MUST 同步更新 `weather.ts:91-96` `getRunnableSignal`（改為只讀 top-level `config.signal`），並更新 `weather.test.ts:410` 以 `config.signal` 傳遞取消訊號的測試；`configurable.abortSignal` 路徑 MUST 移除。
- **MIN-1（T5 拆分）**：T5 拆分為 T5a（events + ToolExecution + authorization + audit correlation）、T5b（OTel／Opik／metrics）、T5c（terminal envelope + architecture test），各自獨立驗證。

## 對後續 X13–X21 的影響

`ExecutionContext` 是 X13（Trusted Identity + Authorization + HITL）、X14（Tool Dispatch）、X17（Input Guard）、X18（Context）、X19（Event Envelope）、X21（Readiness Gate）的共同 correlation 基礎。本 Change 通過 review 前，X13 起不得另立第二套 correlation 解析；X19 的 versioned envelope 將直接引用本 Change 的 `ExecutionContext`。
