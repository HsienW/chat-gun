# Tasks：wire-trusted-identity-authorization-hitl

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。未完成的驗證如實標記，不假稱通過。live 驗證（Agent Server 正式部署的 interrupt／resume）屬後續 L 證據，於回報中明確列出未驗證項。

## T1 建立 production Tool authorization composition root（backend）

- [x] 新增 `createToolAuthorizationConfig(...)` factory，組裝 `ToolRiskRegistry`、`AuthorizationEngine`（接 `PgGrantStore` + policy resolver + scope-access resolver）、`PgDecisionStore`（`ContextRedactor`）、versioned policy identity。
- [x] 將 `resolveExecutionContext` 指向 `readExecutionContext`（X12 adapter）。
- [x] production factory 將 `policyVersion` 設為 required input；既有 optional fallback 不得被 production caller 使用，並以 architecture test 守護。
- [x] 未註冊 Tool 預設依明確 authorization profile：production = `deny`；development = 明確 flag 才 `read`；移除 protected path 對 `NODE_ENV=development`／缺 identity 的隱式 anonymous fallback。
- [x] 新增 unit test：factory 產出的 config 具備完整 dependency、policy version 單一來源、profile 分支正確且未知 profile fail-closed。

驗證命令：

```bash
cd backend
npm run test -- src/tools/authorization/ src/runtime/authorization/
npm run lint
```

## T2 為 production Tools 宣告 ToolRiskPolicy（backend）

- [x] 建立單一 registry 組裝點，為 calculator／weather／weatherForecast／web-fetch／web-search 宣告 `ToolRiskPolicy`（`riskTier`、`actions`、`resourceRefResolver`、`requireConfirmation`）。
- [x] 定義 strict、versioned `McpToolRiskDescriptorV1`（stable `serverName + toolName`、risk tier、non-empty actions、confirmation、resource strategy），由 composition-root server config 提供；MCP `description`／`annotations` 不得提升權限。
- [x] loader 驗證 descriptor 並對映 `ToolRiskPolicy`；內建 `filesystem`／`brave_search` 補明確 mapping，其他 server 缺失／非法／未知 version default deny；duplicate exposed tool name 拒絕載入衝突項。
- [x] `resourceRefResolver` 依 scope 供給 tenant，不硬編碼業務類型；未宣告 risk 的 MCP tool 採 deny。
- [x] 新增 test：每個 local production Tool 都有 policy；MCP descriptor success／missing／invalid／unknown-version／duplicate；未知 tool 依 profile deny。

驗證命令：

```bash
cd backend
npm run test -- src/tools/
npm run build
```

## T3 將 authorization config 注入 applyToolGovernance（backend）

- [x] 改 `loadAgentTools`（`registry.ts:34`）與 `loadMcpTools`（`mcp-loader.ts:310`）注入 composition root 產出的 `ToolAuthorizationGovernanceConfig`。
- [x] 新增 architecture test：production 不得存在未帶 authorization config 的 `applyToolGovernance` 呼叫；未註冊 production Tool 不得放行。

驗證命令：

```bash
cd backend
npm run test -- src/tools/ src/runtime/execution-context/
npm run build
```

## T4 擴充 Agent Server trusted-header 白名單（backend）

- [x] 於 `langgraph.json` `http.configurable_headers.includes` 加入必要 trusted `x-bff-*` headers（principal 七欄位 + `x-bff-scope-id`／`x-bff-scope-type`），MUST NOT 加入 raw client identity header。
- [x] 維持 configurable header scalar string schema，不放寬為 array／JSON；`x-bff-scopes` 為 permission scopes CSV，`x-bff-scope-id`／`x-bff-scope-type` 各為唯一 active scope 的單值 string。
- [x] 新增 test／契約檢查：白名單只含 canonical trusted headers，不含 `x-user-id`／`x-tenant-id`；permission scopes CSV 與 active scope scalar 可 round-trip，array／JSON／重複 active header 被拒。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/authorization/
npm run build
```

## T5 BFF active scope projection 與 strip 回歸（bff）

- [x] 擴充 `PrincipalResolver` 成功結果與 authentication profile schema，required 回傳唯一 `activeScope { scopeId, scopeType }`；共用 cross-layer scope type fixture，禁止從 permission `scopes[]` 猜測。
- [x] `copyRequestHeaders` 補 `x-bff-scope-id`／`x-bff-scope-type`，只取 resolver active scope；permission scopes 以 trim／去空值／去重後的 CSV string 投影，token 含逗號、active scope 缺失／非法／tenant 不相容或衝突時 fail-closed 且不 proxy。
- [x] 補 `node:test`／`vitest` 回歸：client 偽造 `x-bff-*`／`x-user-id`／`x-tenant-id` 不轉送；resolver 值覆寫；多 permission scopes CSV 不影響單一 active scope；逗號 token、缺失／衝突 active scope 被拒。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T6 require_confirmation → LangGraph interrupt + durable waiting（backend）

- [x] 先定義並凍結 versioned `confirmation_required` descriptor、interrupt public payload 與 resume payload schema，作為 T7 的輸入契約；全部可 JSON serialize 且只含 redacted data。
- [x] 將 governance 改為回傳 typed `confirmation_required` descriptor；`authorizeToolDispatch`／`onRequireConfirmation` 不得直接呼叫 `interrupt()`。
- [x] 新增 authorization gate node → confirmation node → physical dispatch node adapter；只有具 checkpoint context 的 confirmation node 呼叫 `interrupt()`，且 interrupt 是該 node 的第一個非純運算動作。
- [x] pending decision 與 Task/Step `waiting_confirmation` 在前一 gate node 依 `decisionId` idempotent upsert；resume 重跑 confirmation node 不得重複 non-idempotent side effect。
- [x] 新增 test：governance descriptor 與 graph interrupt 邊界、同 thread resume、waiting state 持久化、node re-execution 不重複寫入；持久化失敗時不宣稱 durable 且不 dispatch。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/authorization/ src/platform/
npm run build
```

## T7 一次性 scoped resume（backend）

> 依賴：T6 必須先完成並凍結 descriptor／interrupt／resume schema；T7 不得在該契約未定義時獨立實作。

- [x] 以 CSPRNG 產生至少 256-bit `approvalId`，並在 persistent store 以 atomic compare-and-set 實作 pending → approved／denied／expired；`approvalId` 單獨持有不得授權。
- [x] 實作 resume 驗證：BFF trusted principal、allowed approver、scope、runId、decisionId、resource、policyVersion、expiry；重用／過期／cross-tenant／mismatched-run／mismatched-resource 拒絕並 audit。
- [x] 沿用既有 `/api/langgraph/*` proxy 與同 thread `Command({ resume })`；新增 BFF contract test 證明 authorization interrupt SSE／resume request 原樣透傳且 canonical identity/scope 重新覆寫，不新增平行 route。
- [x] Agent MUST NOT 具備自我批准 callable 路徑。
- [x] 新增 test：核准 resume 恰一次且 effect 改 `CONFIRMATION_APPROVED`；競態只有一個 consumer 成功；重用／過期／identity/scope/run/resource mismatch 拒絕；raw credential 不進 checkpoint／decision／log。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/authorization/
npm run build
cd ../bff
npm run test
npm run build
```

## T8 decision 持久化與 ToolExecution 連結（backend）

- [x] 確保 decision 於 dispatch 前 `decisionStore.record`，side-effect `tool_executions` 記錄 `decisionId`。
- [x] 確保 deny／timeout／`AUTHORIZATION_UNAVAILABLE` 不進入 X2 Retry Budget；重試前重估 authorization。
- [x] 新增 test：`findByToolExecutionId` 可查回決策；deny 不建立 physical attempt；fault-injection 證明決策持久化失敗即 deny。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/runtime/authorization/
npm run build
```

## T9 跨層 contract fixture 與兩套件全量驗證

- [x] 以單一來源建立 cross-layer contract fixture（trusted header 映射、permission scopes CSV、scope type、active scope scalar projection、MCP descriptor、confirmation interrupt/resume、allow／deny／confirm／timeout／restart／replay／cross-tenant）。
- [x] 執行 bff／backend 完整 lint／test／build，如實記錄 skipped／未驗證項與 live 驗證缺口。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run build && npm run test
```
