# Design：establish-normalized-input-and-query-guard

## 責任邊界

本 Change 落在三套件的「輸入契約、重入守衛與傳輸驗證」邊界：

- **backend** 擁有 `NormalizedAgentInput` domain 契約、`readNormalizedAgentInput` adapter、`query-guard` 同步守衛、idempotency 接線，以及把輸入路由至既有 `InteractionPolicy`。
- **bff** 只做 transport 驗證（`kind` 判別欄位的已知／未知判斷、既有 idempotency／active-run hint 驗證），MUST NOT 做語意 routing。
- **frontend** 產生 typed input kind（`prompt`／`clarification_resume`／`cancel`）與雙擊防護，MUST NOT 以 React state 單獨作為 concurrency guard。

守衛是 governance 層，不是第二個 Run Runtime；run 執行仍由 LangGraph Agent Server 負責（X11 Invariant #1），`ActiveRunOwnership` 是 durable authority（Invariant #2）。

## 資料流

### Before（現況，raw 輸入、無守衛、idempotency 未接線）

```text
frontend useStream / thread.submit({ messages, runConfig }, submitOptions)
  → interaction-request-metadata：每 submit 產生新 requestId + idempotencyKey（UUID）
  → BFF /api/langgraph/* proxy：validateIdempotencyHeader + validateActiveRunHint
      → createTrustedRequestDedupKey（覆寫 x-idempotency-key）+ x-bff-* identity
  → LangGraph Agent Server enqueue（run 已被接受）
  → worker invoke graph → applyInteractionGovernance Proxy
      → beforeRun：讀 context.idempotencyKey → classify（無 priorInput）
          → ActiveRunOwnership.claim / supersede（DB CAS）
  → graph 執行（input 仍為 raw Message[]，各 node 自行解讀）
  // 缺口：無 NormalizedAgentInput、無同步 re-entry guard、PgIdempotencyGuard 未接線、
  //       duplicate_input 永不觸發、cancel 只做 thread.stop()、clarification 事件未 emit
```

### After（單一契約 + 同步守衛 + idempotency 接線）

```text
frontend typed kind（prompt / clarification_resume / cancel）+ 穩定 idempotencyKey
  → BFF transport 驗證（kind 判別欄位已知/未知、idempotency/active-run hint）
  → backend readNormalizedAgentInput（transport → domain 單一映射）
  → query-guard.reserve()（同步 idle → dispatching，ActiveRunOwnership.claim CAS）
      → PgIdempotencyGuard.acquire(trusted dedup key)
          → duplicate → 回既有結果，不建立新 Run、不重放副作用
      → 依 kind 路由：prompt → classify + disposition；clarification_resume → resume waiting Task；
          cancel → cancel_request + decideCancellation；command → local/client 分流
  → query-guard.dispatch()（dispatching → running）
  → graph 執行（消費 NormalizedAgentInput，原始 rawInput 分離保存）
  → query-guard.release()（generation-aware：stale finalizer no-op）
  → 收斂到單一 terminal（cancel/duplicate/supersede 皆單調收斂）
```

## 模組設計

### `backend/src/runtime/input/normalized-agent-input.ts`（新）

單一輸入契約與 strict runtime schema：

```typescript
export type AttachmentRef = {
  attachmentId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  securityValidatedAt?: string;   // 由 BFF upload-security 驗證後寫入
};

export type NormalizedAgentInput =
  | { kind: "prompt"; text: string; attachments: AttachmentRef[] }
  | { kind: "clarification_resume"; interruptId: string; value: unknown }
  | { kind: "cancel"; targetRunId: string }
  | { kind: "command"; commandId: string; arguments: unknown };
```

- strict runtime schema（Zod）驗證每個 `kind`：`prompt` 需非空 `text`（或至少一個 attachment）、`attachments` 每個 `attachmentId` 符合 ID 字元集與長度上限；`clarification_resume` 需 `interruptId`；`cancel` 需 `targetRunId`；`command` 需 `commandId`。
- **原始輸入與正規化輸入分離**：`rawInput`（原始 payload 參考／hash）與正規化結果分開保存，MUST NOT 互相覆蓋；正規化只做 trim、Unicode 正規化（NFC）、空白清理與控制字元移除（不改變語意，見 backend `AGENTS.md` §10）。
- unknown `kind` 回 stable `unsupported_input_kind`，MUST NOT 靜默當成 prompt。

### `backend/src/runtime/input/read-normalized-agent-input.ts`（新）

單一 adapter，transport → domain 的唯一映射邊界（mirror X12 `readExecutionContext`）：

```typescript
export interface ReadNormalizedInputResult {
  status: "valid" | "invalid" | "unsupported";
  input?: NormalizedAgentInput;
  rawInput?: { referenceId: string; byteLength: number; hash: string };
  errorCode?: string;
}
export function readNormalizedAgentInput(
  graphInput: unknown,
  config: LangGraphConfig,
  executionContext: ExecutionContext,
): ReadNormalizedInputResult;
```

- `prompt` ← `getLatestUserMessage`（`state.ts:46-51`）＋attachment metadata（自 configurable／clientInteractionMetadata）；無任何輸入時回 `invalid`（`empty_input`），production fail-closed。
- `clarification_resume` ← LangGraph `Command({ resume })`（`App.tsx:433` 的既有 resume 機制）映射為 `{ kind: "clarification_resume", interruptId, value }`；`interruptId` 來源：backend 於 raise clarification interrupt 時 emit `clarification_requested` 事件並附帶穩定 `interruptId`（自等待中 Task/Step correlation 導出），frontend 自該事件取得後於 resume payload 附帶，adapter 只自 resume payload 讀取、不得重新推導。
- `cancel` ← explicit cancel signal（新增 canonical 欄位，非 free-text）；`targetRunId` 為 optional，無 active run hint 時退為 no-op（nothing to cancel），transport abort 仍由 `thread.stop()` 負責，兩者不得互相覆蓋。
- `command` ← 保留為可擴充 kind；目前無 concrete wired command，未接線的 `command` 回 `unsupported_command`，不採 NL keyword router。
- legacy 輸入（純 raw string／`Message[]`）經 explicit compatibility adapter 對映為 `prompt`，不新增 header 語意變更。
- 內部模組只消費 `NormalizedAgentInput`，MUST NOT 各自解析 raw config key。

### `backend/src/runtime/input/query-guard.ts`（新）

generation-based 同步守衛，狀態機 `idle`／`dispatching`／`running`：

```typescript
export type QueryGuardState = "idle" | "dispatching" | "running";

export interface QueryGuard {
  reserve(scope: { threadId: string; scopeId: string }, generation: number): Promise<ReserveResult>;
  dispatch(scope: QueryScope, generation: number): Promise<void>;
  release(scope: QueryScope, generation: number): Promise<void>;
}
```

- `reserve()` 同步推進 `idle → dispatching`，並以 `ActiveRunOwnership.claim`（`ownership.ts:143-165`，`ON CONFLICT DO NOTHING`）為 durable authority；同 `runId` 直接放行（`ownership.ts:454-461` 既有語意）。
- `dispatch()` 推進 `dispatching → running`；`release()` generation-aware：只清除與目前 generation 相符的狀態，stale finalizer（舊 generation）為 no-op。
- in-process 快路徑只服務單一 worker 事件迴圈內的重入防護；跨 worker 的權威性由 DB CAS 保證，守衛不取代 DB 唯一性（Invariant #2）。
- **整合層級（in-graph，非 pre-enqueue）**：本 Change 不新增 BFF→backend reservation route（避免變更公開 BFF route 與建立第二 Run Runtime）；guard 整合於既有 `applyInteractionGovernance` Proxy 的 `beforeRun`（`interaction-runtime.ts:684-721`），即 LangGraph Agent Server enqueue 之後、graph node 執行之前。此層級下 Run 已由 Agent Server 建立，guard 權威性不依賴「enqueue 前攔截」，而依賴 `ActiveRunOwnership` 的 DB CAS 唯一性（Invariant #2）。
- **reject cleanup（ghost-run 防護）**：guard 判定 reject（`duplicate_input`／`unsupported_command`／superseded stale run）時，對已建立的 Run 立即 `markTerminal`（`ownership.ts:220-235`）並 emit 對應 terminal 事件，MUST NOT 讓其進入 running；terminal 單調收斂（Invariant #6）使 late/duplicate 事件不得復活。reserve 失敗（已有 active run）依 `InteractionPolicy` 走 supersede／enqueue／reject，被 supersede 的舊 run 立即轉 terminal，不殘留 ghost run。

### `backend/src/runtime/input/` 與 idempotency 接線

- `beforeRun`（`interaction-runtime.ts:422-594`）改為：`readNormalizedAgentInput` → `query-guard.reserve` → `PgIdempotencyGuard.acquire`（trusted dedup key，`idempotency-guard.ts`）→ 依 `kind` 路由 → `query-guard.dispatch`。
- `PgIdempotencyGuard.acquire` 回 `locked`／`completed`／`failed`：`completed` → `duplicate_input`，回既有結果／狀態而不建立新 Run、不重放副作用；`failed` 允許新 attempt；`locked`（同 key 進行中）依 policy 處理。
- **idempotency 優先順序**：trusted dedup key（BFF `createTrustedRequestDedupKey`）為權威去重訊號；`priorInput` byte-level 比較為 fallback（僅無 key 的 legacy client）。兩者並存時 trusted key 優先，避免矛盾分類。
- 將 `priorInput` 傳入 `classifyInteractionInput`，使 `duplicate_input` 路徑（`classify.ts:178-189`）真正觸發。

### `backend/src/runtime/interaction/classify.ts`（改）

- `duplicate_input` 判定改為「trusted dedup key 已 completed」或「相同 priorInput＋payload」的 deterministic 判定，不再依賴永不傳入的 `priorInput`。
- `cancel_request` 維持 deterministic（`EXPLICIT_CANCEL_SIGNAL`），新增 frontend business-cancel 的 canonical 訊號映射。
- `intent_revision` vs `new_independent_task` 的語意判定維持 safe fallback（classifier stub → `new_independent_task`），MUST NOT 引入 keyword 分支。

### `bff/src/server.ts`（改）

- 對 body 中新增的 `kind` 判別欄位做 transport 驗證：已知 kind（`prompt`／`clarification_resume`／`cancel`／`command`）允許、未知 kind 回 stable validation error（`unsupported_input_kind`）；MUST NOT 做語意 routing。
- 既有 `validateIdempotencyHeader`／`validateActiveRunHint`／`createTrustedRequestDedupKey`／`copyRequestHeaders` 維持不變；trusted dedup key 覆寫（`server.ts:376-390`）維持單一來源。

### `frontend/src/App.tsx`、`frontend/src/lib/interaction-request-metadata.ts`（改）

- `handleSubmit`（`App.tsx:342-418`）標記 input kind 為 `prompt`；`handleClarificationResume`（`App.tsx:420-439`）標記 `clarification_resume` 並附帶自 `clarification_requested` 事件取得的 `interruptId`；`handleCancel`（`App.tsx:441-452`）在 `thread.stop()` 之外補 business-cancel 訊號（`cancel` kind，`targetRunId` 自 `activeRunHintRef` 取得，無則省略）。
- 雙擊防護：submit 期間以 dispatch 狀態停用送出（不單靠 React state，與 backend 守衛協作）；idempotency key 對同一 logical submit 穩定（雙擊／重連不重造 key）。

## 政策規則（Policy Rules）

- `duplicate_input`（dedup key completed）→ 回既有結果，MUST NOT 建立新 Run、MUST NOT 重放副作用。
- `cancel_request`（explicit signal）→ deterministic，走 `decideCancellation`；與 transport abort 分離。
- `clarification_resume` → 依 `clarificationReplyMode` resume 等待中的 Task（`resume_same_task`）或另建 Task（`new_task`）。
- `prompt` → 依 `InteractionPolicy.strategy`（reject／enqueue／interrupt／supersede／rollback）處理。
- `command` → local/client 分流；未接線 command 回 `unsupported_command`，不當成 prompt。
- 語意分類（`intent_revision` vs `new_independent_task`）維持 safe fallback，不採 NL keyword。
- 所有決策收斂到單一 terminal；late/duplicate 事件不得使 terminal 回到 running（Invariant #6）。

## 替代方案與取捨

| 方案 | 取捨 | 結論 |
|---|---|---|
| 以 NL keyword／regex 偵測 command | 違反「No NL keyword router for command detection」；不可靠 | 不採用；`command` 為穩定可擴充 kind，不接 NL router |
| 以 React state 單獨作為 concurrency guard | 違反「No React state alone as the concurrency guard」；跨 tab／reconnect 無法保證 | 不採用；frontend 只做雙擊防護，權威由 backend 守衛＋DB CAS 保證 |
| 自建佇列／scheduler 做 re-entry guard | 違反 Invariant #1（不建第二個 Run Runtime） | 不採用；守衛是 governance 層，run 執行由 LangGraph 負責 |
| 在 BFF 做輸入語意路由 | 越界；BFF 是 transport 邊界 | 不採用；BFF 只驗證 `kind` 判別欄位，不解析語意 |
| 讓 `PgIdempotencyGuard` 取代 `ActiveRunOwnership` | 兩者責任不同：idempotency 防重複提交、ownership 管權威 run | 不採用；兩者並存，idempotency 在 reserve 前、ownership 是 durable authority |
| 隱瞞語意分類器 stub、以 keyword 補齊 | 違反根規則 §9 與「不得以硬編碼掩蓋不存在能力」 | 不採用；`intent_revision` 維持 safe fallback 並明確標記 tentative |

## 可觀測性

- 新增分段 metric／event：`input.normalize`（valid／invalid／unsupported）、`query_guard.reserve`／`dispatch`／`release`（含 generation）、`input.deduplicate`（duplicate hit）。
- 所有事件接 X12 `ExecutionContext` 的 `runId`／`threadId`／`requestId` correlation；idempotency hit 記錄 stable dedup 決策，不落 raw input 或 PII。
- 既有 `clarification_requested`／`clarification_resumed` 事件（`events.ts:13-28`）補上 emit，使 interaction 生命週期可追溯。
- observability 失敗沿用 best-effort（`ignoreObservabilityFailure` 模式），不中斷輸入／dispatch 流程。

## 相容性

- 既有 Weather／Web／Calculator／MCP 與 deep-researcher 的輸入路徑不變（`prompt` 為預設 kind，向後相容於 raw string／`Message[]`）。
- 不變更既有 Graph ID、公開 BFF route、`x-bff-*` header 語意、既有 error-code 語意。
- `query-guard` 未 reserve 時回退到既有 `beforeRun` claim/supersede；idempotency 無 key 或非 duplicate 時 pass-through。
- `command` kind 為 additive，未接線 command 回 `unsupported_command`，不影響既有行為。

## 未驗證假設

- 同步守衛與 DB CAS 的跨 worker 競速收斂，以 ownership 既有 CAS test（`ownership.test.ts`）+ 新增 fault injection 證明；真實多 worker 部署的 dispatch gap 行為以 integration test 覆蓋，非 live 驗證。
- idempotency guard 的 locked／completed／failed 語意在真實重連下的收斂，以 deterministic test + fault injection 證明。
- `UnavailableSemanticInputClassifier` 仍為 stub 的事實不變更；`intent_revision` 的語意判定留待後續（X18／X20）補齊，本 Change 只確保 safe fallback 與 tentative 標記。
- frontend business-cancel 與既有 `thread.stop()` 的並存語意以 `App.cancel.test.tsx` 既有測試全量回歸。

## 責任邊界總結

| 能力 | 權責 | 本 Change 動作 |
|---|---|---|
| 輸入契約與正規化 | backend `NormalizedAgentInput` + adapter | 新增契約、adapter、strict schema；raw/normalized 分離 |
| 同步重入守衛 | backend `query-guard` + `ActiveRunOwnership` | 新增 generation-based 同步守衛，DB CAS 為 authority |
| Request idempotency | backend `PgIdempotencyGuard` | 接線到 `beforeRun`（reserve 前 acquire） |
| Interaction policy 收斂 | X8.8 `InteractionPolicy`／classify／`decideCancellation` | 接線 cancel／clarification_resume／prompt／command |
| Transport 驗證 | bff | `kind` 判別欄位已知／未知驗證（不做語意 routing） |
| Typed input kind | frontend | prompt／clarification_resume／cancel + 雙擊防護 |
| Canonical correlation | X12 `ExecutionContext` | 傳播至 normalization／guard／idempotency 事件 |
