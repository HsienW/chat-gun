# Tasks：sandbox-secret-broker-and-egress-policy

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。T0 先建立 `ExecutionProfile` schema、execution mode 與 `RuntimeToolDescriptor` 新增欄位，後續 Task 一律引用，避免循環依賴。未完成的驗證如實標記，不假稱通過。live 驗證（真實 container／Job Object runner）屬後續 Change，於完成回報中明確列出未驗證項。

## T0 建立 `ExecutionProfile` schema、execution mode 與 descriptor 宣告欄位

> 前置：無。本 Task 必須最先完成，T1–T12 皆引用。

- [x] 新增 strict versioned `ExecutionProfile` schema（`profileVersion`、`filesystem`、`process`、`resources`、`egress`、`env`、`binaries`、`output`）；未知欄位 fail-closed。
- [x] 定義 execution mode：`trusted_in_process` 與 `isolated_process`；`isolated_process` 無 runner 時為 `unsupported`。
- [x] 於 `RuntimeToolDescriptor`（`runtime/tool-dispatch/runtime-tool-descriptor.ts:45-59`）新增 additive optional 欄位 `executionProfileRef`、`egressRequirements`、`secretRequirements`；`validateDescriptor` 同步更新。
- [x] 新增 unit test：profile schema 通過／未知欄位 fail-closed、mode enum 合法值、descriptor 新欄位驗證。
- [x] 對應 `specs/tool-execution-profile/spec.md`「versioned execution profile」與「兩類 execution mode」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/
npm run build
```

## T1 建立 `SandboxRunnerPort` 與 capability matching（fail-closed）

> 依賴：T0。

- [x] 新增 `SandboxRunnerPort`：`{ capabilities(): SandboxCapabilities, run(invocation, profile): SandboxResult }`。
- [x] 新增 profile→capability matching：profile 要求超出 runner capability → typed deny；無 runner 且 mode 為 `isolated_process` → `unsupported` deny。
- [x] 新增 unit test：capability 不足 deny、無 runner deny、`trusted_in_process` 不需 runner 仍須 profile。
- [x] 對應 `specs/tool-execution-profile/spec.md`「runner capability 不足 fail-closed」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-dispatch/
npm run build
```

## T2 落地 enforcement seam（authorization 之後、執行之前）

> 依賴：T1。引用 `GovernanceExecutor.executeInternal`（`platform/tool-governance.ts:554`）的 `:598`→`:612` 區間。

- [x] 於 `GovernanceExecutor.executeInternal` 在 `tool.invoke.start` audit（`:598`）之後、`sourceTool.invoke`（`:612`）之前插入 profile resolution + capability matching。
- [x] 同一 enforcement 原語接進 graph-level `physicalDispatch`（`runtime/authorization/confirmation-graph.ts:245-274`）與 pipeline `dispatch()`（`runtime/tool-dispatch/pipeline.ts:446`），不得分流。
- [x] 順序固定：authorization → profile resolution → capability matching；profile 缺失／版本不支援／runner 不足 → typed deny，不回退 host execution。
- [x] 新增 integration test：三路徑皆觸發 enforcement；profile 缺失 deny；feature flag 關閉時回復既有行為。
- [x] 對應 `specs/tool-execution-profile/spec.md`「enforcement seam 與 fail-closed 順序」。

驗證命令：

```bash
cd backend
npm run test -- src/platform/tool-governance.test.ts src/runtime/tool-dispatch/ src/runtime/authorization/
npm run build
```

## T3 對既有 5 支 production tool 註冊 `trusted_in_process` profile

> 依賴：T0、T2。引用 `production-runtime-tool-descriptors.ts:28-34`。

- [x] 於 `production-runtime-tool-descriptors.ts` 對 `calculator_tool`、`web_search`、`web_fetch`、`current_weather`、`weather_forecast` 明確註冊 `trusted_in_process` profile（含 profileVersion）。
- [x] 僅允許 read-only、明確註冊的 native tool 使用 `trusted_in_process`；不得以「無 profile」表信任。
- [x] 新增 test：五支 tool 皆有 profile；未註冊 tool dispatch 前 deny。
- [x] 對應 `specs/tool-execution-profile/spec.md`「trusted_in_process 僅限既有 read-only native tools」。

驗證命令：

```bash
cd backend
npm run test -- src/tools/
npm run build
```

## T4 建立 `SecretBroker` boundary（reference + resolve seam）

> 依賴：T0。引用 `web-search.ts:141`、`mcp-loader.ts:112`。

- [x] 新增 opaque `SecretReference`（`secretRef`、`secretName`、`scope`、`lease?`）與 `SecretBrokerPort.resolve(reference, executionContext)`。
- [x] `TAVILY_API_KEY`（`web-search.ts:141`）、`BRAVE_API_KEY`（`mcp-loader.ts:112`）改為宣告 `secretRequirements`，於最終 executor 經 broker 解析，不再於 tool 定義端直接 `getEnv` 拼字。
- [x] broker 只在最終授權執行端解析；不得於 composition root 預解析後廣播。
- [x] 新增 unit test：resolve 成功／reference 無法解析 deny／未宣告 secret 的 tool 不得 resolve。
- [x] 對應 `specs/secret-broker/spec.md`「secret resolution 只在最終執行端」。

驗證命令：

```bash
cd backend
npm run test -- src/tools/ src/runtime/tool-dispatch/
npm run build
```

## T5 secret redaction 補強（console audit + checkpoint + schema）

> 依賴：T4。

- [x] `ConsoleAuditLogger`（`observability.ts:14-18`）套用 redaction（與 `PgAuditLogger` 一致），不再無遮罩 `JSON.stringify(payload)`。
- [x] checkpoint（mcp-agent `langgraph_managed`，`agents/mcp-agent.ts:52`）於 write 邊界遮罩 secret-bearing 欄位。
- [x] tool schema／provider-facing description 不得含 secret value（僅 `secretRef`）。
- [x] 新增 leakage test：secret value 不出現在 event／checkpoint／log／trace／receipt／error payload。
- [x] 對應 `specs/secret-broker/spec.md`「secret 不得進入 persisted state／model input／log／trace」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/audit/ src/runtime/side-effect/ src/platform/
npm run build
```

## T6 建立集中 versioned egress policy（抽出 web_fetch 檢查）

> 依賴：T0。引用 `tools/web-fetch.ts:80-147`。

- [x] 抽出 `assertHttpUrl`／`isPrivateIpv4/6`／`assertPublicIp`／`fetchWithValidatedRedirects` 成集中 versioned egress policy 模組（deny-by-default）。
- [x] 兩段驗證：DNS resolve 階段（任一 result 落入私網即拒）+ connect 階段（實際目標 IP 重驗），補 `web-fetch.ts:129` rebinding 第二段缺口。
- [x] 新增 unit test：URL parser disagreement、DNS rebinding、encoded IP、localhost、private-network、redirect escape。
- [x] 對應 `specs/egress-governance/spec.md`「集中 egress policy」與「兩段 DNS/connect 驗證」。

驗證命令：

```bash
cd backend
npm run test -- src/platform/ src/tools/web-fetch.test.ts
npm run build
```

## T7 `web_search`／`weather` 接上 egress policy

> 依賴：T6。

- [x] `web_search`（`api.tavily.com`）、`weather`（`api.open-meteo.com`）改經集中 egress policy（explicit allow endpoint，仍受私網/loopback 拒）。
- [x] redirect 與 secondary connection 一律重新評估。
- [x] 新增 regression：web_search／weather 既有成功案例不回歸；egress deny 時回 typed 錯誤而非靜默 fallback。
- [x] 對應 `specs/egress-governance/spec.md`「built-in tools 一致套用 egress policy」。

驗證命令：

```bash
cd backend
npm run test -- src/tools/
npm run build
```

## T8 MCP subprocess 接 `isolated_process`（無 runner → deny）

> 依賴：T1、T4。引用 `mcp-loader.ts:274-279`。

- [x] MCP server（filesystem、brave_search）的 stdio subprocess 改標為 `isolated_process`；無 runner 時 `unsupported` → deny，不得以 `spawn` 當隔離。
- [x] brave `BRAVE_API_KEY` 改經 `SecretBrokerPort.resolve` 注入最終 subprocess env，不直接 `getEnv` 傳字。
- [x] 新增 test：MCP `isolated_process` 無 runner deny；有 runner（mock）才執行；secret 經 broker 注入。
- [x] 對應 `specs/tool-execution-profile/spec.md`「MCP 與 built-in tools 同一 enforcement 路徑」。

驗證命令：

```bash
cd backend
npm run test -- src/tools/mcp-loader.test.ts
npm run build
```

## T9 audit／side-effect evidence 增加 profile／secret／egress 維度

> 依賴：T2、T4、T6。

- [x] 於 `ToolExecutionRecord`（`business-effect-ledger.ts:50-61`）與 audit event 增加 additive nullable 欄位 `executionProfileVersion`、`effectiveCapabilities`、`secretRefsUsed`、`egressDecision`、`terminationCause`。
- [x] `StructuredToolResultEnvelope`（`structured-tool-result.ts:81-99`）增加 profile／egress evidence 欄位（不回退既有欄位語意）。
- [x] 新增 test：每次 dispatch 產出 profile version 與 egress decision，可對應 run/task/step/principal/tool-call identity。
- [x] 對應 `specs/tool-execution-profile/spec.md`「audit evidence 維度」與 `specs/egress-governance/spec.md`「egress decision 記錄」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/runtime/audit/
npm run build
```

## T10 architecture check 強化（profile 缺失／egress 繞過／secret 進 context）

> 依賴：T2、T6、T4。

- [x] 於 `ARCHITECTURE_CHECK_IDS`／`CHECKS`（`operations/architecture-checks.ts:1-104`）新增 `profile-missing-dispatch`、`egress-bypass`、`secret-into-context` 檢查，至少 profile 檢查以真實 symbol 為基礎（非純 regex 哨兵）。
- [x] 補 `.test.ts` 的 production sources 清單與 `DELIBERATE_BYPASSES` 案例。
- [x] 新增 test：繞過 profile／egress／secret 的 fixture 皆 fail；production sources 皆 pass。
- [x] 對應 `specs/tool-execution-profile/spec.md`「architecture check 阻斷繞過」。

驗證命令：

```bash
cd backend
npm run lint
npm run test -- src/operations/architecture-checks.test.ts
npm run build
```

## T11 adversarial test 矩陣（secret leakage + egress escape + cancellation/crash）

> 依賴：T5、T6、T8。

- [x] 新增 adversarial test：secret leakage（event/checkpoint/log/trace/receipt/error）、egress escape（redirect/DNS rebinding/encoded IP/private-network）、MCP orphan process、cancellation/crash 不遺留 mount/lease/temporary credential。
- [x] 新增 test：sandbox startup／termination 失敗為 typed、可觀測，不觸發 unsafe fallback；retry 不重複執行資源耗盡／政策違反的 tool。
- [x] 對應 `specs/secret-broker/spec.md`、`specs/egress-governance/spec.md`、`specs/tool-execution-profile/spec.md` 的 failure/edge 情境。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/tools/ src/operations/
npm run build
```

## T12 文件與 ADR 摘要

> 依賴：T0–T11 完成後。

- [x] 更新 `docs/tool-security-isolation.md`：把 sandbox profile／secret broker／egress policy 的現況與 fail-closed 語意寫入（不與既有允許權限敘述衝突）。
- [x] 於 design 的 ADM 決策段落標註「待 review 後 promote 為 `docs/decisions/` ADR」，並列出 promote 時機。
- [x] 對應 X25「Sandbox isolation profile and secret broker trust boundary」ADR 主題（文件驗證，無自動化 test）。

驗證命令：

```bash
# 文件審查：確認 fail-closed 語意、runner 優先序、secret reference 邊界皆已記載
```
