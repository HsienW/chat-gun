# Proposal：wire-trusted-identity-authorization-hitl

## 變更摘要

把既有的 `PrincipalContext`／`RuntimeScope`／`PermissionGrant`／`AuthorizationDecision`／`ToolRiskPolicy`／`AuthorizationHitlBridge` 原語，從「已存在且有 unit test、但 production 未接線」的狀態，轉為**每個受保護 Tool action 在 production 的強制授權邊界**：建立一個 production Tool authorization composition root，讓所有 Agent Tool 的 dispatch 都先通過「trusted identity 解析 → scope authorization → persistent decision 記錄 → durable confirmation（LangGraph interrupt）」這條路徑；未註冊的 production Tool 預設 deny、缺 trusted identity 時 fail-closed、`require_confirmation` 轉為可跨 process 重啟存活的 serialized interrupt。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X13**，是 Layer 4（Runtime Integration Foundation）的第三個 Change；前置 X12（`add-canonical-execution-context`）已 archive，`ExecutionContext` 的 `principal`／`scope` 解析介面（`readExecutionContext`、`readTrustedIdentity`）已就緒，但依 X12 Design §MAJ-1 仲裁，`configurable_headers` 白名單擴充與「缺 identity 時 deny protected execution」的 production authorization boundary **刻意留待本 Change（X13）** 完成。

> 前置約束（X11 Decision Record §決策）：本 Change 涉及「`require_confirmation` 的 durable persistence」與「Agent Server `config.configurable` 於 interrupt／resume 間的行為」，若設計假設依賴「Agent Server 會完整持久化 `config.configurable`」或「interrupt 後 resume 能重建同一 checkpoint 脈絡」，MUST 於 design 標記「基於未驗證假設」，直到後續 Change 取得 L（正式部署）證據。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時）：

1. **production Tool registry 呼叫 `applyToolGovernance()` 不帶 authorization config**：`backend/src/tools/registry.ts:34` 與 `backend/src/tools/mcp-loader.ts:310` 都呼叫 `applyToolGovernance([...tools])` 而不傳入第二參數。`ToolAuthorizationGovernanceConfig`（`tool-governance.ts:77-98`，含 `riskRegistry`／`authorizationEngine`／`decisionStore`）的接線面已存在，但 production 從未供應，故所有 Agent Tool 目前**不經任何 authorization 就 dispatch**。

2. **Agent Server `configurable_headers` 白名單不含 trusted identity**：`backend/langgraph.json` 的 `http.configurable_headers.includes` 只有 4 個 correlation header（`x-request-id`、`x-idempotency-key`、`x-active-run-id`、`x-active-run-generation`），不含任何 `x-bff-*` trusted identity header。因此 `parseTrustedPrincipal`（`runtime/authorization/principal.ts:109`，自 `config.configurable` 讀取）在 production 永遠看不到 trusted identity。

3. **沒有任何 production Tool 宣告 `ToolRiskPolicy`**：`backend/src/tools/`（calculator、weather、web-fetch、web-search、mcp）無 `riskTier`／`actions`／`resourceRefResolver`／`requireConfirmation` 宣告；`ToolRiskRegistry` 只在 unit test 被 exercise。

4. **沒有 production composition root 組裝授權堆疊**：`ToolRiskRegistry`、`AuthorizationEngine`、`PgDecisionStore`（含 `ContextRedactor`）、`PgGrantStore`、`AuthorizationHitlBridge` 均已存在且有測試，但沒有任何 factory 把這些組進 `loadAgentTools` 的 dispatch 路徑。

5. **backend 完全沒有 `interrupt()` 呼叫**：grep `interrupt(` 於 `backend/src` 為零命中。`AuthorizationHitlBridge`（`tool-risk.ts:169`）只在記憶體內把 Task 轉為 `waiting_confirmation`，`onRequireConfirmation`（`tool-governance.ts:94-97`）只是空 hook；`authorizeToolDispatch` 遇到 `require_confirmation` 時只記錄決策並回傳 `denied_by_authorization`（`tool-governance.ts:483-508`），**沒有 serialized interrupt、沒有 durable waiting state、沒有 resume 路徑**。

6. **active `RuntimeScope` 投影缺口**：`readTrustedIdentity`（`runtime/execution-context/read-execution-context.ts:131-185`）自 `x-bff-scope-id`／`x-bff-scope-type` 解析 active `RuntimeScope`，但 BFF `copyRequestHeaders`（`bff/src/server.ts:340-396`）只寫 `x-bff-scopes`（scopes 清單），**不寫** `x-bff-scope-id`／`x-bff-scope-type`。故 backend 無法得到 active scope 的 scopeId／scopeType，授權引擎的 `MISSING_ACTIVE_SCOPE` 保護在 production 無法被正確觸發（scope 欄位永遠缺）。

7. **BFF strip／overwrite 行為已大致就緒**：`copyRequestHeaders` 只轉送 `FORWARDED_REQUEST_HEADERS`（8 個 header，`server.ts:60-69`），client 提供的 `x-bff-*`／`x-user-id`／`x-tenant-id` 不在轉送清單內，且 `x-bff-*` 一律以 trusted resolver 值覆寫（`server.ts:362-368`）。「strip client-supplied internal identity header」這一段已在 X12／`add-runtime-identity-permission-governance` 完成，本 Change 補上 active scope projection 與回歸證明。

綜合而言，授權原語「看起來存在、單元測試也過」，但 production dispatch 路徑**完全繞過**它們。這正是 X13 issue 所述「Existing authorization tests therefore do not prove that production Tools are protected」的根因，也違反 AGENTS.md「不得以 Prompt／固定分支掩蓋不存在的權限能力」與 X11 Cross-Layer Invariant #7（「Missing identity, authorization, ledger, or mandatory policy dependencies fail closed in production」）。

## 解決方案

以「單一 production composition root + 單一 trusted-header 邊界 + 單一 durable confirmation 橋」收斂：

1. **建立 production Tool authorization composition root**：新增一個 factory，組裝 `ToolRiskRegistry`（含每個 production Tool 的 `ToolRiskPolicy`）、`AuthorizationEngine`（接 `PgGrantStore` + policy resolver + scope-access resolver）、`DecisionStore`（`PgDecisionStore` + `ContextRedactor`）、`resourceRefResolver`、versioned policy identity，與 durable confirmation bridge，產出一個 `ToolAuthorizationGovernanceConfig` 注入 `applyToolGovernance`。

2. **每個 production Tool 宣告 `ToolRiskPolicy`**：為 calculator／weather／weatherForecast／web-fetch／web-search／MCP 宣告 `riskTier`、`actions`、`resourceRefResolver` 與 `requireConfirmation`；單一 registry 組裝點，runtime MUST NOT 以 tool 名稱硬編碼 risk tier。

3. **未註冊 production Tool 預設 deny；development read 預設需 explicit development profile**：`ToolRiskRegistryConfig.unregisteredToolDefault` 在 production 固定 `deny`；development 的 read default 只能由明確的 development profile／feature flag 啟用，不得由「缺 identity」反向推斷。

4. **擴充 Agent Server `configurable_headers` 白名單**：只加入必要的 trusted `x-bff-*` headers（含 `x-bff-scope-id`／`x-bff-scope-type`），並維持既有 scalar string transport。permission `scopes[]` 只透過既有 `x-bff-scopes` CSV string 傳遞；唯一 active `RuntimeScope` 只投影為單值 `x-bff-scope-id` 與 `x-bff-scope-type`，不傳 array／JSON，使 `readTrustedIdentity` 能在 production 解析 `PrincipalContext` 與 active scope。

5. **BFF 補 active scope resolution 與 projection**：`PrincipalResolver` 必須從同一個核准 authentication source 明確回傳唯一 active scope，禁止從 permission `scopes[]` 猜測；`copyRequestHeaders` 再投影為 `x-bff-scope-id`／`x-bff-scope-type`，並以 test 證明缺失／衝突 scope fail-closed，且 client 無法偽造／覆寫 trusted identity 與 scope。

6. **`require_confirmation` 轉為 serialized LangGraph interrupt + persisted Task/Step waiting state**：governance 先回傳可序列化 `confirmation_required` descriptor，再由專用 graph node 進入 LangGraph `interrupt()`；持久化 waiting state（決策、Run/Task/Step correlation、expiry、scope、resume compatibility manifest），避免 lower-level hook 假裝持有 graph context。

7. **一次性 scoped resume**：沿用既有 BFF `/api/langgraph/*` proxy 與 Agent Server `Command({ resume })` transport；以一次性 high-entropy `approvalId`、BFF trusted principal 與 server-side pending record 共同驗證。`approvalId` 單獨持有不得授權；Agent MUST NOT 自批准；expired／replayed／cross-tenant／mismatched-Run／mismatched-resource 的 approval MUST 拒絕並 audit。

8. **決策於 dispatch 前持久化並連結 ToolExecution**：`decisionStore.record` 先於 dispatch，`tool_executions` 記錄對應 `decisionId`；deny／timeout／`AUTHORIZATION_UNAVAILABLE` MUST NOT 進入 X2 Retry Budget。

## 受影響範圍

### 受影響套件

- `backend`：production authorization composition root、production `ToolRiskPolicy` 宣告、`configurable_headers` 白名單、LangGraph interrupt-based durable confirmation、一次性 scoped resume、decision→ToolExecution 連結、architecture test。
- `bff`：active scope resolution／projection（`x-bff-scope-id`／`x-bff-scope-type`）與 strip／overwrite 回歸證明。

### 受影響能力域

- 執行身份與 authorization（trusted identity、scope authorization、grant、decision persistence）。
- Tool dispatch（`applyToolGovernance` 的 authorization 接線）。
- HITL／confirmation（LangGraph interrupt、durable waiting、scoped resume）。

### 既有能力原語（本 Change 接線、不重造）

- `PrincipalContext`／`parseTrustedPrincipal`、`RuntimeScope`、`ResourceRef`、`PermissionGrant`、`AuthorizationEngine`／`evaluateAuthorization`、`ToolRiskRegistry`／`AuthorizationHitlBridge`、`DecisionStore`／`PgDecisionStore`／`ContextRedactor`、`GrantStore`／`PgGrantStore`（`add-runtime-identity-permission-governance`）。
- `ExecutionContext`／`readExecutionContext`／`readTrustedIdentity`（`add-canonical-execution-context`，X12）。
- `GovernedToolExecutor`／`ToolAuthorizationGovernanceConfig`（`add-side-effect-tool-execution-runtime` 已預留 authorization 接線面）。

## 目標

- 偽造的 client tenant/user header MUST NOT 覆蓋 BFF trusted identity。
- 未註冊的 production Tool MUST 於 invocation 前 deny。
- 跨 tenant resource 存取 MUST 於 dispatch 前 deny 並 audit。
- 敏感動作等待確認期間 MUST 能跨 process restart 存活（durable waiting）。
- 核准後的動作 resume 恰一次，並將 `decisionId` 連結至 `ToolExecution`。
- deny／timeout／authorization unavailable MUST NOT 進入 retry logic。
- raw credential 或 authorization token MUST NOT 被持久化或 log。
- backend 與 bff 的測試涵蓋 allow、deny、confirm、timeout、restart、replay、cross-tenant。

## 非目標

- ❌ 不新增 Agent-callable 的 grant 建立、自我提升、冒充或自我批准 Tool。
- ❌ 不提供 anonymous production fallback。
- ❌ 不依 Tool display text 或 model prose 做 authorization 決策。
- ❌ 不變更既有 Graph ID、公開 BFF route 或既有 error-code 語意。
- ❌ 不在本 Change 建立 X14 的統一 Tool dispatch pipeline（X13 只把 authorization 邊界接上既有 `applyToolGovernance`）。
- ❌ 不在本 Change 完成 X20 的完整 crash-safe recovery 與 resume sanitization（本 Change 只做 confirmation 的 durable waiting 與 scoped resume）。
- ❌ 不修改正式 Agent Server PG／Redis 持久化行為（durable confirmation 的持久化行為假設標記「基於未驗證假設」）。
- ❌ 不新增平行 BFF resume route；interrupt SSE 與 `Command({ resume })` 沿用既有 `/api/langgraph/*` transparent proxy。
- ❌ 不在本 Change 新增 user-facing authorization approval UI；本 Change 凍結 payload／resume contract，並以經 BFF 認證的 trusted operator／integration harness 驗收。正式 UI 由後續 Change 處理。

## 風險

| 風險 | 緩解 |
|---|---|
| 擴充 `configurable_headers` 白名單若被 client 直連 Agent Server 偽造 trusted identity | Agent Server 只經 BFF 進入（network 邊界），並以 test 證明 backend 只消費 canonical `x-bff-*`；白名單只加必要 header，不開放 raw identity |
| production Tool 接上 deny 後，既有 development 流程被誤拒 | development 採 explicit development profile／flag 啟用 read default；未明確判定環境時 fail-closed，不採 development identity 補齊 |
| durable confirmation 依賴 Agent Server interrupt／checkpoint 持久化行為未經 L 驗證 | 遵循 X11 約束，相關假設標記「基於未驗證假設」；以 deterministic test + mock integration 證明契約，live 驗證另列 |
| 授權決策持久化失敗被誤當放行 | `DecisionStore.record` 於 dispatch 前執行；失敗即 deny/defer，不 dispatch；以 fault-injection test 證明 |
| 跨層契約不一致（bff scope header ↔ backend scope 解析） | 以 contract fixture 單一來源；bff／backend 全量 test 執行 |
| `approvalId` 被誤當作 bearer credential | 單獨持有不得授權；必須同時驗證 BFF trusted principal、tenant/scope、run/resource、expiry 與 atomic pending state |
| MCP server 自述 risk 造成提權 | 本 Change 只接受 composition-root versioned config；缺失、非法或未知版本 default deny，不信任 server description／annotations 提權 |

## 回滾策略

本 Change 為「接線」型變更：production composition root 與 `configurable_headers` 白名單為 additive，可透過 feature flag／profile 獨立停用回到「`applyToolGovernance` 不帶 authorization config」的既有行為；`x-bff-scope-id`／`x-bff-scope-type` 為 additive header，不變更既有 header 語意；durable confirmation 橋在未接 interrupt 前不影響既有「denied_by_authorization」終態。若實作驗證失敗，可逐套件 revert，不影響既有系統行為，亦不回退資料庫 schema 歷史（`permission_decisions`／`permission_grants` 早已存在）。
