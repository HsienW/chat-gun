# Proposal：version-runtime-event-and-terminal-contract

> 對應 Second Stage v4 的 X19。層級 Layer 6 — Harness, Context, and Stream Contracts。
> Labels：`second-stage`、`runtime-integration`、`layer-6`、`backend`、`bff`、`frontend`、`reliability`
> Dependencies：X1（Stream Event Contract）、X8.8（Interaction Ownership／generation-based supersession）、X12（Canonical ExecutionContext）——均屬 v3 已 archive 基礎。

## 1. 問題描述

Chat-Gun 的 runtime event 目前分屬兩套互不相干的體系，且都缺乏跨 retry／reconnect／checkpoint replay 所需的版本化、可去重、可排序封包：

| 現況 | 事件載體 | 缺口 |
|---|---|---|
| 後端 Task/Step 事件 | `TaskEvent`（`eventId`、`taskId`、`stepId?`、`eventType`、`payload`、`createdAt`） | 無頂層 `schemaVersion`；無 Run-scoped `sequence`；`eventId` 用 `randomUUID()` 每次隨機，checkpoint replay 會產生新 id；correlation 藏在 `payload.correlation`，非統一欄位 |
| 後端展示事件 | `AgentRuntimeEvent`（`agent.plan.start`／`agent.tool.*`／`agent.context.build`／`agent.answer.stream`／`agent.card.emit`） | 只有 `ts: number`，無 `eventId`、無 `sequence`、無版本；correlation 為 optional top-level |
| 後端 terminal 語意 | `TaskStatus`／`StepStatus` | terminal 集合不完整：缺 `timed_out`、`crashed`、`budget_exhausted`、`needs_user`；`cancelled_after_commit` 未對應到 Run 級 terminal 契約 |
| 前端承接 | `taskEventReducer`＋`agent-runtime-events.ts` | 無 `eventId` 去重；無 bounded reordering buffer；terminal monotonicity 未在 reducer 直接強制；generation guard 為唯一 stale guard |
| BFF | byte-transparent SSE proxy | 已透傳 bytes，但無版本化 adapter 的相容性契約／測試 |

這與 Evidence Baseline 的「Streaming UI：Abort handling、terminal lifecycle、generation-based stale-run protection exist，但 Runtime events lack a versioned, correlated, deduplicable envelope」完全一致。

本 Change 不是再造一套 Runtime 或事件匯流排，而是為既有的兩套事件加上**單一 versioned envelope**、**Run-scoped monotonic sequence**、**可去重／可排序的 Frontend reducer**，以及**完整的 Run 級 terminal 契約**，並在 migration window 內以 versioned adapter 承接未版本化的舊事件。

## 2. 解決方案

1. **Versioned envelope**：定義 `RuntimeEventEnvelope<TType, TPayload>`＝`{ schemaVersion, eventId, sequence, type, emittedAt, context, payload }`，`schemaVersion` 起始為 `1`；`context` 為 X12 `ExecutionContext` 的可序列化、去憑證投影 `ExecutionEventContext`。
2. **穩定 event identity 與 Run-scoped sequence**：`eventId` 由事件工廠單一來源產生，`sequence` 為 Run 內單調遞增；當 replay／dedup 語意需要時，事件 identity 於交付前先持久化（沿用既有 `EventRepository`）。
3. **穩定 payload schema**：為 Run、Task、Step、model、Tool、permission、reconciliation、compensation、context、card、terminal 十一類事件定義穩定 payload 型別，取代散落各處的 `unknown`／`Record<string, unknown>`。
4. **完整 Run status 契約**：定義 Run 級三層 status——硬終止 `completed`、`failed`、`cancelled`、`timed_out`、`crashed`、`budget_exhausted`、`superseded`，與可復原等待／停靠 `needs_user`、`manual_intervention_required`。單向收斂只作用於硬終止集合；late／duplicate 事件不得使硬終止回到 `running` 或 waiting。`needs_user`／`manual_intervention_required` 為可 resume 狀態（與既有 state-machine 語意一致），故不在硬終止集合內——此為對 roadmap 文字將二者列於 terminal 的清單之語意糾正。
5. **BFF 透傳契約**：BFF 只透傳 event bytes，不做語意改寫，保留 backpressure 與 abort；以測試鎖定該不變量。
6. **Frontend monotonic reducer**：驗證 envelope、以 `eventId` 去重、以 Run/sequence 做 bounded reordering buffer、terminal 單向收斂、未知 type 降級為 `unknown` presentation event；generation＋authoritative Run ownership 作為第二道 stale-output guard（沿用 X8.8）。
7. **Versioned adapter（migration）**：以 adapter 承接既有未版本化事件（`TaskEvent`／`AgentRuntimeEvent`），在 bounded migration window 內與新 envelope 並存；新 producer 一律 emit versioned envelope。

## 3. 受影響範圍

- **套件**：`backend`、`bff`、`frontend`。
- **能力域**：Runtime event、stream contract、terminal state、correlation、observability、frontend reducer。
- **既有模組（只新增 adapter／composition，不重寫）**：
  - `backend/src/runtime/types.ts`（`TaskEvent`／`TaskStatus`／`StepStatus`）
  - `backend/src/runtime/events.ts`（`createEvent` 事件工廠）
  - `backend/src/runtime/interaction/events.ts`（`InteractionTaskEvent`）
  - `backend/src/runtime/state-machine.ts`（terminal 收斂）
  - `backend/src/runtime/execution-context/*`（X12 `ExecutionContext`）
  - `backend/src/runtime/persistence/event-repository.ts`（persist-before-deliver）
  - `backend/src/platform/agent-runtime-events.ts`（`AgentRuntimeEvent`）
  - `frontend/src/types/agent-runtime-events.ts`、`frontend/src/lib/task-event-reducer.ts`、`frontend/src/lib/agent-runtime-events.ts`、`frontend/src/App.tsx`
  - `bff/src/server.ts`（透傳契約測試，邏輯可能不變）

## 4. 目標（In Scope）

- 所有新生產的 runtime event 帶 `schemaVersion`、穩定 `eventId`、Run-scoped monotonic `sequence` 與 X12 correlation。
- Duplicate 交付只改變一次狀態；bounded out-of-order 交付收斂至確定性結果。
- Terminal 之後的 late progress 被忽略且可觀察；superseded Run 的輸出不能覆蓋 authoritative Run。
- 未知 type／版本安全降級，不使 Chat UI 崩潰。
- Disconnect／reconnect 與 checkpoint replay 保持 event identity 不變。
- 跨層契約測試覆蓋全部 terminal status。

## 5. 非目標（Out of Scope）

- ❌ 不引入第二套通用 Run Runtime、佇列或事件匯流排。
- ❌ 不改 LangGraph Agent Server 的 Run/queue/worker/checkpoint 權威。
- ❌ 不變更任何 Graph ID、公開 BFF route 或既有 error-code 語意。
- ❌ 不依 localized message 反推 event state；使用者可見標籤不進入 machine event contract。
- ❌ 不做 X20（durable HITL／crash-safe recovery）或 X21（production readiness gate）的整合。
- ❌ 不在本 Change 移除未版本化事件產生端（僅以 adapter 承接，待 X21 architecture check 再強制）。

## 6. 風險與回滾策略

| 風險 | 影響 | 緩解 |
|---|---|---|
| 兩套事件（TaskEvent／AgentRuntimeEvent）統一成 envelope 觸及面大 | 回歸風險 | 以 adapter 收斂而非重寫；分契約（envelope 定義／backend 產生／bff 透傳／frontend 承接）可獨立驗證 |
| `sequence` 引入後 streaming 多節點併發產生亂序 | 前端亂序崩潰 | Run-scoped 單一 sequence allocator；frontend bounded reordering buffer 吸收亂序 |
| `eventId` 由隨機改為 replay-stable 影響既有去重/查詢 | 既有資料不一致 | 新欄位為 additive（`schemaVersion`／`sequence`），不刪 `eventId`／`createdAt`；`eventId` 穩定性僅對新產生事件生效 |
| Run status 擴充（新增 `timed_out`／`crashed`／`budget_exhausted` 硬終止＋`needs_user`／`manual_intervention_required` 等待狀態）與既有 `TaskStatus` 重疊 | 語意混淆 | 定義三層 Run status（硬終止／waiting／running）為唯一終點；Task/Step 收斂至對應 status，映射集中於單一 `runStatusOf()` |
| 未版本化舊事件與新 envelope 並存期間的歧義 | 前端解析錯誤 | versioned adapter 採 `schemaVersion` 判別；未知 type 一律降級 `unknown` |

回滾：以 feature flag 控制是否 emit／要求 versioned envelope（預設啟用），個別產生端可回退至既有事件格式；frontend 的 versioned parser 與 legacy parser 並存於 migration window，可逐層獨立回滾，不動資料庫歷史。

## 7. 相容性

- 既有 Graph ID、公開 BFF route、既有 error-code 語意不變。
- 既有 `TaskEvent`／`AgentRuntimeEvent` 欄位保留；新增欄位（`schemaVersion`、`sequence`）為 additive，舊消費者於 migration window 內忽略未知欄位。
- 舊事件可省略新欄位，消費端 MUST 容忍；新 producer MUST 發 versioned envelope。
- `cancelled_after_commit` 等既有 terminal 語意映射至 Run 級 terminal 契約時不改變其既有可觀察語意。
