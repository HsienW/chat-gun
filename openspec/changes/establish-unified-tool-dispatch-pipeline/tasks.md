# Tasks：establish-unified-tool-dispatch-pipeline

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。未完成的驗證如實標記，不假稱通過。live 驗證（Agent Server 正式部署的 durable replay／reconciliation／restart）屬後續 L 證據，於回報中明確列出未驗證項。

## T1 建立統一 RuntimeToolDescriptor 與 registry 組裝點（backend）

- [ ] 新增 `RuntimeToolDescriptor<TInput, TOutput>` 型別（`toolName`、`toolVersion`、`inputSchema`、`outputSchema`、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior`、`sideEffect?`），以 runtime schema 承接既有 Zod schema。
- [ ] 建立單一 registry 組裝點收集所有 production Tool 的 descriptor；policy 不得散落於各 Tool，不得以 Tool 名稱 switch。
- [ ] 註冊時驗證：缺必要欄位、`toolName`／`toolVersion` 不符、mutation 缺 `sideEffect` → fail-closed。
- [ ] 新增 unit test：descriptor 建構、registry 發現、未知 Tool deny、mutation 缺 descriptor fail-closed。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/tools/
npm run build
```

## T2 為 production local Tools 補 descriptor（backend）

- [ ] 為 calculator／weather／weatherForecast／web-fetch／web-search 宣告 `RuntimeToolDescriptor`（input/output schema、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior`）。
- [ ] `timeoutPolicy`／`retryPolicy` 由 descriptor 單一來源，既有 `TOOL_*` env 作為組裝預設，不變更既有 override 語意。
- [ ] 新增 test：每個 local Tool 都有 descriptor；`isReadOnly` 分派正確；env override 語意不變。

驗證命令：

```bash
cd backend
npm run test -- src/tools/
npm run build
```

## T3 建立 composition root 並接線 ToolExecutionRunner（backend）

- [ ] 新增 `createRuntimeToolDispatchPipeline(...)` factory，組裝 `ToolExecutionRunner`（`PgBusinessEffectLedger` + `PgResultReferenceStore` + observability）、X13 authorization composition、retry budget factory、Task/Step adapter、`SagaOrchestrator`／`CompensationRegistry`、audit/metric/trace。
- [ ] dispatch 前驗證所有 mandatory dependency 存在，缺任一即 fail-closed；read-only 走 typed executor，mutation 走 `ToolExecutionRunner.execute`。
- [ ] ambiguous → reconcile → retry 接線；`not_committed` 或 external idempotency 才 retry；deny/cancel/reject/invalid-schema/unknown-side-effect 不進 retry。
- [ ] 新增 test：mandatory dependency 缺失 fail-closed；read-only／mutation 分派；ambiguous reconcile-first；replay 命中複用；business-effect 不重複 commit。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/runtime/retry/ src/runtime/compensation/
npm run build
```

## T4 mutation Tool 補 SideEffectToolDescriptor 或註冊 fail-closed（backend）

- [ ] 為 MCP filesystem `write_file`／`edit_file`／`create_directory`／`move_file` 補 `SideEffectToolDescriptor`（stable `deriveBusinessEffectKey`、`reconcile`、`resultReferencePolicy`）。
- [ ] 未補 descriptor 的 mutation Tool 於註冊 fail-closed（deny）；`deriveBusinessEffectKey` 單一來源，不硬編碼業務類型。
- [ ] 新增 test：mutation descriptor 完整；business-effect key 穩定；缺 descriptor 註冊被拒。

驗證命令：

```bash
cd backend
npm run test -- src/tools/authorization/ src/runtime/side-effect/
npm run build
```

## T5 收斂 dispatch 路徑：Math／Deep Research／MCP 改經 pipeline（backend）

- [ ] `math-agent.ts` 移除 raw `calculatorTool.invoke`，改經 pipeline dispatcher（read-only 分支）。
- [ ] `deep-researcher.ts` 的 `selectedTool.invoke` 改經 pipeline dispatcher。
- [ ] `mcp-agent.ts` 的手寫 authorization graph 改由 pipeline-owned dispatch 承接，不保留與 dispatcher 並行的第二套 dispatch 邏輯。
- [ ] 新增 test：三條路徑都經統一 dispatcher；既有 Weather／Web／Calculator／MCP 行為回歸。

驗證命令：

```bash
cd backend
npm run test -- src/agents/
npm run build
```

## T6 structured tool result envelope 與 presentation adapter（backend）

- [ ] 新增 versioned structured tool result envelope（`schemaVersion` + stable kind + correlation + payload）。
- [ ] `succeeded` raw result 先過 `outputSchema` 再包 envelope；非 success 以 typed outcome 進 envelope；legacy string 只由 presentation adapter 產生。
- [ ] output-schema 失敗且 effect 已 commit → persist effect truth + 分開 park/repair，不抹除 outcome。
- [ ] 新增 test：structured result 於 model feedback／Task event／frontend fallback／audit 全程維持 structured；legacy string 不反推狀態。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/side-effect/ src/platform/
npm run build
```

## T7 architecture test 阻斷直接 protected Tool invocation（backend）

- [ ] 新增 architecture test：production Agent 直接 invoke 受保護 Tool 必須 fail；mutation Tool 缺 side-effect descriptor 不得註冊；production registry 無 authorization 不得 dispatch。
- [ ] 涵蓋 X21 前置檢查：直接 protected Tool invocation、mutation 無 side-effect descriptor、production registry 無 authorization。
- [ ] 新增 test：繞過 dispatcher 的 import／invoke 被靜態攔截。

驗證命令：

```bash
cd backend
npm run test -- src/tools/ src/agents/
npm run build
```

## T8 跨套件全量驗證與 live 未驗證項記錄（backend）

- [ ] 執行 backend 完整 lint／test／build；如實記錄 skipped／未驗證項。
- [ ] 記錄 live 驗證缺口：Agent Server 正式部署的 durable replay／reconciliation／restart 行為屬後續 L 證據，不假稱已證實。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
```
