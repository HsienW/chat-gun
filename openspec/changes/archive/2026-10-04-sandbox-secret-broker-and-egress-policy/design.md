# Design：sandbox-secret-broker-and-egress-policy

> **ADM promotion note**
>
> 本 design 的核心決策將在 change 完成 implementation、`openspec verify` 通過，且 production `SandboxRunnerPort` adapter完成至少一個受控環境 smoke test後，promote為 `docs/decisions/` 下的正式ADR，主題為「X25 Sandbox isolation profile and secret broker trust boundary」。在上述條件完成前，本文件維持ADM狀態，不宣稱production process isolation已可用。

## 1. 責任邊界

本 Change 把既有 X13/X14 的「授權後直接執行」升級為「授權 → profile 解析 → sandbox capability 匹配 → 最終執行端 secret 解析 → egress 強制 → 執行 → audit evidence」。責任分界不變：

- **backend（主要）**：`ExecutionProfile` 契約、enforcement seam、`SandboxRunnerPort`、`SecretBrokerPort`、集中 egress policy、evidence 維度、redaction 補強、architecture check。
- **bff（不改）**：secret／egress／sandbox 皆在 backend 邊界內；bff 不得承擔其語意，亦不得持有模型／tool／MCP 憑證。
- **frontend（不改）**：本 Change 標籤不含 frontend。

## 2. 資料流

```text
Browser → bff → backend (langgraph-api)
                  │
                  └─ tool dispatch（unified pipeline）
                        │
       authorization（X13/X14，先於 sandbox 分配）
                        │
       execution-profile resolution
                        │
       sandbox capability matching（runner 不足 → deny）
                        │
       ┌────────────────┴─────────────────┐
       ▼                                   ▼
 trusted_in_process                isolated_process
 （既有 read-only native tools）     （無 runner → unsupported/deny）
       │                                   │
 secret resolution at final executor  ← SecretBrokerPort.resolve(ref)
       │                                   │
 egress enforcement                  ← egress policy（兩段：resolve + connect）
       │                                   │
 execution（sourceTool.invoke / runner）   │
       │                                   │
 audit evidence（profile version / secret refs / egress decision / termination cause）
```

- **authorization 先於 sandbox**：`ToolRiskRegistry`／`AuthorizationEngine` 決策在前；sandbox 分配不得擴權（X25 invariant #4）。
- **secret 只在最終執行端解析**：`SecretReference` 在 model context／events／checkpoint 只以 reference 出現；值只在 `SecretBrokerPort.resolve` 後於最終 executor 使用。
- **egress 兩段**：DNS resolve 與實際 connect 皆依同一 policy 驗證，阻斷 DNS rebinding 第二段。

## 3. 設計決策

### 3.1 versioned `ExecutionProfile` 與兩類 execution mode

| 欄位 | 語意 |
| --- | --- |
| `profileVersion` | 版本化識別；不支援版本 → deny |
| `filesystem` | roots、writeMode（read-only／append-only／scoped-write） |
| `process` | creation allow/deny |
| `resources` | cpu／memory／disk／wall-clock 上限 |
| `egress` | destinations／protocols／DNS 行為 |
| `env` | 可用環境變數（白名單） |
| `binaries` | 可用 binaries／runtime images |
| `output` | output size／artifact handling |

- **`trusted_in_process`**：只允許既有、明確註冊的 read-only native tools（`calculator_tool`、`web_search`、`web_fetch`、`current_weather`、`weather_forecast`）；**仍須 profile**，不得以「無 profile」表信任。
- **`isolated_process`**：external-process／MCP／SDK tool 的 mode；首版無真實 runner → `unsupported`／deny；不得用 Node `spawn` 假裝隔離。
- **`SandboxRunnerPort`**：`{ capabilities(): SandboxCapabilities, run(invocation, profile): SandboxResult }`；capability 不足 → deny。OS 機制不寫進共用 schema。

### 3.2 enforcement seam（三路徑共用）

- **governance seam（主）**：`GovernanceExecutor.executeInternal`（`platform/tool-governance.ts:554`）於 `:598`（invoke.start audit）與 `:612`（sourceTool.invoke）之間插入 profile resolution + capability matching。
- **graph-level `physicalDispatch`**（`runtime/authorization/confirmation-graph.ts:245-274`）與 **pipeline `dispatch()`**（`runtime/tool-dispatch/pipeline.ts:446`）共用同一 enforcement 原語，不得存在分流的 sandbox 判斷。
- 順序固定：`authorization → profile resolution → capability matching → secret resolution → egress → execution → audit`。任一步 fail → typed deny，不回退 host execution。

### 3.3 `SecretBroker` boundary

- `SecretReference = { secretRef, secretName, scope, lease? }`；`SecretBrokerPort.resolve(reference, executionContext) → { credential }` 只在最終授權執行端呼叫。
- `TAVILY_API_KEY`（`web-search.ts:141`）、`BRAVE_API_KEY`（`mcp-loader.ts:112`）改為在 dispatch 端宣告 `secretRequirements`，經 broker 於最終 executor 解析。
- 首版後端：`reference → resolve` 中介（值仍自 env／未來 secret store 於執行端解析），不進 context、不進 checkpoint；真正 secret backend 留後續。
- redaction 補強：`ConsoleAuditLogger`（`observability.ts:14-18`）套 redaction；checkpoint（mcp-agent `langgraph_managed`）於 write 邊界遮罩 secret-bearing 欄位。

### 3.4 集中 egress policy

- 抽 `web_fetch` 的 `assertHttpUrl`／`isPrivateIpv4/6`／`assertPublicIp`／`fetchWithValidatedRedirects`（`tools/web-fetch.ts:80-147`）成集中 versioned egress policy 模組；deny-by-default。
- 兩段驗證：DNS resolve 階段（所有 results 任一落入私網即拒）+ connect 階段（實際目標 IP 重驗），補 `web-fetch.ts:129` 的 rebinding 第二段缺口。
- `web_search`／`weather` 接上同一 policy（explicit allow endpoint，仍受私網/loopback 拒）。
- redirect 與 secondary connection 一律重新評估；`egressDecision` 寫入 audit evidence。

### 3.5 audit evidence 維度

- 於 `ToolExecutionRecord`／audit event 增加（additive、nullable）：`executionProfileVersion`、`effectiveCapabilities`、`secretRefsUsed`、`egressDecision`、`terminationCause`。
- 與既有 `decisionId`／`dispatchState`／`errorCode` 並存，作為 profile/egress 可對應 run/task/step/principal/tool-call identity 的證據。

### 3.6 architecture check 強化

- 於 `ARCHITECTURE_CHECK_IDS`／`CHECKS`（`operations/architecture-checks.ts:1-104`）新增：`profile-missing-dispatch`（受保護 tool 未宣告 profile 即 dispatch）、`egress-bypass`（tool 直接 fetch 未經 egress policy）、`secret-into-context`（secret value 拼進 prompt／state）。
- 既有 `direct-protected-tool-invocation` 與 `production-registry-authorization-missing` 為未對接真實符號的哨兵；本 Change 至少讓 profile 檢查以真實 symbol 為基礎（非純 regex），並補 `.test.ts` 的 production sources 與 `DELIBERATE_BYPASSES` 案例。

## 4. 替代方案與取捨

| 方案 | 取捨 | 結論 |
| --- | --- | --- |
| per-call container 立即導入 | 隔離最強，但需 container runtime 基礎設施，現有 docker-compose 為服務部署拓撲非 tool runner，成本/風險不成比例 | 不採用；首版立契約 + seam，runner defer |
| Windows Job Object／AppContainer 先做 | 本機可驗證，但過早綁定平台，未來 Linux/container 部署產生兩套契約 | 不採用；列為 runner adapter 的後續實作 |
| 只有介面、實際裸跑（無 fail-closed） | 省成本，但違反「不得降級 host execution」的安全底線 | 不採用；硬限制 MUST |
| `spawn` 當作 `isolated_process` | 假隔離，子程序繼承 host 環境 | 不採用；無 runner = deny |
| egress 保留 per-tool 散落 | 改動小，但無法統一 audit 與抗 rebinding 第二段 | 不採用；集中 policy |

## 5. 安全與權限分析

- 授權（X13/X14）先於 sandbox 分配；sandbox 不得擴權。
- secret 屬 reference，不得進入 model prompt／tool schema／events／checkpoint／log／trace／receipt／error／crash dump；redaction 覆蓋 console audit 與 checkpoint。
- 無宣告 capability 的 tool 不得獲得任何隱含存取；profile 缺失／runner 不足 → deny。
- sandbox unavailability 為 typed infrastructure failure；privileged tool fail-closed。
- redirect／secondary connection 依同一 egress policy 重評；DNS resolve 與 connect 兩段皆驗證。
- egress policy 不得洩漏內部 topology／credential；回傳 typed、non-leaking decision。
- `SecretBrokerPort.resolve` 只在最終授權執行端呼叫；不得在 composition root 預解析後廣播。

## 6. 相容性

- 不變更既有 Graph ID、既有公開 BFF route 語意、既有 error-code 語意。
- `RuntimeToolDescriptor` 新增欄位為 additive optional；既有 5 支 production tool 於 `production-runtime-tool-descriptors.ts` 補 `trusted_in_process` profile，不變更其既有 dispatch 語意。
- enforcement seam 以 feature flag 預設關閉；回滾即關閉 flag 回復既有 dispatch 行為，但 `SecretBroker` seam 仍維持啟用並於最終授權執行端解析 secret，不回退為各 tool 直接讀取環境變數。
- egress policy 抽出後 `web_fetch` 既有行為不變；weather/search 為 additive 接線。
- evidence 新欄位 additive column／nullable，不倒轉既有 side-effect ledger 語意。
