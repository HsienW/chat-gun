# Design：agent-tool-sdk-and-manifest

## 1. 責任邊界

本 Change 建立**宣告面**並加入 additive 的版本 provenance；不改動既有**強制面的執行決策語意**：

| 層 | 擁有者 | 責任 | 不得 |
|---|---|---|---|
| 宣告面（manifest + SDK） | `@gun-ai/harness-contracts`（型別/schema）＋`@gun-ai/harness-sdk`（入口/驗證/投影/hooks/context） | 宣告 agent/tool、版本化 manifest、註冊時驗證、provider 投影、typed context view | 執行 tool、寫 trusted identity、改 authorization 結果 |
| 強制面（runtime） | chat-gun runtime（X13/X14/X25/X19） | dispatch、authorization、execution-profile、sandbox、side-effect ledger、event | 被 SDK 反向依賴或繞過 |

不變式：SDK 只產生經驗證的宣告與註冊計畫；chat-gun 的受信 composition root 解析成 `RuntimeToolDescriptor`、`ToolRiskPolicy` 與 `ExecutionProfile` 的合法組合，再與 built-in tool 進入同一執行路徑。SDK 不持有 runtime registry 或 executor。

## 2. 套件與依賴方向

```
@gun-ai/harness-contracts   （型別/schema/enum，含 agent-tool-manifest）
        ▲
        │
@gun-ai/harness-kernel      （無框架純函式原語）
        ▲
        │
@gun-ai/harness-sdk         （SDK 入口、註冊驗證、provider 投影、hooks、typed context）
        ▲
        │
@gun-ai/harness-testkit     （deterministic helpers，含 SDK failure fixtures）
```

- `sdk` 依賴 `contracts`＋`kernel`；`testkit` 依賴 `contracts`＋`kernel`＋`sdk`（提供 SDK 註冊/投影的 deterministic fixture）。
- SDK registration failure 的共用 fixture 由 `testkit` 擁有；`testkit` 自身測試與 chat-gun `backend` 測試消費同一 helper。`backend` 另以手建 fixture 在相同 SDK 註冊路徑、相同輸入做配對驗證；`sdk` 套件測試保留 duplicate stable ID／invalid manifest schema 的等價本套件案例，不 import 或 devDepend 於 `testkit`。三處均驗證 typed failure code、identity 與 registry snapshot；SDK 本套件案例以相同輸入與預期結果核對語意，不以跨套件 helper 引入反向依賴。
- 四套件 MUST NOT import React、LangChain、Express、DB client、model SDK 或 chat-gun application module。
- 反向或跨向 product 一律禁止，由 boundary/cycle check 強制（沿用並擴充 X26 的 `harness-forbidden-dependency`／`harness-cycle`）。

## 3. 版本化 manifest（`contracts`）

### 3.1 manifest 型別

manifest 以 `kind: "agent" | "tool"` 的 discriminated union 表達；`manifestVersion` 為 schema 版本，`toolId`＋`toolVersion` 為 stable identifier。`ToolManifest` 是記憶體內的 typed 宣告，包含 Zod v3 schema，**不得整份序列化**或寫入 checkpoint；JSON evidence 只保存版本、識別與非敏感投影。十類欄位都必須明確提供，唯安全的 `none` 值可作明示宣告：

| 欄位 | 型別方向 | 對應既有契約 |
|---|---|---|
| `toolId` + `toolVersion` | stable ID | `RuntimeToolDescriptor.toolName/toolVersion`（X14） |
| `inputSchema` / `outputSchema` | Zod v3 | `RuntimeToolDescriptor.inputSchema/outputSchema`（X14） |
| `sideEffectClass` | `read-only / local_mutation / external_mutation / irreversible / custom` | 依 §3.3 投影到 `isReadOnly`／`sideEffect`；不是 `riskTier` 的別名 |
| `requiredCapabilities` | 明示的 authorization action IDs | 必須與受信 `ToolRiskPolicy.actions` 相符；sandbox 能力由 `executionProfile` 獨立負責 |
| `executionProfile` | 必填 profile reference 與 egress 宣告 | 由受信 `ExecutionProfileRegistry` 解析並交 X25 強制；不得補 host 預設 |
| `idempotency` | `read_only` 或 `business_effect_key` 宣告 | mutation 必須提供既有 `SideEffectToolDescriptor` 與 result reference policy |
| `approvalPolicyKey` | 明示 `none` 或既有 `AuthorizationPolicy.policyId` | 由受信 composition root 確認 policy 綁定及 `ToolRiskPolicy` 的有效確認要求；執行決策仍歸 X13 |
| `timeoutRetryClass` | 受信 host policy catalog 的 key | 註冊時解析為既有 `timeoutPolicy`／`retryPolicy`，未知 key 拒絕；SDK 不自行重試 |
| `compensation` | `none` 或 `reconcile_only` | 後者須有 `SideEffectToolDescriptor.reconcile`；宣稱可 undo／compensate 而沒有現成 action 則拒絕 |
| `dataClassification` | namespaced 非敏感分類鍵 | **宣告 metadata，無既有 descriptor 對應**；X27 不實作 retention／consent 強制 |

### 3.2 版本化

- 在 X26 `RuntimeVersionSet` 加入**選用** `manifestVersion`，擴充其既有 `evaluateRuntimeVersionCompatibility`；對 SDK manifest 版本未知或不支援時回傳 typed compatibility failure，既有無 manifest 的 built-in tool 保持原行為。
- 在 `RuntimeToolDescriptor`、`StructuredToolResultEnvelope` 與現有 audit evidence 增加**選用** `manifestVersion` provenance；不把 manifest 的 Zod schema、hook 或函式寫入 evidence／checkpoint。SDK tool 的版本可由現有 execution context 與 result correlation 對應 run／task／step／principal／tool-call；既有 tool 無此欄位仍有效。BFF／frontend 必須驗證選用欄位透傳及 unknown-field 降級。

### 3.3 T0 缺口的註冊時轉換

1. `toolId` 與 runtime `toolName` 必須完全相同；`toolVersion` 直接對應。`inputSchema`／`outputSchema` 直接供 canonical runtime validation，provider 投影不可覆蓋。
2. `sideEffectClass=read-only` 必須對應 `isReadOnly=true` 且無 `sideEffect`；`local_mutation`／`external_mutation` 必須對應 `isReadOnly=false` 與完整 `SideEffectToolDescriptor`。`irreversible` 除前述 mutation 要求外，須將重試上限解析為一次、禁止 compensation 宣稱，並由有效 X13 policy 要求確認；reconciliation 可用於判定 commit 狀態，不能被說成 undo。`custom` 首版為 typed unsupported registration failure，直到另有已核准的映射；不得以 risk tier 或字串猜測其語意。
3. `requiredCapabilities` 僅代表明示的 authorization actions，必須與受信 `ToolRiskPolicy.actions` 核對；缺欄位、空集合或未受信 action 都拒絕。X25 的 execution mode、filesystem、process、resources、egress 仍由獨立的 `executionProfile` 宣告與 `ExecutionProfileRegistry` 強制，不可因 action 通過就放行 sandbox。
4. `approvalPolicyKey` 是明示的 `none` 或既有 policy ID。受信 composition root 必須解析 policy ID、驗證 action／resource 綁定與有效 `require_confirmation` 結果；`none` 只在 X13 policy 不要求確認時合法。此欄位不能自行批准、改寫 decision 或取代 X13 的動態授權。
5. `timeoutRetryClass` 由受信 host catalog 解析為具體 `TimeoutPolicy`／`RetryPolicy`；未知 key、政策版本不相容或與 `irreversible` 限制衝突時拒絕。`idempotency=business_effect_key` 必須有受信 side-effect descriptor 的 key derivation 與 result reference policy；`compensation=reconcile_only` 必須有其 `reconcile` 實作。SDK 不持有這些執行函式。
6. `dataClassification` 只驗證為 namespaced、非空、非敏感 metadata key，供後續 X23/X30 消費；沒有既有 runtime 強制欄位，也不得據此聲稱 retention／consent 已執行。這是「每欄對應既有 descriptor」的明示例外，而非隱含新欄位。

### 3.4 版本與 evidence 相容性

- `manifestVersion` 先通過 manifest schema，再使用擴充後的 X26 compatibility set 判定；不支援即 typed failure，不能靜默降級。
- provenance 欄位只對 SDK-defined tool 必填；對 legacy built-in tool 選用。structured result 的 schema 仍為既有版本，選用欄位為 additive；若 BFF／frontend 嚴格 parser 拒絕，T7 必須同步修正並驗證，不得略過。
- X14 dispatch 的 canonical input/output validation、X13 authorization 與 X25 profile enforcement 不依賴 provenance 欄位決策。

### 3.5 SDK 與 manifest 版本政策

- `@gun-ai/harness-contracts`／`kernel`／`sdk`／`testkit` 分別遵循 SemVer；X27 的開發與發佈版維持同一組精確版本，`sdk` 對 `contracts`／`kernel` 使用相容且已驗證的精確依賴。chat-gun 只在 `backend/package.json` 與 lockfile 記錄發佈後的 exact version，不提交本機 `file:`／`link` 路徑。
- 公開宣告型別、必填欄位、驗證或註冊失敗語意的非相容變更升 major；向後相容的選用欄位／新 helper 升 minor；不改公開行為的修正升 patch。`0.x` alpha 仍按同一分類記錄 breaking／additive／fix，不能以 prerelease 名稱掩蓋破壞性變更。
- `manifestVersion` 是 manifest schema 版本，與 npm 套件版分開。首版 runtime 只接受明列於 X26 compatibility set 的版本；不以 SemVer range 猜測相容，未知、同名不同 schema 或衝突的 `toolId`＋`toolVersion` 一律 typed failure。新增必填欄位需新的 manifest major 版本、遷移說明、相容性測試及受信 host 明確 opt-in；舊版保留至已核准的移除週期，不在 X27 靜默升級。
- 版本衝突先停在註冊階段：比對 manifest schema、SDK 套件依賴與 host compatibility set，產出可追蹤的 typed failure；由 `gun-harness` 版本 owner 與 chat-gun composition-root owner 修訂相容表／套件版本並重跑跨 repo 驗證後，才可重新提交。

## 4. SDK 入口（`sdk`）

- `defineAgent`／`defineTool` 等宣告式 builder 回傳 `AgentManifest`／`ToolManifest` 的可驗證實例；builder 缺 capability／sandbox 宣告時型別層即不完整，runtime 註冊時 deny。
- `validateManifest`／`registerTool`：SDK 驗證宣告並回傳 typed registration plan；受信 composition root 完成 policy/profile/descriptor/tool 的預先解析與整批組裝後才發布 production registry。lazy load、dynamic import 或初始化逾時時整批失敗，不能先發布部分 tool。
- `projectProviderToolDescription(manifest, provider)`：由 canonical manifest 派生 provider schema；provider quirks 由 adapter 提供，不得削弱 canonical validation。
- SDK 不持有任何 executor；`defineAgent` 只宣告 agent metadata 與 tool references，不建立另一個 graph/runtime。SDK 解析的終點是受信 host 可檢查的 registration plan。

## 5. Lifecycle hooks 契約

- 只在語意穩定的點提供 hooks（例如 `onBeforeRegister`／`onValidate`／`onProject`），並以文件與型別約束：
  - ordering 明確、單一責任。
  - allowed mutations 限「附加非權威 metadata」，不得 overwrite principal/tenant/authorization/approval/billing。
  - failure propagation：hook 拋錯 → typed registration failure，不得吞掉。
  - cancellation：無長時背景工作；hook 為同步且 bounded。
- 任意 ordering 的 middleware 不提供。

## 6. Typed context views

- SDK consumer 只取得「capability subset」的 typed view（例如宣告 `requiredCapabilities` 後，context 只暴露該 subset），不得拿到完整 `ExecutionContext`。
- context view 不得含 secret；secret 仍為 reference（X25 secret-broker 語意）。

## 7. 與既有 runtime 的整合路徑

```
SDK 宣告 → manifest → 註冊時驗證（fail-before-traffic）
        → provider 投影（canonical → provider schema）
        → 解析為 RuntimeToolDescriptor + ExecutionProfile
        → X14 unified dispatch → X13 authorization → X25 profile resolution → sandbox capability → execution
        → X19 event / side-effect ledger（與 built-in 共用）
```

- chat-gun 以 `loadAgentToolRuntime` 單一 composition root 接線；在公開 registry 前，將 SDK-defined 與 built-in tool 一起建立 descriptor、authorization policy、execution profile 與 governed tool。`RuntimeToolDescriptorRegistry.register()` 本身不是跨 registry 交易；必須先用 staging 組裝完整候選集合，成功後才對 traffic 公開同一 dispatcher（無 per-Agent 重複 dispatcher）。
- architecture test 阻斷：SDK 自建 executor、SDK 直接 invoke 受保護 tool、SDK hook 寫 trusted identity。

### 7.1 首個 built-in tool 遷移：`current_weather`

- 首例選 `current_weather`（`backend/src/tools/weather.ts`）。既有 tool implementation、schema、structured result 與 Weather 專項規則保留；於 `backend/src/tools/sdk/current-weather-manifest-adapter.ts` 建立受信 manifest adapter，從既有 `backend/src/tools/production-runtime-tool-descriptors.ts` 的 descriptor／profile、`backend/src/tools/authorization/tool-authorization.ts` 的 action／policy 及 host timeout catalog 明確取值。任何缺口或不一致於註冊前 typed reject，不以新預設補齊。
- `backend/src/tools/registry.ts` 的 `loadAgentToolRuntime` 是唯一 production composition root。遷移時在 staging 對 `current_weather` 以 SDK plan 取代該 tool 的直接 descriptor 註冊，不能同時發佈相同 stable ID 的兩份 descriptor；其他 built-in tool 保持原入口。切回 legacy 僅為回滾，兩種情境都經同一 `createRuntimeToolDispatchPipeline`、X13 authorization 與 X25 profile enforcer。
- 比較隔離的 legacy／SDK 註冊情境：同一 tool ID／version、輸入輸出 schema、risk policy、profile／egress、timeout／retry、授權拒絕、sandbox 無 runner 拒絕、逾時／取消、structured result／audit 關聯應一致；SDK 情境只多 additive `manifestVersion`。測試以同一 dispatcher factory 的 spy／registry identity 證明路徑相同，並保留 Weather、Web、Calculator、MCP 的原回歸。遷移步驟與回滾方式寫入 `gun-harness/packages/sdk/README.md`，不得把雙註冊作為範例。

### 7.2 BFF／frontend 契約責任

- 本 Change 的 Codex Implementer 分別依 `bff/AGENTS.md` 與 `frontend/AGENTS.md` 擁有 T7 驗證及必要修正；backend 接線者提供含 `manifestVersion` 與 legacy 無此欄位的共用 fixture，BFF／frontend 的修正若必要須在同一 Change 的差異中接受 Qwen review。跨套件契約衝突先更新 delta spec 再實作，不以單方 parser 放寬代替契約。
- BFF：驗證 structured result／event 對有／無 `manifestVersion` 的透傳，未知 additive 欄位安全處理，取消／逾時／錯誤碼與 correlation ID 不改寫；失敗則修改 BFF 並新增自動化測試。frontend：驗證有／無 `manifestVersion`、未知欄位、未知狀態的 parser 與渲染不拋錯，既有終止狀態不回到 running；失敗則修改 parser／renderer 並新增測試。
- T7 gate 必須記錄 `bff` 的 `npm run test`、`npm run build` 以及 `frontend` 的 `npm run lint`、`npm run test`、`npm run build` 實際結果。不得以 backend test 通過代表跨層通過。

## 8. ADM（待 review 後 promote 為 `docs/decisions/` ADR）

- 主題：「SDK manifest and capability model」與「`gun-harness` package ownership, public API, and semantic-version policy」（後者延續 X26）。
- 決策：manifest 型別進 `contracts`、SDK 入口進新 `sdk` 套件、testkit 擴充 helpers；宣告面/強制面分離；safe-by-default。
- promote 時機：review-plan 通過且 apply-change 完成後。

## 9. 替代方案與風險

- **替代 A：SDK 全進 `contracts`**（不新增套件）。缺點：`contracts` 只持型別/schema 的邊界被打破，宣告式 builder／驗證函式混入型別層，與 X26「contracts 不含 runtime 函式」衝突。未採。
- **替代 B：manifest 型別也放 `sdk`**。缺點：版本化的 in-memory 宣告契約失去 `contracts` 的獨立型別與 schema 治理，與 X26 的套件邊界衝突。未採。
- 主要風險同 proposal「風險」節；此處強調「宣告面/強制面 drift」與「safe-by-default 誤傷 legacy tool」兩項，於 T0 盤點對照表與 migration adapter 中收斂。

## 10. 跨 repo 協調與交付

- `gun-harness` 與 chat-gun 各自建立 `agent-tool-sdk-and-manifest` 對應工作分支（chat-gun 依宿主規則使用 `codex/agent-tool-sdk-and-manifest`；`gun-harness` 依其 repo 規則命名）。兩個 PR 互相記錄候選 commit SHA、測試結果與依賴版本；不要求 branch 字串相同。`gun-harness` 契約／SDK PR 先可審；固定 SHA 必須指向包含本 Change 四套件實作的候選 commit，不能使用實作前的 base SHA 或未提交工作樹。git commit／push 與發佈由 Human 執行。
- 開發時讓兩個 repo 作 sibling checkout：`<workspace>/chat-gun-react-agent/backend` 與 `<workspace>/gun-harness`。從 backend 出發的相對 `file:` 路徑為 `../../gun-harness/packages/contracts`、`../../gun-harness/packages/kernel`、`../../gun-harness/packages/sdk`、`../../gun-harness/packages/testkit`；Windows、macOS、Linux 均使用 `/` 的相對 URL。非 sibling checkout 可用環境變數指定 `gun-harness` 絕對路徑後於本機安裝；先建置 `gun-harness`，用暫時安裝、`npm link` 或 tarball 連接。此階段僅供開發 smoke，**不得提交**含本機路徑的 package manifest／lockfile，也不得把該結果稱作固定 SHA CI 或 registry clean install。
- Human 提交／推送 `gun-harness` 候選後，跨 repo CI 以該 SHA checkout（需配置可讀取該 repo 的 CI 憑證）。Windows 與 Linux lane 各在乾淨 `gun-harness` checkout 執行 `npm ci`、`npm run check`，按 `contracts → kernel → sdk → testkit` 打包同一版四套件；在拋棄式 chat-gun checkout 先按既有 lockfile 安裝，再以不提交 package manifest／lockfile 的暫時安裝方式一次提供四個 tarball，核對實際載入的套件版本與來源確為該批 tarball，不能悄悄回退到 registry 的 `alpha.1` 或抓取未發布 `alpha.2`。其後執行 backend lint／test／build、T6 配對 fixture、T7 BFF test／build 及 frontend lint／test／build，兩個 OS 使用相同 fixture。保存兩 repo commit SHA、Node/npm 版本、四個 tarball checksum、命令與結果；無 CI 憑證、tarball 解析失敗或任一 lane 未過，gate 保持未完成。
- 發布前只可回報固定 SHA 的 source／tarball integration；backend 原有 registry lockfile 仍鎖 `alpha.1` 且未宣告 `sdk`，因此不能聲稱 SDK-dependent backend 的 registry `npm ci` 可重現。Human 若決定發佈，依 `contracts → kernel → sdk → testkit` 順序發布同一組 `0.1.0-alpha.2` exact version；四套件可從 registry 取得後，chat-gun 才將 backend 四個 dependencies 與 lockfile 鎖至該 exact version，在 Windows／Linux 乾淨 checkout 以 `npm ci` 重跑 backend 與 BFF／frontend 跨層驗證，確認交付差異沒有 `file:`／`link` 路徑。plan review 不以前置發布為條件；SDK-dependent chat-gun 接線的 readiness／合併則必須等 registry clean install 通過。若 Human 延後發布，維持 PR 與 readiness gate 未完成並另行協調發行方式，不以 tarball 結果冒充正式安裝。
- direct `RuntimeToolDescriptor` API 在 X27 保持支援且不發出 deprecation；X28 評估更多 adapter，X29 依 conformance／相容矩陣提出遷移完成率與棄用決策。若未來決定棄用，須另立 OpenSpec、公告遷移指南與版本窗口，於下一個允許 breaking change 的 major 版後才移除；X27 不承諾未核准的移除日期。
