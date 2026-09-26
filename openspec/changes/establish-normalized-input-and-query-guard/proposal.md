# Proposal：establish-normalized-input-and-query-guard

## 變更摘要

把「輸入如何進入 Runtime」從「各層以 raw string／`Message[]`／`Uint8Array` 各自解讀、無統一契約、無同步重入守衛、request idempotency 未閉環」的現況，收斂為**單一 `NormalizedAgentInput` 正規化輸入契約 + generation-based 同步 Query 守衛（`idle`／`dispatching`／`running`）**：在 X12 `ExecutionContext` 與 X8.8 `ActiveRunOwnership`／`InteractionPolicy` 之上，補齊 (1) `NormalizedAgentInput` 判別聯合與 strict runtime schema；(2) 單一 `readNormalizedAgentInput` adapter 作為 transport→domain 的唯一映射邊界；(3) 原始輸入與正規化輸入分離保存；(4) attachment 身份／安全只驗證一次、queue 只存 reference；(5) local/client command 與 model work 在啟動 Graph Run 前分流（不採 NL keyword router）；(6) 以 `ActiveRunOwnership` 為 durable authority 的同步 query guard，於 async dispatch 前 reserve；(7) generation-aware stale cleanup；(8) 把 enqueue/reject/supersede/clarification-resume 接回既有 `InteractionPolicy`；(9) 接線 `PgIdempotencyGuard` 使雙擊／重連／重複提交不重複建立 Run 或副作用。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X17**，是 Layer 6（Harness, Context, and Stream Contracts）的第一個 Change，與 X18（`activate-context-budget-compression-memory`）、X19（`version-runtime-event-and-terminal-contract`）平行。前置 X8.8（`add-agent-interaction-runtime`，ARCHIVED）與 X12（`add-canonical-execution-context`，COMPLETED）均已完成。

## 問題描述

本 Change 建立時以唯讀盤點 frontend／bff／backend 三套件現況，確認下列事實：

1. **無 `NormalizedAgentInput` 契約**：輸入在各層以 raw string／`Message[]`／`Uint8Array` 傳遞。`InteractionRunContext.inputPayload: Uint8Array`（`backend/src/platform/interaction-runtime.ts:48-61`，`serializeInput` L244-252）只是序列化原始 payload；`getLatestUserMessage`／`messageContentToString`（`backend/src/state.ts:46-51,79-102`）只是抽取 helper；`INPUT_CLASSIFICATIONS`（`backend/src/runtime/interaction/classify.ts:5-11`）是分類結果而非輸入契約。全 repo 無 `kind: "prompt"` 欄位或任何正規化輸入型別。

2. **無 slash／local command 分流**：全 repo 搜尋 `slash`、`/cancel`、`/clarify`、`/new`、`commandName`、`isCommand` 均無本地指令分流邏輯。唯一「command」字樣是 LangGraph `Command`／`interrupt()`（graph 控制流，`deep-researcher.ts` L1837/1848）與 frontend clarification resume 的 `{ command: { resume } }`（`frontend/src/App.tsx:433`）。`resolveClassificationDisposition`（`classify.ts:348-408`）是 free-text 語意分類，非本地指令。

3. **request idempotency 未閉環**：`PgIdempotencyGuard`（`backend/src/runtime/idempotency/idempotency-guard.ts`，`acquire`／`markCompleted`／`markFailed`，`tryInsert ... ON CONFLICT` L152-166）已實作且被測試覆蓋，但 production 程式碼**無任何 `new PgIdempotencyGuard`**（僅測試 new）。`duplicate_input` 分類路徑（`classify.ts:178-189`）需要 `priorInput`，但 `beforeRun` 從未傳入 → 該路徑實際上永不觸發。frontend 每次 submit 產生新 `idempotencyKey`（`frontend/src/lib/interaction-request-metadata.ts:88-104`）卻未用於 dedup，雙擊／重連無法被攔截。

4. **business-cancel 未由 frontend 觸發**：frontend cancel 只做 `thread.stop()`（`App.tsx:441-452`）並本地插入取消 bubble，屬 stream abort 而非 business-cancel；backend 的 `cancel_request` deterministic 分類（`classify.ts:169-176`）、`decideCancellation` 與 compensation 機制未接上前端入口。

5. **語意分類器為 stub**：`UnavailableSemanticInputClassifier`（`interaction-runtime.ts:204-210`）會 throw，`classifyInteractionInput` 於 catch 後回 `new_independent_task`（`classify.ts:223-231`）。`intent_revision` vs `new_independent_task` 的語意判定目前只有 fallback，無法真正分辨。

6. **clarification 事件已定義未 emit**：`INTERACTION_TASK_EVENT_TYPES` 含 `clarification_requested`／`clarification_resumed`（`backend/src/runtime/interaction/events.ts:13-28`），但未見實際 emit。

7. **無同步 re-entry guard**：`ActiveRunOwnership.claim`／`supersede`（`backend/src/runtime/interaction/ownership.ts:143-218`）只在 `beforeRun`（`interaction-runtime.ts:422-594`）執行，而 `beforeRun` 位於 graph 的 invoke／stream 攔截內（`applyInteractionGovernance` Proxy，`interaction-runtime.ts:684-721`），**位於 LangGraph Agent Server 已 enqueue 之後**；無 `dispatching` 中間態、無 generation-aware 的 in-process 同步 guard，dispatch gap 內第二個 submit 可與第一個 race。

綜合而言，X8.8 已建立 ownership 與 interaction policy、X12 已建立 canonical correlation，但**輸入仍無單一正規化契約、ownership 未形成同步 re-entry guard、idempotency 未接線、cancel/clarification 未經 policy 收斂**，正違反 X17 Goal「所有輸入源經單一 validated command lifecycle 進入 Runtime」與 X11 Cross-Layer Invariant #6（terminal 單調收斂）／#5（retry／resume 不暗示副作用可重複）。

## 解決方案

以「契約 + adapter + 同步守衛 + idempotency 接線 + 既有 interaction policy 收斂」收斂：

1. **建立 `NormalizedAgentInput` 契約（backend）**：新增 `backend/src/runtime/input/normalized-agent-input.ts`，定義判別聯合 `prompt`／`clarification_resume`／`cancel`／`command` 與 `AttachmentRef`，並以 strict runtime schema（Zod）驗證；原始輸入（`rawInput`）與正規化輸入分離保存，MUST NOT 互相覆蓋。

2. **單一 `readNormalizedAgentInput` adapter（backend）**：mirror X12 `readExecutionContext` 的單一映射邊界，從 LangGraph input／config metadata／clientInteractionMetadata 建立 `NormalizedAgentInput`；`prompt` ← `getLatestUserMessage`＋attachment metadata、`clarification_resume` ← LangGraph `Command({ resume })`、`cancel` ← explicit cancel signal、`command` ← 保留為可擴充 kind（目前無 concrete wired command，不引入 NL router）。transport type 與 domain 型別分離，內部模組只消費 `NormalizedAgentInput`。

3. **generation-based 同步 Query 守衛（backend）**：新增 `backend/src/runtime/input/query-guard.ts`，狀態機 `idle`／`dispatching`／`running` 以 `(threadId, scopeId)`＋`generation` 為 key；`reserve()` 同步推進 `idle → dispatching` 並以 `ActiveRunOwnership.claim`（durable CAS）為 authority，`dispatch()` 推進 `dispatching → running`，`release()` generation-aware（stale finalizer 不得清除較新 generation 的狀態）。reserve 於 async normalization／dispatch 前執行，使第二個 submit 無法於 dispatch gap 進入。

4. **接線 `PgIdempotencyGuard`（backend）**：`beforeRun` 在 claim 前以 BFF 產出的 trusted dedup key（`x-bff-idempotency-key`，`bff/src/server.ts:376-390`）呼叫 `acquire`；已 completed 的 key 走 `duplicate_input`，回傳既有結果／狀態而不建立新 Run、不重放副作用；並將 `priorInput` 傳入 classify 使 `duplicate_input` 路徑真正觸發。

5. **cancel／clarification_resume／prompt／command 經既有 policy 收斂（backend）**：`prompt` 走既有 classify＋`resolveClassificationDisposition`（supersede／enqueue／reject）；`clarification_resume` 依 `clarificationReplyMode` resume 等待中的 Task；`cancel` 走 `cancel_request` deterministic 分類＋`decideCancellation`；`command` 為 local/client 指令分流（不採 NL keyword router）。語意分類器仍為 stub 的現況不隱瞞：`cancel_request` 與 `duplicate_input` 為 deterministic，`intent_revision` vs `new_independent_task` 的語意判定維持 safe fallback（`new_independent_task`），不引入不可靠的 keyword 分支。

6. **frontend 產生 typed input kind 與雙擊防護**：`handleSubmit` → `prompt`、`handleClarificationResume` → `clarification_resume`、`handleCancel` → 在 `thread.stop()` 之外補 business-cancel 訊號；submit 期間以 dispatch 狀態停用按鈕（雙擊防護），idempotency key 對同一 logical submit 穩定。

7. **bff 只做 transport 驗證**：對 body 中新的 `kind` 判別欄位做 transport 驗證（已知 kind 允許、未知 kind 回 stable validation error），MUST NOT 做語意 routing；idempotency／active-run hint 的既有驗證與覆寫維持不變。

## 受影響範圍

### 受影響套件

- `backend`：`src/runtime/input/normalized-agent-input.ts`（新）、`src/runtime/input/query-guard.ts`（新）、`src/platform/interaction-runtime.ts`（改，接 adapter／guard／idempotency／policy）、`src/runtime/interaction/classify.ts`（改，duplicate_input 傳 priorInput）、`src/runtime/idempotency/`（接線，非新造）、對應 `*.test.ts` 與 contract fixture。
- `bff`：`src/server.ts`（改，`kind` 判別欄位的 transport 驗證）、對應 `server.test.ts`。
- `frontend`：`src/App.tsx`（改，typed kind 與 business-cancel）、`src/lib/interaction-request-metadata.ts`（改，idempotency key 穩定性）、對應 `*.test.tsx`。

### 受影響能力域

- 輸入正規化與輸入契約（`NormalizedAgentInput`）。
- Interaction ownership／re-entry guard（generation-based 同步守衛）。
- Request idempotency（雙擊／重連／重複提交）。
- 取消與 clarification 的 policy 收斂（`cancel_request`／`clarification_resume`）。
- local/client command 與 model work 的分流邊界。

### 既有能力原語（本 Change 接線、不重造）

- X8.8 `ActiveRunOwnership`／`PgActiveRunOwnershipRepository`（`runtime/interaction/ownership.ts`，migration `013_create_active_run_ownership.sql`）。
- X8.8 `InteractionPolicy`、`resolveClassificationDisposition`、`decideCancellation`（`runtime/interaction/classify.ts`、`cancel-decision.ts`、`policy.ts`）。
- `PgIdempotencyGuard`／`idempotency-key`（`runtime/idempotency/`，來自 `add-agent-idempotency-audit`）。
- X12 `ExecutionContext`／`readExecutionContext`（`runtime/execution-context/`）。
- BFF 既有 `getRequestId`／`validateIdempotencyHeader`／`validateActiveRunHint`／`createTrustedRequestDedupKey`／`copyRequestHeaders`（`bff/src/server.ts`）。

## 目標

- 每個受支援輸入源（text／attachments／clarification reply／cancel／command）都產出通過 strict schema 驗證的 `NormalizedAgentInput`。
- 原始輸入與正規化輸入分離保存，正規化不改寫使用者語意。
- attachment 身份與安全只驗證一次；queue 只存 reference，不重複上傳／不重複複製 binary。
- local/client command 在 Graph Run 啟動前分流，且不採 NL keyword router。
- generation-based 同步守衛（`idle`／`dispatching`／`running`）於 async dispatch 前 reserve，同一 interaction scope 不啟動兩個權威 Run。
- stale finalizer 不得清除較新 Run（generation-aware）。
- clarification reply 依 policy resume 到預期 interrupt；duplicate submit 不重複建立 Run 或副作用。
- 缺 attachment、載入失敗、逾時、取消、未支援輸入皆有 stable outcome。

## 非目標

- ❌ 不以 NL keyword router 偵測 command。
- ❌ 不建立第二個佇列／scheduler／Run Runtime（守衛是 governance 層，`ActiveRunOwnership` 是 durable authority，run 執行仍由 LangGraph Agent Server 負責）。
- ❌ 不以 React state 單獨作為 concurrency guard。
- ❌ 不在 queue reordering 時重複上傳 attachment。
- ❌ 不變更既有 Graph ID、公開 BFF route、既有 error-code 語意。
- ❌ 不重造 X8.8 已建立的 ownership／classify／policy（本 Change 在其上補契約、守衛與 idempotency 接線）。
- ❌ 不隱瞞語意分類器為 stub 的現況；不引入不可靠的 keyword 分支補齊語意判定。

## 風險

| 風險 | 緩解 |
|---|---|
| 同步守衛與 `ActiveRunOwnership` 的 durable CAS 競速 | 守衛只做 in-process 快路徑；authority 仍由 DB CAS（`claim`／`supersede`）原子解決，守衛不取代 DB 唯一性 |
| idempotency 接線後誤判為 duplicate 而吞掉新輸入 | key 採 BFF trusted dedup（sha256(tenantId, principalId, routeNamespace, clientKey)），completed 狀態才回 duplicate；failed 狀態允許新 attempt |
| business-cancel 接線後與既有 `thread.stop()` abort 語意混淆 | cancel 訊號走 `cancel_request` deterministic 分類；transport abort 仍是獨立 layer，兩者不互相覆蓋 |
| `command` kind 為 scaffolding、無 concrete command | 型別保留為可擴充、不接 NL router；未接線的 `command` 回 stable `unsupported_command` 而非靜默當成 prompt |
| `readNormalizedAgentInput` 映射錯誤使既有輸入破裂 | adapter 於單一邊界收斂並以 contract test 覆蓋 legacy mapping；`prompt` 預設路徑向後相容於既有 raw string 輸入 |
| 守衛 stale cleanup 清除較新 Run | release 採 generation-aware，舊 generation finalizer 為 no-op |

## 回滾策略

本 Change 為 additive 收斂：新增 `NormalizedAgentInput` 契約、`query-guard` 模組與 adapter，`query-guard` 未 reserve 時回退到既有 `beforeRun` 直接 claim/supersede 路徑；idempotency guard 在無 `x-bff-idempotency-key` 或 `acquire` 失敗（非 duplicate）時退為 pass-through，不阻斷既有輸入。無資料庫 migration（沿用 `013_create_active_run_ownership` 與 idempotency 既有 schema）、無 Graph ID／route／error-code 變更；`prompt` 路徑向後相容，可逐模組 revert（先拔 guard，再拔 idempotency，再拔 command kind）。
