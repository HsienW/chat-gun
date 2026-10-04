# Proposal：sandbox-secret-broker-and-egress-policy

## 變更摘要

在 **OS 與網路邊界** 收斂 Tool 執行，同時保留 v4 authorization 模型、並防止 credential 進入 model context 或 durable runtime state。以「versioned execution profile + pluggable sandbox runner + `SecretBroker` opaque reference + 集中 egress policy」四件事建立 enforcement seam，插入統一 dispatch pipeline 的 authorization 之後、實際執行之前；**任何 profile 缺失、版本不支援、runner capability 不足、secret reference 無法解析、或 egress policy 無法執行的情況，一律 fail-closed，不得降級為 host／in-process 執行**。

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X25**，是 Second Stage — Layer 8（Production Product Foundation）Wave 2 的 Change；前置 X13（`wire-trusted-identity-authorization-hitl`／`runtime-identity-permission-governance`）、X14（`establish-unified-tool-dispatch-pipeline`／`side-effect-tool-execution-runtime`）、X16（`add-tool-scheduling-and-resilience-policy`）、X21（`enforce-runtime-production-readiness-gate`）、X22（`consumer-identity-and-account-lifecycle`）已 archive。X25 在 **不建立第二個 runtime、第二條 authorization 路徑、或 UI-only 的 durable state 近似** 前提下，把既有「授權後直接執行」的路徑升級為「授權 → profile 解析 → sandbox capability 匹配 → 最終執行端 secret 解析 → egress 強制 → 執行 → audit evidence」。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，唯讀盤點，file:line 為建立時快照）：

1. **Tool manifest 無 sandbox／egress／secret 欄位**：native tool 皆以 LangChain `tool(fn, { name, description, schema })` 定義（`backend/src/tools/calculator.ts:24`、`web-search.ts:139`、`web-fetch.ts:238`、`weather.ts:728/:1031`），manifest 本體只有 `name/description/schema`。version 只存在於 `LOCAL_RUNTIME_TOOL_VERSION = "1.0"`（`backend/src/tools/production-runtime-tool-descriptors.ts:26`）與 MCP risk descriptor 的 `MCP_TOOL_RISK_DESCRIPTOR_VERSION = "1.0"`（`backend/src/tools/authorization/mcp-risk.ts:8`），不在 tool 描述本體上。

2. **`RuntimeToolDescriptor` 無 execution-profile／egress／secret 維度**：`backend/src/runtime/tool-dispatch/runtime-tool-descriptor.ts:45-59` 完整欄位為 `toolName/toolVersion/inputSchema/outputSchema/riskTier/isReadOnly/isConcurrencySafe/timeoutPolicy/retryPolicy/rateLimitPolicy?/circuitBreakerPolicy?/interruptBehavior/sideEffect?`；`RuntimeToolDispatchPipelineDependencies`（`runtime/tool-dispatch/pipeline.ts:103-118`）亦無 sandbox/egress/secret dependency。grep `sandbox|execution-profile|secret-broker|egress` 在 `backend/src` 無真實概念（僅 `regression` 子字串誤配）。

3. **統一 dispatch 已有明確 seam，但「授權後、執行前」無任何沙箱分配**：`applyToolGovernance`（`backend/src/platform/tool-governance.ts:707-718`）→ `GovernanceExecutor.executeInternal`（`:554`），authorization 之後、實際 `this.sourceTool.invoke(...)`（`:612`）之前是明確插入點；`tool.invoke.start` audit 在 `:598`。sandbox allocation 應插在 `:598` 之後、`:612` 之前。graph-level 另有 `physicalDispatch`（`backend/src/runtime/authorization/confirmation-graph.ts:245-274`）與 pipeline `dispatch()`（`runtime/tool-dispatch/pipeline.ts:446`）。

4. **Secrets 直接以 env 內嵌讀取、無 broker**：`TAVILY_API_KEY`（`web-search.ts:141`）直接 `getEnv` 並拼成 `Authorization: Bearer`（`:174`）；`BRAVE_API_KEY`（`tools/mcp-loader.ts:112`）直接 `getEnv` 傳給 brave MCP subprocess（`:111-114`）；weather 用 Open-Meteo 無 key（`weather.ts:557`）；`HTTPS_PROXY/HTTP_PROXY` 於 `platform/network.ts:5-12` 讀取。無 secret reference、無 injection 中介、無輪替。

5. **Redaction 有原語但存在缺口**：`runtime/audit/redaction.ts`（`BLOCKED_FIELDS/ALLOWED_FIELDS/redact`）、`DefaultContextRedactor`（`authorization/decision-store.ts:68-101`）、`tracing/opik/opik-redaction.ts`、metric `SENSITIVE_METRIC_KEY`（`observability.ts:72-87`）已存在；但 `ConsoleAuditLogger`（`observability.ts:14-18`）直接 `JSON.stringify(payload)` **無 redaction**，且 `AUDIT_BACKEND` 預設 `console`（`observability.ts:53`）。mcp-agent 使用 `checkpointer: "langgraph_managed"`（`agents/mcp-agent.ts:52`），tool 回傳字串會留在 graph state／checkpoint，**未見 checkpoint secret redaction**（`redaction.ts` 為 audit 專用）。

6. **Egress 僅 `web_fetch` 內嵌結構化檢查、無集中 policy**：`web-fetch.ts` 的 `assertHttpUrl`（`:80-119`）、`isPrivateIpv4/isPrivateIpv6/assertPublicIp`（`:32-78`）、`fetchWithValidatedRedirects`（`:121-147`）為結構化（`node:net isIP` + `node:dns/promises lookup`），非 string-prefix；但 `web_search`／`weather` endpoint 寫死（`api.tavily.com`、`api.open-meteo.com`）**無 egress 檢查**；`platform/network.ts` 只做全域 proxy 設定，無 policy。且 DNS 解析在 tool 內執行、實際 `fetch` 用 hostname（`web-fetch.ts:129`），**fetch 階段不重驗 IP**，存在 DNS rebinding 第二段缺口。

7. **MCP 以 stdio subprocess 執行、無任何 sandbox／process isolation**：`mcp-loader.ts` 以 `StdioClientTransport`（`:274-279`）spawn `npx -y @modelcontextprotocol/server-filesystem|server-brave-search`，**未傳 `cwd`**，子程序繼承 host process 環境與檔案系統；僅 filesystem 以 `MCP_FILESYSTEM_ALLOWED_ROOTS`（`:69-72`）做 application-level root 限制，brave 傳 `BRAVE_API_KEY` env（`:106-115`）。此即 `docs/tool-security-isolation.md:115` 所述「程式內 allowed roots 不能取代 container、OS account 或 process sandbox」的直接現況。

8. **Audit／side-effect evidence 無 profile／secret／egress 維度**：`ToolExecutionRecord`（`runtime/side-effect/business-effect-ledger.ts:50-61`）與 `TOOL_EXECUTION_COLUMNS`（`:199-203`）無 execution profile version、secret refs、egress decision、termination cause；`StructuredToolResultEnvelope`（`runtime/tool-dispatch/structured-tool-result.ts:81-99`）僅有 `tool.version/riskTier/readOnly`。最接近欄位為 `toolVersion`、`decisionId`、`dispatchState/outcomeType/errorCode`。

9. **Architecture check 為 regex 哨兵、未對接真實符號**：`operations/architecture-checks.ts` 的 `ARCHITECTURE_CHECK_IDS`/`CHECKS`（`:1-104`）以 regex 原始碼掃描；`direct-protected-tool-invocation`（`:63-66`）偵測 `protectedTool.invoke` 但該符號在 `backend/src` 不存在，屬防未來繞過模式的哨兵，未以真實 import/符號為基礎強制。

綜合而言，v4 runtime 已有統一 dispatch seam、authorization/risk 層（`ToolRiskRegistry`/`AuthorizationEngine`/`PgDecisionStore`/`ToolRiskPolicy`）、descriptor version 機制、redaction 原語與 web_fetch 的結構化 egress 檢查，但 **sandbox／secret-broker／egress 三能力完全不存在**，且既有 redaction 有 console audit 與 checkpoint 缺口——這正是 X25 issue 所述「contain tool execution at the OS and network boundaries while preventing credentials from entering model context or durable runtime state」的缺口。

## 解決方案

以「契約層優先 + fail-closed 執行縫 + pluggable runner」收斂，不重造 X13/X14/X16/X21/X22 的原語：

1. **versioned execution profile 契約**：新增 `ExecutionProfile` versioned schema，可約束 filesystem roots/write mode、process creation、CPU/mem/disk/wall-clock 限制、egress destinations/protocols/DNS、env vars、可用 binaries/images、output size/artifact handling；於 `RuntimeToolDescriptor` 增加 `executionProfileRef`（與 `egressRequirements`、`secretRequirements` 宣告欄位）。首版區分兩類 execution mode：`trusted_in_process`（僅既有、明確註冊的 read-only native tools，仍須 profile，不得以「無 profile」表信任）與 `isolated_process`（無真實 runner 時 = unsupported/deny，不得用 Node `spawn` 假裝隔離）。

2. **enforcement seam（authorization 之後、執行之前）**：在 `GovernanceExecutor.executeInternal` 的 `:598`（invoke.start audit）與 `:612`（sourceTool.invoke）之間插入 `execution-profile resolution → sandbox capability matching`；`isolated_process` 模式經 `SandboxRunnerPort` 執行，無 runner → deny。`applyToolGovernance`、graph-level `physicalDispatch`、pipeline `dispatch()` 三條路徑共用同一 enforcement。

3. **`SecretBroker` boundary**：新增 opaque `SecretReference` 與 `SecretBrokerPort.resolve(reference, executionContext)`，只在最終授權執行端解析；secret value 不得進入 model prompt／tool schema／events／checkpoint／logs／traces／receipts／error payload／crash dump。`TAVILY_API_KEY`、`BRAVE_API_KEY` 改經 broker 注入最終執行端。

4. **集中 egress policy**：把 `web_fetch` 的結構化檢查（`assertHttpUrl`/`isPrivateIpv4/6`/`assertPublicIp`/`fetchWithValidatedRedirects`）抽成集中 versioned egress policy 模組；`web_search`／`weather` 接上同一 policy；redirect 與 secondary connection 一律重新評估；DNS rebinding 第二段缺口（fetch 階段重驗 IP）補齊。

5. **audit evidence 維度**：在 side-effect／audit evidence 記錄 `executionProfileVersion`、effective capabilities、`secretRefsUsed`、`egressDecision`、`terminationCause`；補齊 `ConsoleAuditLogger` redaction 與 checkpoint redaction。

6. **architecture check 強化**：把「profile 缺失 deny」「egress 繞過」「secret 進 context」接進既有 `ARCHITECTURE_CHECK_IDS`/`CHECKS` 機制，並補上對應 test fixture。

7. **ADM 決策（不可逆、需 review 後 promote 為 ADR）**：
   ```
   X25 採 versioned execution profile 與 pluggable sandbox runner。
   授權流程固定為：
   authorization → execution-profile resolution → sandbox capability matching
   → secret resolution at final executor → egress enforcement → execution → audit evidence
   任何 profile 缺失、版本不支援、runner capability 不足、secret reference 無法解析
   或 egress policy 無法執行的情況，一律 fail closed，不得降級為 host execution。
   ```
   runner 優先序：Linux／正式部署 → container 或獨立 remote sandbox runner；Windows 本機 → Job Object／AppContainer adapter（同一契約的另一實作）；任何特定 OS 機制不得寫進共用 execution-profile schema。

## 受影響範圍

### 受影響套件

- `backend`：`runtime/tool-dispatch/runtime-tool-descriptor.ts`（新增 profile/egress/secret 宣告欄位）、`runtime/tool-dispatch/pipeline.ts`（enforcement dependency）、`platform/tool-governance.ts`（enforcement seam）、`tools/registry.ts`／`production-runtime-tool-descriptors.ts`（profile 註冊）、`tools/authorization/`（risk 與 egress/secret 維度）、`platform/network.ts`（egress policy）、`tools/web-fetch.ts`／`web-search.ts`／`weather.ts`（egress 接線）、`tools/mcp-loader.ts`（isolated_process deny + secret broker）、`runtime/side-effect/business-effect-ledger.ts` 與 `runtime/audit/`（evidence 維度 + redaction）、`operations/architecture-checks.ts`（新增檢查）。
- `bff`：無強制變更；secret／egress／sandbox 皆在 backend 邊界內，bff 不得承擔其語意。預設不改。
- `frontend`：本 Change 標籤不含 `frontend`；不做 UI 變更。

### 受影響能力域

- Tool 統一 dispatch／authorization（X13/X14）。
- Tool scheduling／resilience（X16）。
- Runtime production readiness gate（X21）。
- Consumer identity／`ExecutionContext`（X22，secret 屬 reference，不得進 context）。
- sandbox／execution-profile、secret brokering、egress governance（本 Change 新增）。

### 既有能力原語（本 Change 接線、不重造）

- `applyToolGovernance`／`GovernanceExecutor.executeInternal`（`platform/tool-governance.ts`）。
- `RuntimeToolDescriptor`／`validateDescriptor`（`runtime/tool-dispatch/runtime-tool-descriptor.ts`）。
- `createRuntimeToolAuthorizationComposition`／`ToolRiskRegistry`／`AuthorizationEngine`／`PgDecisionStore`（`tools/authorization/tool-authorization.ts`、`runtime/authorization/*`）。
- `web_fetch` 的 `assertHttpUrl`／`isPrivateIpv4/6`／`assertPublicIp`／`fetchWithValidatedRedirects`（`tools/web-fetch.ts`）。
- `redaction.ts`、`DefaultContextRedactor`、`opik-redaction.ts`、`SENSITIVE_METRIC_KEY`。
- `ARCHITECTURE_CHECK_IDS`／`CHECKS`（`operations/architecture-checks.ts`）。

## 目標

- 每個 executable tool 都解析到明確的 sandbox／egress profile，否則 deny。
- secret value 在自動化 leakage test 下不出現在 persisted state、model input、structured event、receipt、log、trace。
- filesystem／resource／process／network 限制被強制執行，並由 adversarial test 覆蓋。
- redirect、DNS rebinding、encoded-address、localhost、private-network escape test 通過。
- sandbox startup／termination 失敗為 typed、可觀測，且不觸發 unsafe fallback。
- cancellation 與 crash test 不遺留 orphan process、mount、lease 或 temporary credential。
- MCP 與未來 SDK tools 走與 built-in tools 相同的 enforcement 路徑。
- effective profile 與 policy evidence 可對應到 run、task、step、principal、tool-call identity。

## 非目標

- ❌ 不以 containerization 單獨充當 authorization。
- ❌ 不把 plaintext API key 傳過 `ExecutionContext`、model context、tool arguments 或 checkpoint。
- ❌ 不建立所有 tools 共用的全域無限制網路 allowlist。
- ❌ 不靜默 fallback 到 unsandboxed 執行。
- ❌ 不仰賴 string-prefix URL 檢查作為 egress 控制。
- ❌ 首版不接真實 container／OS sandbox runner（`isolated_process` = unsupported/deny），僅立契約與 enforcement seam；runner 實作留後續 Change（Windows Job Object／Linux container adapter 為同一契約的另一實作）。

## 風險

- **fail-closed 過嚴造成既有 tool 停用**：若 enforcement 誤把既有 read-only tool 判為無 profile，會中斷 production。緩解：`trusted_in_process` profile 於 `production-runtime-tool-descriptors.ts` 對既有 5 支 tool 明確註冊；T2 先落地該 profile 再開 enforcement。
- **secret 洩漏殘留缺口**：console audit 與 checkpoint 無 redaction 是既有缺口。緩解：T5 補齊，並以 leakage test 固化；不因「audit 只記 chars」而假設 checkpoint／log 安全。
- **egress policy 過嚴中斷 weather/search**：集中 policy 若誤判合法公網 endpoint。緩解：以 `web_fetch` 既有結構化檢查為基線抽出，weather/search 接線時保留 explicit allow 紀錄，並以 adversarial + regression 雙向測試。
- **scope 過大**：X25 是 Layer 8 大型 Change。緩解：以 tasks 拆成可獨立驗證增量，每批皆通過 lint/test/build；首版只立契約與 seam，真實 runner defer。
- **DNS rebinding 第二段缺口**：集中 egress 後仍需在 fetch 階段重驗 IP，避免只修 redirect 不修 resolve。緩解：T7 於 egress policy 統一處理 resolve→connect 兩段。

## 回滾策略

- 每個 task 皆可獨立 revert；`RuntimeToolDescriptor` 新增欄位為 additive optional，不破壞既有 descriptor。
- enforcement seam 以 feature flag（沿用 `PIPELINE_FLAG_BY_SOURCE` 模式）預設關閉；回滾即關閉 flag 回復「授權後直接執行」既有行為。
- `SecretBroker` 首版為 additive 中介；回滾即把 `TAVILY_API_KEY`／`BRAVE_API_KEY` 還原為既有 `getEnv` 直接讀取。
- egress policy 抽出後，`web_fetch` 既有行為不變；回滾即還原 inline 檢查，weather/search 移除新接線。
- 不引入不可逆 schema 破壞；evidence 新欄位採 additive column／nullable。

## 驗證計畫

- `cd backend && npm run lint && npm run test && npm run build` 全程通過。
- 新增 deterministic unit test：`ExecutionProfile` schema、profile resolution、`SandboxRunnerPort` capability matching、`SecretBroker` resolve、egress policy（redirect/DNS rebinding/encoded IP/private-network）、redaction（console/checkpoint）。
- 新增 mock/recorded integration：dispatch pipeline 在 authorization 後、執行前觸發 enforcement；profile 缺失／runner 不足／secret 無法解析／egress 無法執行 → typed deny；MCP `isolated_process` 無 runner → deny。
- adversarial test：secret leakage（event/checkpoint/log/trace/receipt/error）、egress escape、cancellation/crash 不遺留 orphan。
- live/operator 驗證（真實 container／Job Object runner）屬後續 Change，於完成回報中明確列出未驗證項，不假稱通過。

## 規格疑問（待 Qwen review-plan 前由 CCR 收斂）

1. `ExecutionProfile` 的載入來源：沿用 env（`EXECUTION_PROFILE_JSON`）還是新增 versioned config file？傾向 env + safe default，與既有 `runtime-config.ts`／`DEPLOYMENT_POLICY_JSON` 一致。
2. `SecretBroker` 首版後端：僅做 `reference → resolve` 中介（值仍自 env 於執行端解析）？還是先接 local encrypted store？傾向首版只做 reference + resolve seam + redaction，真正 secret backend 留後續。
3. egress policy 表示法：versioned policy config（deny-by-default + allow 集合 + 私網/loopback 預設拒）是否足夠？是否需要 protocol/DNS 兩段獨立欄位？傾向 versioned policy schema，deny-by-default。
4. `ConsoleAuditLogger` redaction 與 checkpoint redaction 是否本 Change 一併修（屬 X25 secret non-leakage 的必要缺口）？傾向是（T5）。
5. enforcement 是否覆蓋 graph-level `physicalDispatch`（`confirmation-graph.ts:245`）與 pipeline `dispatch()` 兩條路徑，還是先只做 governance seam？傾向三條路徑共用同一 enforcement 原語（T1 起即共用），避免分流。
