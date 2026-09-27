# Design：version-runtime-event-and-terminal-contract

> 修訂版（r2）：依 Qwen review-plan `rr-x19-plan-001`（REQUEST_CHANGES）解決 M1–M4 與 m1–m3。

## 1. 責任邊界

```text
Browser ──► BFF（byte-transparent SSE proxy）──► LangGraph Agent Server
                                                     │
                                                     ▼
                                     versioned RuntimeEventEnvelope emitter
                                                     │
                              ┌──────────────┬───────┴────────┐
                              │ eventId      │ Run-scoped     │ ExecutionEventContext
                              │ (stable)     │ sequence       │ (X12 projection)
                              └──────────────┴────────────────┘
                                                     │
                        ┌────────────────┬───────────┴─────────────┐
                        │ TaskEvent      │ AgentRuntimeEvent        │ Run status
                        │ (task_*/step_*)│ (agent.*)                 │ (3-tier)
                        └────────────────┴──────────────────────────┘
                                                     │
                       BFF 透傳（不語意改寫，保留 backpressure/abort）
                                                     │
                       Frontend：validate → dedup → bounded reorder → monotonic reduce
                                                     │
                                    unknown type 安全降級（不崩潰）
```

- **backend**：建立單一 versioned envelope 產生端與 Run-scoped sequence allocator；定義穩定 payload schema 與 Run status 契約；persist-before-deliver。
- **bff**：只透傳 bytes，保留背壓與 abort；以契約測試鎖定「不語意改寫、不累積 buffer」不變量。邏輯預期不變或極小。
- **frontend**：驗證、去重、bounded reordering、terminal monotonic reduce、forward-compatible version 解析、unknown 降級；generation guard 續用。

## 2. Envelope 契約

```typescript
interface RuntimeEventEnvelope<TType extends string, TPayload> {
  schemaVersion: "1.0.0"; // semver；major = 結構不相容，minor/patch = additive only
  eventId: string;        // stable、可去重；replay 時保持一致
  sequence: number;       // Run-scoped monotonic，> 0，同一 runId 內遞增
  type: TType;            // 穩定 event type，統一 dot-style，見 §5
  emittedAt: string;      // ISO 8601
  context: ExecutionEventContext;
  payload: TPayload;
}
```

- `schemaVersion` 採 semver 精神：**major bump = 結構不相容**（新增／刪除必填欄位、改變既有欄位語意）；**minor/patch bump = additive only**（僅新增 optional 欄位或修正實作）。
- **Forward-compat（M3）**：消費端對「同 major、不同 minor/patch」MUST 做 partial parse——驗證已知必填欄位、忽略未知 optional 欄位，不得因新增欄位就整包降級；僅「major 不匹配」才降級 `unknown`（或專用 `unsupported_schema_version` presentation）。
- `sequence` 只在同 `runId` 內有意義；跨 Run 不比較。
- `type` 為穩定機器識別，MUST NOT 以顯示文案當 type。

## 3. ExecutionEventContext（X12 投影）

```typescript
interface ExecutionEventContext {
  requestId: string;
  threadId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  toolCallId?: string;
  toolExecutionId?: string;
  parentRunId?: string;
  agentId?: string;
  attempt: number;
  principalId: string;
  tenantId: string;
  scopeId: string;
  scopeType: string;
}
```

- 為 X12 `ExecutionContext` 的可序列化投影；**MUST NOT** 含 `AbortSignal`、client、function、stream 或任何 credential/token/secret。
- 來源為 `executionCorrelation`＋`principal`／`scope` 的最小欄位（`principalId`／`tenantId`／`scopeId`／`scopeType`），不帶 roles/scopes 陣列或敏感 claim；audit 若有需要另以 redaction 處理。
- 缺 mandatory 欄位（尤其 `runId`／`taskId`）於 production fail-closed（沿用 X12 語意）。

## 4. Sequence 與 event identity 穩定性

- **`RunSequenceAllocator`**：以 `runId` 為 key 的 `Map<runId, number>`；`next(runId)` 回遞增 `sequence`。**MUST NOT** 用 process-global mutable 單一變數（平行 Run 隔離）。
- **清理（m2）**：Run 進入 terminal 時移除該 `runId` 條目；另設 bounded TTL 作為洩漏條目的安全網，避免長時間 process 累積已完成 Run 的 allocator 條目。
- **Replay／resume（m2）**：checkpoint resume 時，allocator 以該 `runId` 的持久化 watermark（`maxPersistedSequence`）seeding，使 resume 後的 `sequence` 維持單調；重播事件直接重用持久化的 `sequence`，不再經過 allocator。
- **eventId**：事件工廠單一來源產生（既有 `createEvent`／`createInteractionTaskEvent`）。當 replay／dedup 語意需要時（terminal、interrupt、supersede、reconciliation 等），事件 factory 於交付前把 `eventId`＋`sequence` 持久化至既有 `EventRepository`；checkpoint replay 重用持久化 identity，使重播事件與原始事件可去重。
- `emittedAt` 為 wall-clock ISO；**MUST NOT** 以 `emittedAt` 或 timestamp-only 作為排序唯一依據（排序由 `sequence` 承擔）。
- **水平擴展（residual risk）**：本 Change 依 X11 之 LangGraph Agent Server 為 Run 權威、單一 Run 由單一 worker 執行，`sequence` 以 process-local allocator 承擔；若未來水平分片讓同一 Run 跨 node 產生事件，需改用 durable/centralized allocator，屬 X21 範圍，本 Change 不引入。

## 5. 穩定 event 型別與 payload schema

**統一 dot-style 命名（m1）**，既有 snake_case ／ dot 舊識別經 legacy adapter 映射：

| 家族 | 新 type（dot-style） | 舊識別（adapter 映射來源） |
|---|---|---|
| Run | `run.started`、`run.status`、`run.terminal` | LangGraph run lifecycle |
| Task | `task.created`、`task.completed`、`task.failed`、`task.cancelled` | `task_created`、`task_completed`、`task_failed`、`task_cancelled` |
| Step | `step.started`、`step.completed`、`step.failed`、`step.retrying` | `step_started`、`step_completed`、`step_failed`、`step_retrying` |
| Model | `model.stream`、`model.done`、`model.error` | `agent.answer.stream` 等 |
| Tool | `tool.start`、`tool.success`、`tool.error` | `agent.tool.start`／`agent.tool.success`／`agent.tool.error` |
| Permission | `permission.request`、`permission.decided` | X13 HITL |
| Reconciliation | `reconciliation.status` | X4/X14 |
| Compensation | `compensation.triggered`、`compensation.completed` | `compensation_triggered`、`compensation_completed` |
| Context | `context.build` | `agent.context.build`、X18 manifest |
| Card | `card.emit` | `agent.card.emit` |
| Terminal | `run.terminal`（含 Run status） | 收斂自 §6 |

- 每個型別對應一穩定 payload schema（欄位、Enum、長度、可選性），**MUST NOT** 用 `unknown`／loose `Record<string, unknown>` 取代對外契約。
- 舊識別於 migration 期保留；legacy adapter 提供完整 old-type → new-type 映射（上表為單一來源）。
- 使用者可見標籤（label、顯示文案）不得進入 payload 的 machine 欄位。

## 6. Run status 契約與 monotonicity（修訂 M1/M2）

**三層 Run status**（取代原單一 terminal 集合；與既有 state-machine 語意對齊）：

```typescript
type RunTerminalStatus =
  | "completed" | "failed" | "cancelled"
  | "timed_out" | "crashed" | "budget_exhausted"
  | "superseded";                                   // 硬終止，單向收斂，不可 resume

type RunWaitingStatus =
  | "needs_user"                                   // 等待 HITL／clarification 確認（可 resume）
  | "manual_intervention_required";                 // 運營停靠（operator 介入後 resume 或終止）

type RunStatus = "running" | RunWaitingStatus | RunTerminalStatus;
```

- **單向收斂只作用於 `RunTerminalStatus`**：一旦進入硬終止，MUST NOT 因 duplicate、late 或 replayed progress 回到 `running`／waiting。
- **`needs_user`（M2 採方向 A）**：移出硬終止集合，改為 Run 級 **waiting** 狀態（Run 級投影自 Task `waiting_confirmation`／`clarification_requested`）。使用者回應後經既有 clarification/confirmation resume 恢復 `running`（同 runId 續跑），因此不違反單向收斂。
- **`manual_intervention_required`**：同為 waiting/parking（可 resume 或由 operator 終止），與既有 state-machine（`manual_intervention_required → completed/failed/cancelled`）一致。
- 與 roadmap 的文字差異（roadmap 把 `needs_user`／`manual_intervention_required` 列於「terminal statuses」）在此明確糾正：二者為**可復原等待／停靠狀態**，非硬終止；roadmap 的 monotonic 不變量僅適用於硬終止集合。

**`runStatusOf(taskStatus)` 完整映射（涵蓋全部 13 個 `TaskStatus`，M1；回傳 `RunStatus` 三層聯集，非僅 terminal）**：

| TaskStatus | RunStatus | 語意 |
|---|---|---|
| `created` | `running` | 進行中，非終止 |
| `running` | `running` | 進行中，非終止 |
| `waiting_confirmation` | `needs_user` | 等待確認（可 resume） |
| `completed` | `completed` | 硬終止 |
| `partially_failed` | `running` | 補償前之瞬態，非終止；經 `compensating` 收斂至 `failed`／`cancelled`／`manual_intervention_required` |
| `compensating` | `running` | 補償中，非終止 |
| `failed` | `failed` | 硬終止 |
| `cancelled` | `cancelled` | 硬終止 |
| `cancelling` | `running` | 取消中，非終止 |
| `superseded` | `superseded` | 硬終止 |
| `rollback_requested` | `running` | 回滾請求中，非終止 |
| `cancelled_after_commit` | `cancelled` | 硬終止；以 reason code `cancelled_after_commit` 區分，既有可觀察語意不變 |
| `manual_intervention_required` | `manual_intervention_required` | 停靠（可 resume／終止） |

- 不源自 `TaskStatus` 的 Run 硬終止（由 `run.terminal` 事件直接帶出）：`timed_out`（model/tool/stream timeout 收斂）、`crashed`（未含化 fatal 終止）、`budget_exhausted`（retry/context budget 耗盡）。
- 前端 reducer 與 backend `state-machine` 兩端都強制：`RunTerminalStatus` 之後不得回 `running`／waiting；waiting 狀態可 transition 至 `running` 或任一硬終止。

## 7. Backend 產生端

- 新增 `emitEnvelope()` composition：接收 `type`、`payload`、`ExecutionContext`，注入 `schemaVersion`、`eventId`、`sequence`、`emittedAt`、`context`。
- **Feature flag（M4）**：以 env `RUNTIME_EVENT_ENVELOPE_ENABLED`（預設 `true`）控制是否 emit versioned envelope；`false` 時回退至既有 legacy 格式（`TaskEvent`／`AgentRuntimeEvent`），作為回滾開關。
- 既有 `createEvent`／`createInteractionTaskEvent` 改經該 composition（adapter 收斂），不重寫其 payload 建構邏輯。
- 需要 replay/dedup 語意的事件於交付前 persist identity（`EventRepository.append`）；persist 失敗時依該事件的 dedup 政策決定是否 fail-closed（terminal/interrupt 類 MUST fail-closed，不得交付未持久化 identity 的事件）。
- `AgentRuntimeEvent`（`agent.*`）於 migration 期以 versioned adapter 包裹，逐步收斂為 §5 的穩定型別。

## 8. BFF 透傳契約

- BFF 維持 byte-transparent：不 parse、不改寫 event payload、不 semantic rewrite；保留 chunk 順序、client disconnect 傳遞、upstream abort 與 backpressure（既有 `pipeWebResponseBody`）。
- 新增契約測試：驗證 stream 直通（無改寫）、SSE framing 不變、client disconnect 後 upstream abort、背壓下不無限制累積 buffer。
- 預期無業務邏輯變更；若有，僅限確保 versioned adapter 的相容性測試，不引入語意層。新 terminal status（`timed_out`／`crashed`／`budget_exhausted`）不改變 BFF error code 語意；其 UI 呈現由 frontend 承接（見 §9）。

## 9. Frontend monotonic reducer

- **validate**：以 runtime type guard（沿用既有手寫 guard 風格，不引入新依賴）驗證 `schemaVersion`、`eventId`、`sequence`、`type`、`emittedAt`、`context`、`payload`；不合法 envelope 降級為 `unknown` presentation event。
- **Forward-compat version（M3）**：以 `schemaVersion` 的 major 判別——同 major 做 partial parse（忽略未知 optional 欄位），不同 major 才降級 `unknown`／`unsupported_schema_version`。
- **dedup**：以 `eventId` 去重，`seenEventIds` 為 bounded set（LRU／上限），防止無限制成長。
- **bounded reordering（m3）**：以 `(runId, sequence)` 的 bounded window buffer 吸收亂序；預設 window `128`（依單一 stream 之 p99 亂序深度估算），可經 config 調整；連續缺口大於 window 時向前推進（forward），並 emit observable metric `events.reorder.forwarded`（不無限等待、不無聲丟棄）。
- **terminal monotonic**：reducer 拒絕 `RunTerminalStatus` → `running`／waiting 的轉換（late progress 忽略並 emit observable reason）；`needs_user`／`manual_intervention_required` 為 waiting，可 transition 至 `running` 或硬終止。superseded Run 的事件以 generation＋authoritative Run ownership（既有 `extractTaskEventActiveRunHint`）為第二道 guard 被丟棄。
- **新 terminal 呈現**：`timed_out`／`crashed`／`budget_exhausted`／`superseded` 等新 status 必須與 `cancelled`／`failed` 區分呈現，MUST NOT 混為一般失敗（沿用 frontend AGENTS.md §6 語意）。
- **unknown degrade**：未知 `type` 或 major 不匹配的 `schemaVersion` 轉為 `unknown` presentation event，MUST NOT 使 Chat UI 崩潰。

## 10. Versioned adapter（migration）

- 以 `schemaVersion` 判別：有 `schemaVersion`＝versioned envelope；缺者視為 legacy，由 adapter 包裹（synthetic `sequence` 依到達順序、`eventId` 優先沿用既有 `eventId`，其次才內容 hash）。
- **Feature flag（M4）**：frontend 亦以 `RUNTIME_EVENT_ENVELOPE_ENABLED`（或 frontend 端等價配置）控制 versioned parser 啟用；`false` 時走 legacy parser，與 backend 回退對稱。
- 新 producer 一律 emit versioned envelope；legacy parser 與 versioned parser 並存於 bounded migration window。
- 前端與後端共享同一組 canonical 定義的 contract fixtures，或經 verified compatibility test 對齊，避免兩端各自發明 schema。

## 11. 可觀測性

- 每個 envelope 可依 `runId` 貫穿查詢；`sequence` 提供順序；`context` 提供 correlation。
- 去重命中、亂序推進（`events.reorder.forwarded`）、terminal-after-progress 忽略、unknown／unsupported_version 降級、feature flag 回退均 emit 可觀察 reason code／trace attribute，MUST NOT 記錄 raw prompt、credential 或未遮罩 PII。

## 12. 替代方案與取捨

| 方案 | 取捨 |
|---|---|
| 逐事件內嵌 version/sequence 欄位而不定義統一 envelope | 改動小但欄位漂移、無單一契約 → 不採，改統一 envelope |
| 以 `emittedAt` timestamp 排序取代 sequence | 跨機器 clock skew、亂序不可靠 → 不採，改 Run-scoped sequence |
| 直接重寫兩套事件為全新事件匯流排 | 破壞既有 X1/X8.8 投資與相容性 → 不採，改 adapter 收斂 |
| `needs_user`／`manual_intervention_required` 保留為硬終止 | 與可復原語意及既有 state-machine 矛盾（M2）→ 不採，改為 waiting/parking |
| 前端無上限 event buffer 吸納亂序 | unbounded 記憶體風險（違反 Excludes）→ 不採，改 bounded window |
| 以顯示文案／localized message 判定 terminal | 違反根規則禁止硬映射 → 不採，改穩定 machine enum |
