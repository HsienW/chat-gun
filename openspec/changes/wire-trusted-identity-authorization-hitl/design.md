# Design：wire-trusted-identity-authorization-hitl

## 定位

本 Change 是**跨 bff／backend 的接線型變更**：核心是「一個 production Tool authorization composition root + 一個 trusted-header 邊界 + 一個 durable confirmation 橋」，把既有 authorization 原語從 unit-test-only 接到 production dispatch 路徑。實作以 **additive 組裝 + feature-flag 啟用** 為主，不做破壞性遷移。

- `backend`：composition root、production `ToolRiskPolicy` 宣告、`configurable_headers` 白名單、LangGraph interrupt-based durable confirmation、一次性 scoped resume、decision→ToolExecution 連結、architecture test。
- `bff`：active scope resolution／projection（`x-bff-scope-id`／`x-bff-scope-type`）與 strip／overwrite 回歸證明。

## 現況盤點（已驗證的事實）

| 事實 | 位置 | 對本設計的意義 |
|---|---|---|
| production registry 呼叫 `applyToolGovernance()` 不帶 authorization | `backend/src/tools/registry.ts:34`、`backend/src/tools/mcp-loader.ts:310` | composition root 的注入點 |
| `ToolAuthorizationGovernanceConfig` 接線面已存在 | `backend/src/platform/tool-governance.ts:77-98` | 注入對象，不新增平行介面 |
| `authorizeToolDispatch` 已實作完整授權流程 | `backend/src/platform/tool-governance.ts:420-521` | 保留既有流程，只補 durable confirmation 橋 |
| `configurable_headers` 白名單只有 4 個 correlation header | `backend/langgraph.json` `http.configurable_headers.includes` | 擴充 trusted `x-bff-*` |
| `parseTrustedPrincipal` 讀 `x-bff-*` 七欄位 | `backend/src/runtime/authorization/principal.ts:27-35,109` | 只放行這七個 + scope 投影 |
| `readTrustedIdentity` 讀 `x-bff-scope-id`／`x-bff-scope-type` | `backend/src/runtime/execution-context/read-execution-context.ts:143-162` | scope 解析的 header 來源 |
| BFF 寫 principal 七欄位但不寫 scope 投影 | `bff/src/server.ts:362-368` | 補 `x-bff-scope-id`／`x-bff-scope-type` |
| BFF 只轉送 `FORWARDED_REQUEST_HEADERS` 8 個 header | `bff/src/server.ts:60-69,352-359` | strip 行為已就緒，補回歸證明 |
| production Tool 無 `ToolRiskPolicy` 宣告 | `backend/src/tools/*` | 建立 registry 組裝點與 policy 宣告 |
| backend 無任何 `interrupt()` 呼叫 | grep `interrupt(` 於 `backend/src` = 0 | durable confirmation 需新增 interrupt 路徑 |
| `AuthorizationHitlBridge` 只在記憶體轉 Task state | `backend/src/runtime/authorization/tool-risk.ts:169-243` | 作為 waiting state 轉換基礎，補持久化與 interrupt |
| `onRequireConfirmation` 是空 hook、`require_confirmation` 目前回傳 `denied_by_authorization` | `backend/src/platform/tool-governance.ts:94-97,483-508` | 改為 durable confirmation bridge 的觸發點 |
| `PgDecisionStore`／`PgGrantStore`／`ContextRedactor` 已存在且有 test | `backend/src/runtime/authorization/*` | composition root 直接組裝，不重造 |

## 授權邊界契約

### Production composition root（backend 單一事實來源）

新增 factory，例如 `createToolAuthorizationConfig(...)`，回傳 `ToolAuthorizationGovernanceConfig`，組裝：

- `riskRegistry: ToolRiskRegistry`：以單一 registry 組裝點收集所有 production `ToolRiskPolicy`；`unregisteredToolDefault` 由環境 profile 決定（production = `deny`，development = explicit flag 才 `read`）。
- `authorizationEngine: AuthorizationEngine`：接 `PgGrantStore`、`resolvePolicy`（依 `ToolRiskPolicy` 對映為 `AuthorizationPolicy`）、`resolveScopeAccess`（依 principal/scope 與 policy access 判定 visible/writable）、`evaluateToolRisk`。
- `decisionStore: PgDecisionStore`：接 `Queryable` + `ContextRedactor`。
- `policyVersion`：versioned policy identity（如 `runtime-authorization-v1`），在 production factory input 為 required，由組裝點單一來源，MUST NOT 散落於各 Tool；既有 optional fallback 僅保留給未接 production composition root 的相容路徑與 isolated test，architecture test MUST 證明 production caller 明確供應。
- `resolveExecutionContext`：指向 `readExecutionContext`（X12 adapter），自 `config.configurable` 解析 canonical `ExecutionContext`（含 `principal`／`scope`）。
- `onRequireConfirmation`：只建立並回傳可序列化的 `confirmation_required` descriptor，不直接呼叫 `interrupt()`；graph-node adapter 才是 durable confirmation bridge 的進入點（見下）。

### BFF active scope resolution（trusted authentication source）

`PrincipalContext.scopes` 是 permission strings，不是 `RuntimeScope` 候選集合，BFF MUST NOT 從該陣列依順序、字串內容或優先表猜測 active scope。`PrincipalResolver.resolve(...)` 的成功分支改為回傳：

```text
ResolvedTrustedIdentity = {
  principal: PrincipalContext,
  activeScope: {
    scopeId: string,
    scopeType: "principal" | "tenant" | "team" | "conversation"
  }
}
```

- `activeScope` MUST 與 principal 一起由同一個已核准 authentication source／session context 解析；API-key profile 以 required `activeScope` 欄位表達，未來 session／OIDC adapter 亦須由其受信 claim 或 server-side session 提供。
- `scopeType` 的封閉集合 MUST 與 backend `SCOPE_TYPES` 共用 cross-layer fixture；BFF 在啟動設定解析與 request resolution 邊界驗證 `scopeId` 非空、`scopeType` 合法，禁止將 client `x-bff-scope-*` 當作 hint。
- authentication source 缺少、提供多個互相衝突的 active scope，或 scope 與 principal tenant 不相容時，resolution MUST 失敗且不得 proxy protected request；不得退回 `scopes[0]`、tenant default 或 anonymous scope。
- BFF 只投影 resolver 成功結果為 `x-bff-scope-id`／`x-bff-scope-type`；backend 仍以 `readTrustedIdentity` 驗證 canonical headers，缺失或非法時由 authorization boundary 回傳 `MISSING_ACTIVE_SCOPE`／`AUTHORIZATION_UNAVAILABLE` 並禁止 dispatch。

### Configurable header scalar encoding

Agent Server `configurable_headers` 維持既有 scalar string schema，本 Change 不放寬為 array，也不使用 JSON-encoded header：

- `PrincipalContext.scopes` 是 permission tokens，沿用 `x-bff-scopes` 單一 CSV string。BFF 以 trim、去空值、去重後的順序序列化；每個 token MUST 非空且不得含 `,`，否則 identity resolution fail-closed。backend 沿用 `parseTrustedPrincipal` 的 CSV `parseList` 還原。
- `activeScope` 是 resolver 從 authentication source 取得的**唯一** `RuntimeScope`，不是 `scopes[]` 的序列化結果；只以兩個 scalar string header 傳遞：`x-bff-scope-id = activeScope.scopeId`、`x-bff-scope-type = activeScope.scopeType`。
- BFF MUST NOT 把多個 scope ID 串成 CSV、重複 header 或 JSON 放入 `x-bff-scope-id`／`x-bff-scope-type`。authentication source 若無法收斂為唯一 active scope，依前節拒絕 request。
- `backend/langgraph.json` 只擴充 `includes` allowlist，不改 `configurable_headers` 的 value type。contract test MUST 同時證明 permission scopes CSV round-trip、active scope scalar round-trip、逗號 token／重複 active header／array-like value 被拒。

### ToolRiskPolicy 宣告（production tools）

每個 production Tool MUST 於組裝點宣告 `ToolRiskPolicy`（`toolName`、`riskTier`、`actions`、`requireConfirmation`、`resourceRefResolver`）：

- `calculator`／`weather`／`weatherForecast`／`web-fetch`／`web-search`：read-tier，`requireConfirmation: false`，`resourceRefResolver` 回傳 tool 自身的 `ResourceRef`（穩定 resource type + tool name as id，tenant 自 scope 供給）。
- `web-fetch`／`web-search` 若有 write／sensitive 潛力，依既有領域規則宣告；本 Change 不新增任何業務專屬分支，一律由 `ToolRiskPolicy` 宣告驅動。
- MCP tools：本 Change 不信任 MCP `listTools()` 回傳的 description／annotations 作為 authorization policy。risk 由 backend composition root 的 versioned server config 明確宣告，loader 驗證後才對映 `ToolRiskPolicy`；缺失或非法一律 default deny。

MCP risk descriptor 採下列 transport-safe schema（實作以 Zod `strict()` 驗證），key 為 stable `serverName + toolName`，而非只用可能碰撞的 display name：

```text
McpToolRiskDescriptorV1 = {
  schemaVersion: "1.0",
  serverName: string,
  toolName: string,
  riskTier: "read" | "write" | "sensitive" | "communication",
  actions: non-empty string[],
  requireConfirmation: boolean,
  resource: {
    strategy: "scope_tool",
    resourceType: string
  }
}
```

- loader 以 `{serverName, toolName}` 尋找 descriptor，驗證 `schemaVersion`、enum、non-empty actions 與 resource strategy，然後建立既有 `ToolRiskPolicy.resourceRefResolver`；tenant 只能取自 trusted `RuntimeScope`。
- 同一個 exposed tool name 由多個 server 提供時 MUST 拒絕載入衝突項，避免 policy 套錯；未知 descriptor version、缺 descriptor 或 parse failure 的 tool 可被發現但 MUST 以 `UNREGISTERED_TOOL_DENIED` fail-closed，且 audit 不含 secret env。
- migration：內建 `filesystem`／`brave_search` server 先在 composition-root config 補齊明確 descriptor；其他既有／自訂 server 在未完成 mapping 前保持 deny。未來若接受 MCP server 自行宣告 risk，必須另立 Change 定義簽章、信任與降權規則；本 Change 不允許 untrusted server metadata 提升權限。

### 預設 deny 與環境 profile

- production（`NODE_ENV === "production"` 或明確 profile）：未註冊 Tool → `UNREGISTERED_TOOL_DENIED`；缺 identity/scope → deny fail-closed。
- development：僅在**明確 authorization profile／feature flag** 下，未註冊 Tool 可採 `read` default，且 identity 採隔離 `createDevelopmentAuthorizationContext` 語意；`NODE_ENV=development` 本身不足以 opt-in，MUST NOT 由「缺 identity」反向推斷環境。
- 既有 `readTrustedIdentity(environment=development)` 與 governance 的 `NODE_ENV === "development"` anonymous fallback 不得進入啟用 production composition root 的 protected path；實作須改由 factory 明確注入 development context provider。未設定 profile、profile 非法或 production 一律 fail-closed。

### Durable confirmation 橋

`require_confirmation` 採「純 governance descriptor → graph node interrupt」兩階段，避免 lower-level hook 假裝擁有 LangGraph runtime context：

```text
authorization gate node 呼叫 authorizeToolDispatch
  → allow / deny：沿用既有 typed outcome
  → require_confirmation：decisionStore 與 waiting Task/Step 以 decisionId idempotent upsert
  → governance 回傳 serialized confirmation_required descriptor
  → gate node 將 descriptor 寫入可 checkpoint 的 graph state，Command goto authorization_confirmation
authorization_confirmation node
  → interrupt(serialized public payload) 必須是 node 的第一個非純運算動作
  → 等待既有 Agent Server thread/run resume（受信控制路徑）
  → 以 trusted principal + 一次性 approvalId 驗證 scope、runId、resource、expiry
  → 通過：atomic consume approvalId，決策改 allow（CONFIRMATION_APPROVED），Command goto physical dispatch
  → 拒絕/逾時/取消：決策改 deny（CONFIRMATION_TIMEOUT/CANCELLED）→ 不 dispatch、不重試
```

- `authorizeToolDispatch`／`onRequireConfirmation` MUST NOT 直接 import 或呼叫 `interrupt()`；其輸出為 discriminated union，`confirmation_required` 至少包含 `schemaVersion`、`decisionId`、`approvalId`、Run/Task/Step/toolCall correlation、expiry、scope、resource、policyVersion 與 resume compatibility manifest。
- `authorization_confirmation` 是 graph node；同一個 node resume 時會由開頭重跑，因此 interrupt 前不得做 non-idempotent insert。pending decision／Task／Step 必須在前一個 gate node完成 idempotent upsert，confirmation node 只讀 checkpoint state 並先呼叫 `interrupt()`。
- physical dispatch 是 interrupt 後的獨立 node，使用已 atomic-consume 的 approval record 與 `decisionId`，不得依模型文字或 client body 自行拼出 allow；resume 後不得重做已完成的外部副作用。
- Agent MUST NOT 具備自我批准的 callable 路徑；批准由受信控制路徑（human/HITL）完成。

> **基於未驗證假設（X11 約束）**：上述 durable confirmation 依賴「Agent Server 於 interrupt 後 resume 能重建同一 checkpoint 脈絡，且 `config.configurable` 於 interrupt／resume 間可存取」。此為 D／V 支持但**尚未取得 L（正式部署）證據**的假設；本 Change 以 deterministic test + mock integration 證明契約，live 驗證另列於 tasks，不宣稱正式部署已證實。

### Approval handle、通知與 resume transport

本 Change 沿用現有 transport，不新增平行 BFF endpoint：Agent Server 產生的 interrupt SSE 由既有 `/api/langgraph/*` proxy 原樣透傳；受信控制 client 以同一 thread 與既有 run submission transport 送出 `Command({ resume })`。BFF 仍執行 authentication、strip client `x-bff-*` 並覆寫 canonical identity/scope headers。

- `approvalId` 由 backend 以 CSPRNG 產生至少 256-bit entropy，作為一次性 opaque correlation handle；它不是 bearer credential，單獨持有不得授權。批准必須同時通過 BFF trusted principal、tenant/scope、runId、decisionId、resource、policyVersion、expiry 與 allowed-approver policy 驗證。
- interrupt public payload 只含 UI／operator 判斷所需的 redacted summary、`approvalId` 與 correlation；MUST NOT 含 raw API key、identity token、grant credential 或未遮罩 Tool input。`approvalId` 可隨 checkpoint／pending record 持久化，因 authorization 仍由受信身份與 server-side atomic state 決定。
- resume payload 為 versioned discriminated union：`{ type: "tool_authorization_confirmation", schemaVersion: "1.0", approvalId, decisionId, decision: "approve" | "deny" }`。principal、tenant、scope、run/resource binding 一律取自 server-side pending record與 BFF canonical headers，不信任 body 重複欄位。
- one-time 語意由 persistent store 的 atomic compare-and-set（`pending` → `approved`／`denied`／`expired`）實現；replay 或競態只有第一個合法 transition 成功，其餘拒絕並 audit。
- frontend 已能承接 unknown interrupt 並透過 LangGraph SDK 提交 `command.resume`；本 Change 只凍結 authorization interrupt/resume schema 與 BFF passthrough contract，不新增 user-facing authorization approval component。正式 UI、文案與可存取性由後續 Change 處理；本 Change 的驗收 client 是經 BFF 認證的 trusted operator／integration harness。

### decision → ToolExecution 連結

- 授權決策於 dispatch 前 `decisionStore.record`；side-effect `tool_executions` 記錄 `decisionId`。
- deny／timeout／`AUTHORIZATION_UNAVAILABLE` 不進入 X2 Retry Budget。

## 分層設計

### backend

1. 新增 `createToolAuthorizationConfig` composition root（含 production `ToolRiskPolicy` 組裝）。
2. 改 `loadAgentTools`／`loadMcpTools` 注入 authorization config；未供應 config 的 production 路徑由 architecture test 擋下。
3. 擴充 `backend/langgraph.json` `configurable_headers.includes`，加入必要 trusted `x-bff-*` headers（principal 七欄位 + `x-bff-scope-id`／`x-bff-scope-type`）；維持 scalar string schema，不加入 array／JSON transport。
4. 新增 authorization gate node／confirmation node／physical dispatch node adapter：governance 回傳 descriptor，只有 confirmation node 呼叫 `interrupt()`。
5. 新增 durable waiting 與 approval store atomic consume，並以既有 Agent Server `Command({ resume })` transport 完成一次性 scoped resume。
6. 連結 `decisionId` → `tool_executions`。
7. architecture test：未經 composition root 的 protected Tool dispatch 不得存在；未註冊 production Tool、無明確 `policyVersion` 或無 MCP risk descriptor 不得放行。

### bff

1. `PrincipalResolver` 成功結果補 required `activeScope`，並在 authentication source config 邊界驗證；禁止從 permission `scopes[]` 猜測。
2. `copyRequestHeaders` 補 `x-bff-scope-id`／`x-bff-scope-type`（只由 resolver 的 active scope projection 取得）。
3. 以 `node:test`／`vitest` 補回歸：client 偽造 `x-bff-*`／`x-user-id`／`x-tenant-id` 不轉送；resolver 值覆寫；多 permission scopes 不影響 active scope；缺失／衝突 active scope fail-closed。
4. 以既有 wildcard proxy 原樣透傳 authorization interrupt SSE 與 `Command({ resume })` request，不解析或重寫 domain payload。

## 相容性設計

1. **既有 headers**：4 個 correlation header 語意不變；新增 `x-bff-*` 白名單為 additive。
2. **既有 error-code 語意不變**：`denied_by_authorization` 為既有 typed outcome，不改變既有 `TOOL_DISABLED_BY_POLICY`／`TOOL_INPUT_TOO_LARGE` 等語意。
3. **development 相容**：development 讀預設經 explicit profile 維持可用；不因接線而拒絕既有 development 流程。
4. **interrupt/resume transport**：沿用既有 LangGraph SDK 與 `/api/langgraph/*` proxy；新增 payload variant 為 additive，unknown client 可安全降級。
5. **不變更 Graph ID／公開 BFF route**。

## 資料流

```text
Browser／trusted control client → BFF（PrincipalResolver 自 authentication source 解析 trusted identity + active scope；strip client identity；覆寫 canonical x-bff-*）
  → LangGraph Agent Server（configurable_headers 白名單放行 trusted x-bff-*）
  → backend readExecutionContext（X12 adapter 解析 principal/scope）
  → applyToolGovernance（createToolAuthorizationConfig 注入）
    → ToolRiskRegistry.classify（未註冊 production → deny）
    → AuthorizationEngine.authorize（tenant/scope/role/action/ownership/grant/contextual limits）
    → decisionStore.record（先於 dispatch）
    → allow → dispatch；deny/timeout/unavailable → denied_by_authorization（不重試）
    → require_confirmation descriptor → authorization_confirmation node interrupt + durable waiting
      → same-thread Command(resume) → trusted identity + atomic approval 驗證 → dispatch/deny
```

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 各 Tool 自行做 authorization（現況） | 零成本 | production 未受保護，違反 X11 Invariant #7，不採用 |
| 在 `applyToolGovernance` 內直接 new 各 store | 少一個 factory | 組裝邏輯散落、難以單一來源 policy version／profile，不採用 |
| composition root factory（本方案） | 單一組裝點 + feature flag | 需改 registry 注入；以 architecture test 守護 |
| 用 memory-only HITL（不接 interrupt） | 省持久化 | 不滿足「敏感動作跨 restart 存活」，不採用 |
| durable confirmation 併入 X20 | 省一次契約變更 | X20 是完整 crash-safe recovery，範圍大；X13 先做 confirmation 的 durable waiting，正交分離較可獨立驗證 |

## 風險與緩解

- **白名單被直連偽造**：Agent Server 只經 BFF（network 邊界），backend 只消費 canonical `x-bff-*`，白名單只加必要 header。
- **接線後誤拒 development**：explicit development profile 控制 read default；環境未知 fail-closed。
- **durable confirmation 依賴未驗證的 checkpoint 行為**：標記「基於未驗證假設」，deterministic + mock 證明契約，live 另列。
- **決策持久化失敗被誤當放行**：`record` 先於 dispatch，失敗即 deny/defer；fault-injection test。
- **跨層 header 契約漂移**：contract fixture 單一來源；bff／backend 全量驗證。
- **approvalId 被誤當 bearer credential**：單獨持有不得授權；BFF trusted principal + server-side binding + atomic consume 為真正 authorization boundary，payload 與 log 只保留 redacted data。
- **MCP server metadata 提權**：本 Change 不信任 server 自述 risk；只有 composition-root versioned config 可授權，未知或非法 descriptor default deny。
