# Tasks：establish-unified-tool-dispatch-pipeline

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。未完成的驗證如實標記，不假稱通過。live 驗證（Agent Server 正式部署的 durable replay／reconciliation／restart）屬後續 L 證據，於回報中明確列出未驗證項。

## T1 建立統一 RuntimeToolDescriptor 與 registry 組裝點（backend）

- [x] 新增 `RuntimeToolDescriptor<TInput, TOutput>` 型別（`toolName`、`toolVersion`、`inputSchema`、`outputSchema`、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior`、`sideEffect?`），以 runtime schema 承接既有 Zod schema。
- [x] 建立單一 registry 組裝點收集所有 production Tool 的 descriptor；policy 不得散落於各 Tool，不得以 Tool 名稱 switch。
- [x] 註冊時驗證：缺必要欄位、`toolName`／`toolVersion` 不符、mutation 缺 `sideEffect` → fail-closed。
- [x] 新增 unit test：descriptor 建構、registry 發現、未知 Tool deny、mutation 缺 descriptor fail-closed。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/tools/
npm run build
```

## T2 為 production local Tools 補 descriptor（backend）

- [x] 為 calculator／weather／weatherForecast／web-fetch／web-search 宣告 `RuntimeToolDescriptor`（input/output schema、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior`）。
- [x] `timeoutPolicy`／`retryPolicy` 由 descriptor 單一來源，既有 `TOOL_*` env 作為組裝預設，不變更既有 override 語意。
- [x] 新增 test：每個 local Tool 都有 descriptor；`isReadOnly` 分派正確；env override 語意不變。

驗證命令：

```bash
cd backend
npm run test -- src/tools/
npm run build
```

## T3 建立 composition root 並接線 ToolExecutionRunner（backend）

- [x] 新增 `createRuntimeToolDispatchPipeline(...)` factory（模組：`backend/src/runtime/tool-dispatch/pipeline.ts`；`RuntimeToolDescriptor` 型別與 registry 放 `backend/src/runtime/tool-dispatch/runtime-tool-descriptor.ts`），組裝 `ToolExecutionRunner`（`PgBusinessEffectLedger` + `PgResultReferenceStore` + observability）、X13 authorization composition、retry budget factory、Task/Step adapter、`SagaOrchestrator`／`CompensationRegistry`、audit/metric/trace。
- [x] dispatch 前驗證所有 mandatory dependency 存在，缺任一即 fail-closed；read-only 走 typed executor，mutation 走 `ToolExecutionRunner.execute`。
- [x] ambiguous → reconcile → retry 接線；`not_committed` 或 external idempotency 才 retry；deny/cancel/reject/invalid-schema/unknown-side-effect 不進 retry。
- [x] 新增 test：mandatory dependency 缺失 fail-closed；read-only／mutation 分派；ambiguous reconcile-first；replay 命中複用；business-effect 不重複 commit。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/runtime/retry/ src/runtime/compensation/ src/runtime/tool-dispatch/
npm run build
```

## T4 mutation Tool 補 SideEffectToolDescriptor 或註冊 fail-closed（backend）

- [x] 為 MCP filesystem `write_file`／`edit_file`／`create_directory`／`move_file` 補 `SideEffectToolDescriptor`（stable `deriveBusinessEffectKey`、`reconcile`、`resultReferencePolicy`）。
- [x] 未補 descriptor 的 mutation Tool 於註冊 fail-closed（deny）；`deriveBusinessEffectKey` 單一來源，不硬編碼業務類型。
- [x] 新增 test：mutation descriptor 完整；business-effect key 穩定；缺 descriptor 註冊被拒。

驗證命令：

```bash
cd backend
npm run test -- src/tools/authorization/ src/runtime/side-effect/
npm run build
```

## T5 收斂 dispatch 路徑：Math／Deep Research／MCP 改經 pipeline（backend）

> T5 拆分為三個 per-agent 子任務，依風險由低到高順序遷移：T5a（math-agent，read-only，最低風險）→ T5b（deep-researcher，governed tools）→ T5c（mcp-agent，自訂 graph nodes，最高風險）。每個子任務獨立 feature flag、獨立驗證、獨立回滾；任一子任務失敗只回滾該 agent，不影響其他。

### T5a math-agent 改經 pipeline（read-only，最低風險）

- [x] `math-agent.ts` 移除 raw `calculatorTool.invoke`，改經 pipeline dispatcher（read-only 分支）；移除 raw tool import。
- [x] feature flag `TOOL_DISPATCH_PIPELINE_MATH_ENABLED`（預設 `false`，on 才走 pipeline，off 維持現行）；單一 agent 回滾 = 關閉 flag。
- [x] 新增 test：math 經統一 dispatcher；calculator 既有行為回歸。

驗證命令：

```bash
cd backend
npm run test -- src/agents/math-agent.test.ts src/tools/
npm run build
```

### T5b deep-researcher 改經 pipeline（governed tools）

- [x] `deep-researcher.ts` 的 `selectedTool.invoke` 改經 pipeline dispatcher（保留 governed wrapper 接線點）。
- [x] feature flag `TOOL_DISPATCH_PIPELINE_DEEP_RESEARCHER_ENABLED`（預設 `false`）；單一 agent 回滾 = 關閉 flag。
- [x] 新增 test：deep-researcher 經統一 dispatcher；Weather／Web 行為回歸。

驗證命令：

```bash
cd backend
npm run test -- src/agents/deep-researcher.*.test.ts
npm run build
```

### T5c mcp-agent 改經 pipeline（自訂 graph nodes，最高風險）

- [x] `mcp-agent.ts` 的 `physicalDispatch` 節點改由 pipeline-owned dispatch 承接（保留 authorizationGate／authorizationConfirmation／physicalDispatch 圖結構，僅 physical execute 入口重導向），不保留與 dispatcher 並行的第二套 dispatch 邏輯。
- [x] feature flag `TOOL_DISPATCH_PIPELINE_MCP_ENABLED`（預設 `false`）；單一 agent 回滾 = 關閉 flag。
- [x] 新增 test：mcp 經統一 dispatcher；既有 MCP 行為回歸。

驗證命令：

```bash
cd backend
npm run test -- src/agents/mcp-agent.tool-calling.test.ts
npm run build
```

> T5a→T5b→T5c 依序落地：前一子任務驗證通過且回歸穩定後才推進下一個。三個子任務全部完成且 T8 全量回歸通過後，才評估移除 feature flag（另立決策，不在本 Task 內擅自移除）。

## T6 structured tool result envelope 與 presentation adapter（backend）

- [x] 新增 versioned structured tool result envelope（`schemaVersion` + stable kind + correlation + payload）。
- [x] `succeeded` raw result 先過 `outputSchema` 再包 envelope；非 success 以 typed outcome 進 envelope；legacy string 只由 presentation adapter 產生。
- [x] output-schema 失敗且 effect 已 commit → persist effect truth + 分開 park/repair，不抹除 outcome。
- [x] 新增 test：structured result 於 model feedback／Task event／frontend fallback／audit 全程維持 structured；legacy string 不反推狀態。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/platform/
npm run build
```

## T7 architecture test 阻斷直接 protected Tool invocation（backend）

- [x] 靜態檢查（import 層）：production Agent 模組不得直接 import raw 受保護 Tool（math-agent 不得 import `calculatorTool`；deep-researcher／mcp-agent 不得 import raw tool 而非 registry／composition root）；mutation Tool 缺 side-effect descriptor 不得註冊；production registry 無 authorization 不得 dispatch。以既有 import-pattern 靜態檢查（對照 `tool-authorization.architecture.test.ts`）擴充此三條。
- [x] 明列靜態檢查限制並以 runtime 補足：靜態 import 分析無法偵測經 `toolByName` map／DI 的動態 `.invoke()`；因此補 runtime smoke test，於 T5a-c 各 agent 完成後，以 dispatcher instrumentation 斷言三條路徑在 runtime 都經統一 dispatcher（斷言 raw `.invoke` 未發生、dispatcher dispatch 計數符合預期）。
- [x] 涵蓋 X21 前置檢查：直接 protected Tool invocation、mutation 無 side-effect descriptor、production registry 無 authorization。
- [x] 新增 test：繞過 dispatcher 的 import 被靜態攔截；runtime 繞過（直接 `.invoke`）被 smoke test 攔截。

驗證命令：

```bash
cd backend
npm run test -- src/tools/ src/agents/
npm run build
```

## T8 跨套件全量驗證與 live 未驗證項記錄（backend）

- [x] 執行 backend 完整 lint／test／build；如實記錄 skipped／未驗證項。
- [x] 記錄 live 驗證缺口：Agent Server 正式部署的 durable replay／reconciliation／restart 行為屬後續 L 證據，不假稱已證實。

## 驗證紀錄（2026-09-23）

- `npm run lint`：通過。
- `npm run test`：153 個 test files、1061 個 tests 通過；6 個 test files、46 個 tests 依既有條件 skip。
- `npm run build`：通過。
- 已完成 deterministic unit test、mock integration 與三個 agent source 的 dispatcher instrumentation。
- 未執行正式部署 live 驗證；Agent Server 的 durable replay、MCP reconciliation query 與 restart recovery 仍需後續 L 證據。MCP filesystem protocol 目前沒有通用 status query，reconciler 對未知狀態保守回傳 `unknown` 並 park，禁止 blind retry。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
```
