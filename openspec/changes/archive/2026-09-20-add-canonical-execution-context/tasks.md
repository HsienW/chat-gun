# Tasks：add-canonical-execution-context

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主，BFF 新增 `node:test`。未完成的驗證如實標記，不假稱通過。

## T1 定義 ExecutionContext domain type 與 strict Zod schema（backend）

- [x] 定義 `ExecutionContext` 型別，組合既有 `PrincipalContext` 與 `RuntimeScope`。
- [x] 建立 strict Zod schema：mandatory 欄位、optional 欄位、ID 字元集與長度上限、unknown field strict 偵測。
- [x] 新增 unit test 覆蓋：完整 context 通過、缺 mandatory 拒絕、malformed／oversized ID 拒絕、unknown field 偵測。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/execution-context/
npm run lint
```

## T2 建立單一 readExecutionContext adapter（backend）

- [x] 新增 `readExecutionContext(input, config)`，收斂 snake_case／kebab-case／camelCase 對映至單一邊界。
- [x] 讓 `readRunContext`（`interaction-runtime.ts`）與 `resolveDecisionCorrelation`／`getTracingTaskId`／`getTracingStepId`／`getRunId` 改經由 adapter，或明確標記為待收斂的 compatibility adapter。
- [x] 新增 contract test 覆蓋 legacy key mapping（含 `runId` top-level vs `configurable.run_id`、`requestId` 的 `x-request-id` 對映）。
- [x] `principal`／`scope` 依 MAJ-1 仲裁：adapter 自 `config.configurable` 的 trusted header keys 讀取（介面預留）；**MUST NOT 擴充 `configurable_headers` 白名單**（歸 X13）。
- [x] identity 補齊依「明確環境 profile／flag」分支：development 採隔離 development identity（`createDevelopmentAuthorizationContext` 語意）；production 或環境未知且缺 `principal`／`scope` 時 MUST fail-closed，MUST NOT 以 development identity 補齊。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/execution-context/
npm run build
```

## T3 補 AuditEvent 的 run/thread correlation（backend）

- [x] 於 `AuditEvent` 與 `audit_events` migration 補 `request_id`／`thread_id`／`run_id`（additive）。
- [x] 由 `ExecutionContext` 供給該欄位，取代 payload 內不可索引的 run/thread identity。
- [x] 新增測試：audit 紀錄可依 `runId` 查詢。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/audit/
npm run build
```

## T4 修補 AbortSignal 進入 checkpointed state（backend）

- [x] 修補 `withGovernanceSignal`（`tool-governance.ts`）：`AbortSignal` 改走 top-level `config.signal`，不再寫 `configurable.abortSignal`。
- [x] 同步更新 `weather.ts:91-96` `getRunnableSignal` 改為只讀 `config.signal`，並更新 `weather.test.ts:410`。
- [x] 新增 contract test：序列化後的 context／checkpoint state 不含 client、function、stream、signal、credential。
- [x] 以既有取消／supersede 回歸測試驗證取消語意未破壞。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/tool-governance src/platform/interaction-runtime
npm run build
```

## T5a 傳播 context 至 events、ToolExecution、authorization、audit（backend）

- [x] Task/Step events 補 canonical `requestId`／`threadId`／`runId`。
- [x] `ToolExecutionRecord`／authorization correlation 由 `ExecutionContext` 一次供給。
- [x] `AuditEvent` 的 run/thread correlation 由 `ExecutionContext` 供給（與 T3 一致）。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/tool-governance
```

## T5b 傳播 context 至 tracing 與 metrics（backend）

- [x] OTel span attributes、Opik `readAgentRunMetadata`、metrics 改由 canonical adapter 供給。

驗證命令：

```bash
cd backend
npm run test -- src/platform/tracing src/platform/metrics
```

## T5c 終端 envelope correlation 與 architecture test（backend）

- [x] terminal／error envelope 帶 canonical correlation。
- [x] 新增 architecture test：禁止模組直接讀 raw config key 自行解析 correlation。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T6 BFF requestId 產生／驗證與 correlation header reject（bff）

- [x] 修補 `getRequestId`（`server.ts:231-233`）：client 值需過格式／長度驗證，malformed 產生 server-generated 或 reject。
- [x] reject duplicate／conflicting correlation headers；保留 trusted identity 覆寫。
- [x] 新增 `node:test` 與 `package.json` 的 `test` script：合法／非法 requestId、duplicate header、oversized、malformed、trusted identity 覆寫。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T7 前端 transport metadata 收斂與送出前驗證（frontend）

- [x] 收斂 `InteractionActiveRunHint` 與 `TaskEventActiveRunHint` 的重複型別。
- [x] 送出前驗證 `requestId`／`idempotencyKey`／`activeRunHint` 格式與長度；malformed 採 safe 降級或不送出。
- [x] 事件消費端容忍 canonical 新欄位（未知欄位安全降級）。

驗證命令：

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## T8 跨層 contract fixture 與三套件全量驗證

- [x] 以單一來源建立 cross-layer contract fixture（legacy key mapping、unknown fields、malformed IDs、concurrent Runs）。
- [x] 執行三套件完整 lint／test／build，並如實記錄 skipped／未驗證項。

驗證命令：

```bash
cd frontend && npm run lint && npm run test && npm run build
cd bff && npm run build && npm run test
cd backend && npm run lint && npm run test && npm run build
```
