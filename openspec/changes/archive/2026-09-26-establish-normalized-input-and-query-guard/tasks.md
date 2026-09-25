# Tasks：establish-normalized-input-and-query-guard

> 每個 Task 可獨立驗證。本 Change 橫跨 backend／bff／frontend，驗證命令以各套件現有 script 為主；bff 目前無既有 `test` script，新增可觀察行為 MUST 以 Node 內建 `node:test` 補自動測試入口（bff/AGENTS.md §13）。未完成的驗證如實標記，不假稱通過。真實多 worker 的 dispatch gap 與重連 idempotency 收斂以 fault injection／integration test 證明，於回報中明確列出未驗證項。

## T1 建立 NormalizedAgentInput 契約與 strict schema（backend）

> 無前置依賴。

- [x] 新增 `src/runtime/input/normalized-agent-input.ts`：`NormalizedAgentInput` 判別聯合（`prompt`／`clarification_resume`／`cancel`／`command`）＋`AttachmentRef`，並以 strict runtime schema（Zod）驗證。
- [x] `prompt` 需非空 `text` 或至少一個 attachment；`clarification_resume` 需 `interruptId`；`cancel` 需 `targetRunId`；`command` 需 `commandId`；unknown `kind` 回 `unsupported_input_kind`。
- [x] 原始輸入（`rawInput` reference）與正規化結果分離保存；正規化只做 trim／Unicode NFC／空白清理／控制字元移除。
- [x] 新增 test：四種 kind 各自通過、unknown kind 回 `unsupported_input_kind`、空 `prompt` 回 `empty_input`、`attachmentId` 格式／長度驗證、raw 與 normalized 不互相覆蓋。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/input/normalized-agent-input.test.ts
npm run lint
```

## T2 建立 readNormalizedAgentInput adapter（backend）

> 依賴：T1、X12（已 archive）。

- [x] 新增 `src/runtime/input/read-normalized-agent-input.ts`：從 LangGraph input／config metadata／clientInteractionMetadata 建立 `NormalizedAgentInput`，回 `valid`／`invalid`／`unsupported`。
- [x] `prompt` ← `getLatestUserMessage`＋attachment metadata；`clarification_resume` ← LangGraph `Command({ resume })`；`cancel` ← explicit cancel signal；`command` ← 保留可擴充 kind（未接線回 `unsupported_command`）。
- [x] legacy raw string／`Message[]` 經 explicit compatibility adapter 對映為 `prompt`；內部模組只消費 `NormalizedAgentInput`。
- [x] 新增 test：legacy raw input 收斂為 prompt、clarification resume 由 Command 映射、unknown kind 回 unsupported、空輸入回 invalid、直接解析 raw key 被 contract test 阻止。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/input/read-normalized-agent-input.test.ts
npm run build
```

## T3 建立 generation-based 同步 Query 守衛（backend）

> 依賴：T1、X8.8（已 archive）。

- [x] 新增 `src/runtime/input/query-guard.ts`：狀態機 `idle`／`dispatching`／`running`，以 `(threadId, scopeId)`＋`generation` 為 key；`reserve()` 以 `ActiveRunOwnership.claim`（durable CAS）為 authority；`dispatch()`／`release()` generation-aware。
- [x] guard 整合於 `beforeRun`（in-graph，post-enqueue）；reserve 於 graph node 執行前同步執行；reserve 失敗依 `InteractionPolicy` 走 supersede／enqueue／reject，不盲目建立第二個 Run。
- [x] reject（`duplicate_input`／`unsupported_command`／superseded）→ 立即 `markTerminal` 並 emit terminal 事件，不殘留 ghost run。
- [x] `release()` generation-aware：舊 generation finalizer 為 no-op。
- [x] 新增 test：reserve 推進 idle→dispatching、第二個 submit 於 dispatch gap 不建立第二 Run、DB CAS 跨 worker 恰一成功、舊 generation finalizer no-op、release 不清除較新 generation。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/input/query-guard.test.ts
npm run build
```

## T4 接線 request idempotency（backend）

> 依賴：T2、T3、`add-agent-idempotency-audit`（已 archive）。

- [x] `beforeRun`（`src/platform/interaction-runtime.ts:422-594`）在 reserve 前以 BFF trusted dedup key 呼叫 `PgIdempotencyGuard.acquire`（`src/runtime/idempotency/idempotency-guard.ts`）。
- [x] `completed` → `duplicate_input`，回既有結果／狀態而不建立新 Run、不重放 side effect；`failed` 允許新 attempt；無 key pass-through。
- [x] 將 `priorInput` 傳入 `classifyInteractionInput`，使 `duplicate_input` 路徑（`src/runtime/interaction/classify.ts:178-189`）真正觸發。
- [x] 新增 test：completed key 回 duplicate、failed key 允許新 attempt、無 key pass-through、duplicate 不重放 side effect（fault injection）。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/idempotency/ src/platform/interaction-runtime.test.ts
npm run build
```

## T5 輸入經既有 InteractionPolicy 收斂（backend）

> 依賴：T2、T4、X8.8（已 archive）。

- [x] `prompt` 走既有 classify＋`resolveClassificationDisposition`；`clarification_resume` 依 `clarificationReplyMode` resume 等待中 Task；`cancel` 走 `cancel_request` deterministic 分類＋`decideCancellation`。
- [x] `command` 分流：未接線 command 回 `unsupported_command`，不採 NL keyword router。
- [x] 語意分類器仍為 stub 的現況不隱瞞：`intent_revision` 維持 safe fallback（`new_independent_task`）並標記 tentative。
- [x] 補 emit `clarification_requested`／`clarification_resumed`（`src/runtime/interaction/events.ts:13-28`），`clarification_requested` 附帶穩定 `interruptId`。
- [x] 新增 test：clarification_resume resume 到預期 Task、cancel 走 cancel_request、prompt 依 strategy、unsupported command 回 stable、clarification 事件 emit。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/interaction/ src/platform/interaction-runtime.test.ts
npm run build
```

## T6 kind 判別欄位 transport 驗證（bff）

> 依賴：T1（契約定義）。

- [x] `src/server.ts` 對 body 中 `kind` 判別欄位做 transport 驗證：已知 kind（`prompt`／`clarification_resume`／`cancel`／`command`）允許、未知 kind 回 stable `unsupported_input_kind`；MUST NOT 做語意 routing。
- [x] 既有 `validateIdempotencyHeader`／`validateActiveRunHint`／`createTrustedRequestDedupKey`／`copyRequestHeaders` 維持不變。
- [x] 以 `node:test`＋`assert` 新增測試入口並於 `package.json` 提供 `test` script（bff/AGENTS.md §13）。
- [x] 新增 test：已知 kind 放行、未知 kind 回 4xx stable、既有 idempotency／active-run hint 行為回歸不變。

驗證命令：

```bash
cd bff
npm run test
npm run build
```

## T7 typed input kind 與雙擊防護（frontend）

> 依賴：T1（契約定義）。

- [x] `src/App.tsx`：`handleSubmit` 標記 `prompt`、`handleClarificationResume` 標記 `clarification_resume` 並附帶自 `clarification_requested` 事件取得的 `interruptId`、`handleCancel` 在 `thread.stop()` 之外補 business-cancel 訊號（`cancel`，`targetRunId` 無則省略）。
- [x] submit 期間以 dispatch 狀態停用送出（雙擊防護），不單靠 React state 作為 concurrency guard。
- [x] `src/lib/interaction-request-metadata.ts`：idempotency key 對同一 logical submit 穩定（雙擊／重連不重造 key）。
- [x] 新增／更新 test：submit 產生 prompt kind、clarification resume 產生 clarification_resume kind 並附 interruptId、cancel 產生 business-cancel 訊號（含無 activeRunHint 省略 targetRunId）、雙擊不重複送出、idempotency key 穩定性。

驗證命令：

```bash
cd frontend
npm run test -- src/lib/interaction-request-metadata.test.ts src/App.cancel.test.tsx
npm run lint
npm run build
```

## T8 契約 fixture 與全量驗證（跨套件）

> 依賴：T1–T7。

- [x] 建立 cross-layer contract fixture（`contracts/`）供三套件共用：`input-normalization.fixture.json` 與 `query-guard.fixture.json`，與 backend schema 單一來源。
- [x] 執行三套件完整 lint／test／build，如實記錄 skipped／未驗證項與 live 驗證缺口。
- [x] 回歸：Weather／Web／Calculator／MCP／deep-researcher 既有輸入路徑不變。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run test && npm run build
cd frontend && npm run lint && npm run test && npm run build
```
