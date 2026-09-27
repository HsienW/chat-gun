# Tasks：version-runtime-event-and-terminal-contract

> 每個 Task 可獨立驗證。本 Change 跨 `backend`／`bff`／`frontend`。驗證命令以各套件既有 script 為主（backend：lint／test／build；bff：build＋`node:test`；frontend：lint／test／build）。Codex 不得勾選未實際執行或未通過的驗證；live／fault injection 無法完成須如實標記未驗證項。
>
> 修訂版（r2）：依 Qwen review-plan `rr-x19-plan-001` 解決 M1–M4 與 m1–m3。

## T1 定義 versioned envelope 型別與 runtime schema（backend）

> 無前置依賴（沿用 X12 ExecutionContext）。

- [x] 新增 `src/runtime/event-envelope.ts`：定義 `RuntimeEventEnvelope<TType, TPayload>`、`ExecutionEventContext`、`RUNTIME_EVENT_SCHEMA_VERSION = "1.0.0"`（semver）與 strict runtime schema（Zod）；`sequence` 為正整數、`emittedAt` 為 ISO、`context` 為 X12 投影。
- [x] 定義 `ExecutionEventContext` 投影：`executionCorrelation` 欄位＋`attempt`＋`principalId`／`tenantId`／`scopeId`／`scopeType`；不含 credential／AbortSignal／function／stream；外部輸入 runtime validate。
- [x] 新增 test：完整 envelope 通過、缺 `sequence`／`eventId` 拒絕、`context` 含敏感欄位被拒、`sequence <= 0` 拒絕、semver 解析（major/minor/patch）。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/event-envelope.test.ts
npm run lint
```

## T2 RunSequenceAllocator 與 eventId 穩定性（backend）

> 依賴：T1。

- [x] 新增 `src/runtime/event-sequence.ts`：`RunSequenceAllocator` 以 `runId` 為 key 的 `Map<runId, number>`；`next(runId)` 回遞增 sequence；不採 process-global mutable 單一變數；平行 Run 隔離。
- [x] 清理策略：Run 進入 terminal 時移除條目＋bounded TTL 回收洩漏條目；checkpoint resume 以 `maxPersistedSequence` seeding，維持單調（m2）。
- [x] 新增 `stableEventId` 策略：事件工廠單一來源；replay 需穩定性的事件 id 可注入／持久化；既有 `createEvent` 與 `createInteractionTaskEvent` 收斂至單一 `eventId` 產生點。
- [x] 新增 test：同 Run 遞增、跨 Run 不互相影響、replay 注入同 id 可去重、terminal 清理＋TTL、resume 後續單調。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/event-sequence.test.ts
npm run lint
```

## T3 穩定 payload schema 分類與 dot-style 命名（backend）

> 依賴：T1。

- [x] 新增 `src/runtime/event-payloads.ts`：為 Run、Task、Step、model、Tool、permission、reconciliation、compensation、context、card、terminal 定義穩定 payload 型別（欄位、Enum、長度、可選性），不用 `unknown`／loose `Record<string, unknown>` 取代對外契約。
- [x] 統一 dot-style 命名（`task.created`／`step.started`／`tool.start`…）；提供 old-type（`task_created`／`agent.*`）→ new-type 單一來源映射表（m1）。
- [x] 新增 test：每分類有型別、未知分類回明確 error、old→new 映射完整、顯示文案不入 payload。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/event-payloads.test.ts
npm run build
```

## T4 Run status 三層契約與完整映射（backend）

> 依賴：T3。

- [x] 新增 `src/runtime/run-status.ts`：`RunTerminalStatus`（`completed`、`failed`、`cancelled`、`timed_out`、`crashed`、`budget_exhausted`、`superseded`）、`RunWaitingStatus`（`needs_user`、`manual_intervention_required`）、`RunStatus`。
- [x] 實作 `runStatusOf(taskStatus)` 完整映射（**涵蓋全部 13 個 `TaskStatus`**，M1；回傳三層 `RunStatus`，非僅 terminal）：`created`/`running`/`cancelling`/`compensating`/`rollback_requested`/`partially_failed`→`running`；`waiting_confirmation`→`needs_user`；`completed`→`completed`；`failed`→`failed`；`cancelled`→`cancelled`；`cancelled_after_commit`→`cancelled`（reason `cancelled_after_commit`）；`superseded`→`superseded`；`manual_intervention_required`→`manual_intervention_required`。
- [x] `needs_user`／`manual_intervention_required` 為 waiting（可 resume），非硬終止（M2）；`run.terminal` 事件直接帶出不源自 TaskStatus 的 `timed_out`／`crashed`／`budget_exhausted`。
- [x] 強化 `state-machine.ts`：`RunTerminalStatus` 之後 MUST NOT 回 `running`／waiting；waiting 可 transition 至 `running` 或硬終止（補 contract test 鎖定）。
- [x] 新增 test：13 個 TaskStatus 全映射、waiting resume、硬終止→running 被拒、`cancelled_after_commit` 語意不變、`timed_out`/`crashed`/`budget_exhausted` 三態。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/run-status.test.ts
npm run test -- src/runtime/state-machine.test.ts
npm run build
```

## T5 emitEnvelope composition、persist-before-deliver 與 feature flag（backend）

> 依賴：T2、T3、T4。

- [x] 新增 `src/runtime/emit-envelope.ts`：`emitEnvelope({ type, payload, executionContext, sequenceAllocator })` 注入 `schemaVersion`、`eventId`、`sequence`、`emittedAt`、`context`。
- [x] **Feature flag（M4）**：以 env `RUNTIME_EVENT_ENVELOPE_ENABLED`（預設 `true`）控制 emit versioned envelope；`false` 回退 legacy 格式（`TaskEvent`／`AgentRuntimeEvent`）。
- [x] 需要 replay/dedup 語意的事件（terminal、interrupt、supersede、reconciliation 等）於交付前 persist identity 至既有 `EventRepository`；persist 失敗對 terminal/interrupt 類 MUST fail-closed。
- [x] 既有 `createEvent`／`createInteractionTaskEvent` 改經 composition（adapter 收斂），不重寫 payload 建構。
- [x] 新增 test：envelope 欄位齊全、persist-before-deliver、persist 失敗 fail-closed、flag `false` 回退 legacy、flag 未設定預設啟用、既有 TaskEvent payload 語意不變。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/emit-envelope.test.ts
npm run test -- src/runtime/events.test.ts
npm run test -- src/runtime/interaction/events.test.ts
npm run build
```

## T6 versioned adapter 承接 legacy 事件（backend）

> 依賴：T5。

- [x] 新增 `src/runtime/legacy-event-adapter.ts`：以 `schemaVersion` 判別；缺 `schemaVersion`／`sequence` 者視為 legacy，包裹為 envelope（synthetic sequence 依到達順序、eventId 優先沿用既有 `eventId`，其次才內容 hash）。
- [x] 新 producer（flag 啟用）一律 emit versioned envelope；legacy parser 與 versioned parser 並存於 bounded migration window。
- [x] 新增 test：legacy TaskEvent／AgentRuntimeEvent 被承接、缺欄位容忍、synthetic identity 穩定、old→new type 映射正確。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/legacy-event-adapter.test.ts
npm run lint
npm run build
```

## T7 Feature flag 回滾開關與 disabled 路徑（backend）

> 依賴：T5、T6。

- [x] 於 `src/platform/runtime-config.ts` 定義 `runtimeEventEnvelopeEnabled`（env `RUNTIME_EVENT_ENVELOPE_ENABLED`，預設 `true`）單一來源，啟動時驗證。
- [x] 確認 emit 端（T5）與 legacy adapter（T6）皆消費該 flag；flag `false` 的 disabled 路徑有回歸測試（emit legacy、不 emit envelope、不觸發 persist-before-deliver）。
- [x] 新增 test：flag 預設 `true`、非法值 fail-closed（保守預設）、`false` 回退 legacy 且既有下游行為不變。

驗證命令：

```bash
cd backend
npm run test -- src/platform/runtime-config.events.test.ts
npm run lint
npm run build
```

## T8 backend 全量回歸（backend）

> 依賴：T1–T7。

- [x] 執行 backend 全量 lint／test／build；確認無散落的 `randomUUID()` 事件 id 產生點漂移、`runStatusOf` 覆蓋全部 13 個 TaskStatus、dot-style 命名單一來源（architecture/contract test）。
- [x] fault injection 驗證 persist 失敗、replay、平行 Run、flag disabled 四條路徑收斂且可觀察；無法執行的 live 驗證如實標記。
- [x] 確認 Git Diff 無無關修改；`tasks.md` 只勾選真正完成且驗證的工作。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T9 BFF 透傳契約測試（bff）

> 依賴：無（與 backend T1–T7 並行）。

- [x] 新增 `bff/src/stream-passthrough.test.ts`（`node:test`）：驗證 stream 直通（不 parse／不改寫 payload）、SSE framing 不變、client disconnect 傳遞、upstream abort、背壓下不無限制累積 buffer。
- [x] 若透傳契約需要，僅新增相容性測試，不引入語意層改寫；`bff/package.json` 提供穩定 `test` script。
- [x] 執行 `npm run build` 與 `npm run test`。

驗證命令：

```bash
cd bff
npm run test
npm run build
```

## T10 frontend envelope 驗證、去重、bounded reordering 與 forward-compat（frontend）

> 依賴：T1（envelope 契約）。

- [x] 新增 `frontend/src/lib/runtime-event-envelope.ts`：以 runtime type guard 驗證 `schemaVersion`、`eventId`、`sequence`、`type`、`emittedAt`、`context`、`payload`；不合法 envelope 降級 `unknown`。
- [x] **Forward-compat（M3）**：以 `schemaVersion` major 判別——同 major 做 partial parse（忽略未知 optional 欄位），major 不匹配才降級 `unknown`／`unsupported_schema_version`。
- [x] 新增去重：以 `eventId` 去重，`seenEventIds` 為 bounded set（LRU／上限）。
- [x] 新增 bounded reordering：以 `(runId, sequence)` 的 bounded window buffer；預設 window `128`、可配置；缺口大於 window 向前推進並 emit `events.reorder.forwarded`（m3）。
- [x] 新增 test：合法／非法 envelope、duplicate 只改變一次、亂序收斂、window 推進、同 major 不同 minor partial parse、major 不匹配降級、未知 type 降級。

驗證命令：

```bash
cd frontend
npm run test -- src/lib/runtime-event-envelope.test.ts
npm run lint
```

## T11 frontend terminal monotonic reducer 與新 status 呈現（frontend）

> 依賴：T10。

- [x] 強化 `frontend/src/lib/task-event-reducer.ts`：以三層 Run status 收斂——`RunTerminalStatus` 後拒絕回 `running`／waiting；`needs_user`／`manual_intervention_required` 可 transition；整合 `runStatusOf` 的 frontend 對應映射（單一來源）。
- [x] 強化 `frontend/src/App.tsx` 的 `handleStreamUpdate`：接線 envelope 驗證＋去重＋bounded reordering；generation＋authoritative Run ownership（既有 `extractTaskEventActiveRunHint`）為第二道 guard。
- [x] 新 terminal status（`timed_out`／`crashed`／`budget_exhausted`／`superseded`）與 `cancelled`／`failed` 區分呈現，不混為一般失敗；未知 type／major 不匹配轉 `unknown`，不崩潰。
- [x] 新增 test：硬終止→running 拒絕、needs_user resume、superseded 輸出被丟棄、新 status 區分呈現、unknown 降級、generation guard 保留。

驗證命令：

```bash
cd frontend
npm run test -- src/lib/task-event-reducer.test.ts
npm run test -- src/lib/agent-runtime-events.test.ts
npm run test -- src/App.stream-activity.test.tsx
npm run lint
```

## T12 frontend versioned adapter 接線與 feature flag（frontend）

> 依賴：T10、T11。

- [x] 新增 `frontend/src/lib/legacy-event-adapter.ts`：以 `schemaVersion` 判別 legacy／versioned；legacy `TaskEvent`／`AgentRuntimeEvent` 於 migration window 內承接，不使新 parser 崩潰。
- [x] **Feature flag（M4）**：以 `RUNTIME_EVENT_ENVELOPE_ENABLED`（或 frontend 端等價配置）控制 versioned parser；`false` 走 legacy parser，與 backend 回退對稱。
- [x] 舊消費者於 migration 期容忍未知欄位；新 producer（backend）事件走 versioned parser。
- [x] 新增 test：legacy 事件承接、未知欄位容忍、與 versioned parser 並存、flag disabled 走 legacy。

驗證命令：

```bash
cd frontend
npm run test -- src/lib/legacy-event-adapter.test.ts
npm run test -- src/lib/__tests__/task-types-compat.test.ts
npm run build
```

## T13 跨層契約測試與三套件全量驗證

> 依賴：T8、T9、T12。

- [x] 新增跨層契約測試：覆蓋七個硬終止、`needs_user`／`manual_intervention_required` resume、duplicate、out-of-order、late progress、unknown degrade、forward-compat version、feature flag disabled、disconnect／reconnect、checkpoint replay；frontend／bff／backend 共享同一 canonical 定義或 verified compatibility fixtures。
- [x] 三套件 lint／test／build 全數實際執行並通過；未自動化的 live 驗證（如真實 Agent Server replay）如實標記。
- [x] 確認 Git Diff 無無關修改；`tasks.md` 只勾選真正完成且驗證的工作。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run test && npm run build
cd frontend && npm run lint && npm run test && npm run build
```
