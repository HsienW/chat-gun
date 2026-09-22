# trusted-tool-authorization Specification

## Purpose
TBD - created by archiving change wire-trusted-identity-authorization-hitl. Update Purpose after archive.
## Requirements
### Requirement: Agent Server trusted-header allowlist MUST 只放行 BFF 產出的 canonical trusted headers

Agent Server 的 `http.configurable_headers.includes` MUST 只加入必要、由 BFF 產出的 canonical trusted `x-bff-*` headers（principal 七欄位與 active scope 投影），MUST NOT 開放任何 client 可直連偽造的 raw identity header（`x-user-id`、`x-tenant-id` 等）。

#### Scenario: 只放行 canonical trusted headers

GIVEN Agent Server 的 `configurable_headers` 白名單已擴充
WHEN 檢查白名單內容
THEN 白名單 MUST 只含 BFF 產出的 canonical `x-bff-*` headers
AND MUST NOT 含 raw client identity header（`x-user-id`、`x-tenant-id`）
AND 既有 4 個 correlation header MUST 維持不變

#### Scenario: backend 只消費 canonical trusted headers

GIVEN 一個 client 企圖以 raw header 偽造 identity
WHEN backend 解析 `PrincipalContext` 與 active `RuntimeScope`
THEN MUST 只自 canonical `x-bff-*` headers 讀取
AND MUST NOT 自 `x-user-id`／`x-tenant-id` 等 raw header 讀取 identity

---

### Requirement: BFF MUST strip client-supplied internal identity headers 並以 trusted resolver 覆寫

BFF MUST strip client 提供的 internal identity header，並由 `PrincipalResolver` 自核准 authentication source 解析後覆寫 canonical trusted headers（含 active scope projection）。

#### Scenario: 偽造 client identity header 不影響 trusted principal

GIVEN client 請求攜帶偽造的 `x-user-id`、`x-tenant-id` 或 `x-bff-principal-id`
AND BFF 已配置 production `PrincipalResolver`
WHEN BFF 產生上游 headers
THEN 上游 MUST 只帶 resolver 導出的 canonical trusted headers
AND MUST NOT 轉送 client 提供的 raw `x-user-id`／`x-tenant-id`／`x-bff-*`
AND `x-bff-principal-id`／`x-bff-tenant-id` MUST 以 resolver 值覆寫

#### Scenario: active scope projection 由 BFF 產出

GIVEN BFF 解析 trusted context 且具備 active scope
WHEN BFF 產生上游 headers
THEN MUST 寫入 `x-bff-scope-id` 與 `x-bff-scope-type`
AND `x-bff-scope-id`／`x-bff-scope-type` MUST 由 trusted resolver 導出
AND MUST NOT 採 client 提供的 scope 值

#### Scenario: 多個 permission scopes 不得被猜成 active scope

GIVEN trusted principal 具有多個 permission scope strings
AND authentication source 明確提供唯一 active scope
WHEN BFF 解析 trusted context
THEN active scope MUST 只取自同一 authentication source 的明確 active scope
AND MUST NOT 依 permission scopes 的順序、字串內容或預設優先表選取

#### Scenario: permission scopes 與 active scope 使用明確 scalar encoding

GIVEN Agent Server configurable headers 只接受 scalar string
WHEN BFF 投影 trusted principal 與唯一 active scope
THEN permission scopes MUST 以 canonical CSV string 寫入 `x-bff-scopes`
AND 每個 permission scope token MUST 非空且不得包含逗號
AND active scope MUST 分別以單值 `x-bff-scope-id` 與 `x-bff-scope-type` 傳遞
AND MUST NOT 將多個 active scope、array 或 JSON 寫入該兩個 header
AND backend MUST 能無損還原 permission scopes 與唯一 active scope

#### Scenario: active scope 缺失或衝突時 fail-closed

GIVEN authentication source 未提供 active scope 或提供互相衝突的 active scope
WHEN BFF 解析 protected request
THEN identity resolution MUST 失敗且不得 proxy protected request
AND MUST NOT 退回第一個 permission scope、tenant default 或 anonymous scope

---

### Requirement: 每個 protected Tool action MUST 於 dispatch 前通過 production authorization composition root

production Tool registry MUST 透過單一 composition root 組裝 `ToolRiskRegistry`、`AuthorizationEngine`、persistent `DecisionStore`、`resourceRefResolver`、versioned policy identity 與 durable confirmation bridge，並注入 `applyToolGovernance`；MUST NOT 存在未經 authorization 的 production dispatch 路徑。

#### Scenario: allow 才 dispatch

GIVEN authorization 回傳 allow
WHEN 執行受保護 Tool action
THEN MUST 繼續 dispatch 下游 Tool

#### Scenario: deny 不 dispatch 且回傳 typed outcome

GIVEN authorization 回傳 deny
WHEN 執行受保護 Tool action
THEN MUST 回傳 `denied_by_authorization` typed outcome
AND MUST NOT dispatch 下游
AND 上層 Runner MUST 不需解析錯誤字串即可分類該 outcome

#### Scenario: 未註冊 production Tool 於 invocation 前 deny

GIVEN 一個未註冊 `ToolRiskPolicy` 的 production Tool
WHEN 執行
THEN MUST 於 invocation 前回傳 deny（`UNREGISTERED_TOOL_DENIED`）
AND MUST NOT dispatch

#### Scenario: MCP risk descriptor 缺失或非法時 deny

GIVEN 一個 MCP Tool 沒有由受信 composition root 提供合法且 versioned 的 risk descriptor
OR descriptor schema/version 無法識別
WHEN production registry 載入或 invocation 該 Tool
THEN 該 Tool MUST 視為未註冊並於 dispatch 前 deny
AND MCP server 自述的 description／annotations MUST NOT 提升其權限

#### Scenario: production policy version 必須明確供應

GIVEN production composition root 啟用
WHEN 建立 authorization governance config
THEN policy version MUST 由 composition root 明確供應
AND MUST NOT 靜默採用 optional fallback

#### Scenario: development read default 需 explicit profile

GIVEN 需未註冊 Tool 採 read default
WHEN 判斷是否放行
THEN MUST 由明確的 development profile／feature flag 啟用
AND MUST NOT 由「缺 identity」或 production 環境反向推斷為放行
AND `NODE_ENV=development` 本身 MUST NOT 視為 authorization opt-in

---

### Requirement: 缺 trusted identity 或 active scope MUST 於 dispatch 前 deny（fail-closed）

production 下，`PrincipalContext` 或 active `RuntimeScope` 缺失、無效或解析失敗時，protected execution MUST deny，MUST NOT 以 development identity、anonymous 或空值補齊為已驗證身份。

#### Scenario: 缺 principal 時 deny

GIVEN 一個受保護 Tool action
AND 請求缺 trusted principal（或 principal 解析失敗）
WHEN 執行 authorization
THEN MUST 回傳 deny（`AUTHORIZATION_UNAVAILABLE` 或對應缺失 reason code）
AND MUST NOT dispatch

#### Scenario: 缺 active scope 時 deny

GIVEN 一個受保護的 write action
AND 請求未提供明確 active scope（`scopeId` 為空）
WHEN 執行 authorization
THEN MUST 回傳 deny（`MISSING_ACTIVE_SCOPE`）
AND MUST NOT 放行

#### Scenario: 跨 tenant resource 存取於 dispatch 前 deny 並 audit

GIVEN principal 屬於 tenant `T1`
AND 其嘗試對 tenant `T2` 的 resource 執行 action
WHEN 執行 authorization
THEN MUST 於 dispatch 前回傳 deny（`CROSS_TENANT_DENIED`）
AND MUST 寫入 `permission_decisions` audit 紀錄
AND MUST NOT 呼叫下游 Tool

---

### Requirement: require_confirmation MUST 轉為 serialized LangGraph interrupt + persisted Task/Step waiting state

`require_confirmation` MUST 進入 serialized LangGraph `interrupt()`，並持久化 waiting state（決策、Run/Task/Step correlation、expiry、authorization scope、resume compatibility manifest），使等待狀態可跨 process restart 存活。

#### Scenario: 敏感動作進入 durable interrupt 等待

GIVEN 一個 `require_confirmation` 決策
WHEN 進入確認流程
THEN MUST 產生 serialized LangGraph `interrupt()`
AND MUST 持久化 waiting state（決策、correlation、expiry、scope、resume manifest）
AND MUST NOT dispatch 下游 Tool

#### Scenario: governance descriptor 由 graph node 轉為 interrupt

GIVEN governance 判定 action 為 `require_confirmation`
WHEN confirmation 流程開始
THEN governance 層 MUST 先回傳可序列化的 typed `confirmation_required` descriptor
AND 只有具 checkpoint context 的 graph node MAY 呼叫 `interrupt()`
AND lower-level governance hook MUST NOT 直接假設或建立 graph runtime context

#### Scenario: interrupt 與 resume 沿用既有 transport

GIVEN authorization confirmation 進入 interrupt
WHEN BFF 代理 Agent Server stream 與後續 resume request
THEN interrupt event MUST 由既有 LangGraph proxy 原樣傳遞至受信控制 client
AND resume MUST 以同一 thread 脈絡的 `Command({ resume })` 經既有 proxy 提交
AND BFF MUST 重新驗證 request identity 並覆寫 canonical trusted headers
AND MUST NOT 需要新增平行的公開 resume route

#### Scenario: 確認成功後才 dispatch

GIVEN 一個 `require_confirmation` 決策已進入 HITL
AND 使用者（或受信控制路徑）確認放行
WHEN 決策被確認
THEN 才允許 dispatch 下游 Tool
AND 決策 effect MUST 更新為 allow（`CONFIRMATION_APPROVED`）

#### Scenario: 確認逾時視為 deny

GIVEN 一個 `require_confirmation` 決策等待確認
AND 等待超過政策上限
WHEN 逾時觸發
THEN MUST 視為 deny（`CONFIRMATION_TIMEOUT`）
AND MUST NOT dispatch 下游

#### Scenario: 確認取消視為 deny

GIVEN 一個 `require_confirmation` 決策等待確認
AND 使用者取消
WHEN 取消觸發
THEN MUST 視為 deny（`CONFIRMATION_CANCELLED`）
AND MUST NOT dispatch 下游

#### Scenario: 確認持久化失敗不得宣稱 durable 亦不得 dispatch

GIVEN 一個 `require_confirmation` 決策
AND waiting state 持久化失敗
WHEN 進入確認流程
THEN MUST NOT 宣稱該 interrupt 為 durable
AND MUST NOT dispatch 下游 Tool

---

### Requirement: resume MUST 為一次性、scoped，且 Agent MUST NOT 自我批准

confirmation resume MUST 只接受一次性、scoped 的確認決策；一次性 `approvalId` MUST 由具足夠 entropy 的 server-side source 產生，但不得作為單獨即可授權的 bearer credential。批准 MUST 同時驗證 trusted principal、tenant/scope、Run、decision、resource、policy version 與 expiry，並以 persistent atomic transition 消耗。Agent MUST NOT 存在可批准自己 HITL 請求的 callable 路徑。expired、replayed、cross-tenant、mismatched-Run 或 mismatched-resource 的 approval MUST 拒絕並 audit。

#### Scenario: approvalId 重用被拒

GIVEN 一個已完成 atomic consume 的 approvalId
WHEN 以同一 approvalId 再次 resume
THEN MUST 拒絕
AND MUST audit

#### Scenario: approvalId 單獨持有不得批准

GIVEN resume request 提供有效且未使用的 approvalId
AND request 的 trusted principal、tenant/scope 或 allowed-approver policy 不符合 pending confirmation
WHEN 執行 resume
THEN MUST 拒絕
AND MUST NOT dispatch
AND MUST audit

#### Scenario: 過期 approval 被拒

GIVEN 一個已過期的 confirmation waiting state
WHEN 企圖 resume 放行
THEN MUST 拒絕並視為 deny（`CONFIRMATION_TIMEOUT`）
AND MUST NOT dispatch

#### Scenario: mismatched-Run 或 mismatched-resource approval 被拒

GIVEN 一個 resume 請求的 `runId` 或 resource 與原 waiting state 不符
WHEN 執行 resume
THEN MUST 拒絕
AND MUST NOT dispatch
AND MUST audit

#### Scenario: Agent 無法自我批准

GIVEN 一個由 Agent 觸發的 `require_confirmation` 決策
WHEN Agent 嘗試自行批准該請求
THEN MUST NOT 存在 Agent-callable Tool 可完成自我批准
AND 批准 MUST 由受信控制路徑（或人類）完成並分開 audit

---

### Requirement: authorization decision MUST 於 dispatch 前持久化並連結 ToolExecution

每個 authorization 決策 MUST 於 dispatch 前寫入 `permission_decisions`，並以 `decisionId` 關聯至該 `tool_executions`；未通過 authorization 的 action MUST NOT dispatch。

#### Scenario: 授權決策先於副作用 dispatch 且被記錄

GIVEN 一個受保護 Tool 即將 dispatch
WHEN 執行 authorization
THEN decision MUST 在 dispatch 前持久化
AND 對應 `tool_executions`（若為 side-effect）MUST 記錄 `decisionId`
AND 決策為 deny 或未通過時 MUST NOT dispatch

#### Scenario: 授權決策可依 toolExecutionId 查詢

GIVEN 一個 side-effect ToolExecution 已 dispatch
AND 其 dispatch 前通過 authorization
WHEN 查詢該 execution 的決策
THEN MUST 能依 `toolExecutionId` 找到對應 `permission_decisions` 紀錄

---

### Requirement: authorization deny／timeout／unavailable MUST NOT 進入 retry logic

`deny`、`denied_by_authorization`、確認 timeout 與 authorization unavailable MUST NOT 進入 X2 Retry Budget；只有非授權的可重試錯誤（如 `failed_not_committed`）才可重試，且重試前 MUST 重新評估 authorization。

#### Scenario: 授權拒絕不觸發重試

GIVEN 一個 Tool 因 authorization 被 deny（`denied_by_authorization`）
WHEN 上層 Runner 處理該 outcome
THEN MUST NOT 建立新的 physical attempt
AND MUST NOT 進入 X2 Retry Budget

#### Scenario: authorization unavailable 不觸發重試

GIVEN authorization 資料庫 unavailable
WHEN 執行 protected dispatch
THEN MUST deny／defer 且不 dispatch
AND MUST NOT 進入 retry logic

#### Scenario: 非授權可重試錯誤仍可重試但重估 authorization

GIVEN 一個 `failed_not_committed` outcome（下游未 commit）
AND X2 Retry Budget 允許
WHEN 上層 Runner 處理
THEN MUST 仍可重試
AND 重試前 MUST 重新評估 authorization

---

### Requirement: raw credential 與 authorization token MUST NOT 被持久化或 log

authorization 決策、audit 與 trace MUST 只存 redacted summary；raw identity token、credential、API key、unmasked PII MUST NOT 被持久化或 log。

#### Scenario: raw identity token 不寫入決策紀錄

GIVEN 一個授權決策的 context 可能含 raw identity token 或 credential
WHEN 持久化 `permission_decisions`
THEN MUST 只存 redacted summary 與 opaque ID
AND MUST NOT 存 raw token、credential 或 unmasked PII
AND 可持久化的 approvalId MUST NOT 具備單獨授權能力
