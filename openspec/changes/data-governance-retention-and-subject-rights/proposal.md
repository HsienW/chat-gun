# Proposal：data-governance-retention-and-subject-rights

## 變更摘要

把散落在 bff 與 backend 各 store 的「資料留存、匯出、刪除」能力，收斂為**一個 versioned data inventory + 一個 `GovernedDataStore` 註冊契約 + 一個 deletion coordinator + 一套 durable subject-right workflows**，涵蓋 conversation、checkpoint、memory、event、audit、usage、cache、derived projection 與 X22 引入的 identity stores。以政策驅動 retention（而非逐表寫死 timer）、以 versioned consent record 承接選擇性處理，以 deletion receipt 產生可查證的刪除證據，並以 tombstone 防止被刪除主體／物件被 replay、cache refill 或 late event 靜默重建。

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X23**，屬 Second Stage — Layer 8（Production Product Foundation）；前置 X18（`add-long-term-memory-governance`）、X20（`add-durable-hitl-and-conversation-recovery`）、X21（`enforce-runtime-production-readiness-gate`）、X22（`consumer-identity-and-account-lifecycle`）已 archive。X23 在「不建立第二個 runtime、第二條 authorization 路徑、或 UI-only 的持久狀態近似」的前提下，把隱私／留存要求轉為**可 machine-verify 的 durable workflow**，並預留 X32（artifact）、X33（background work）、X37（personal memory）、X38（usage ledger）的 governed 接點。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，唯讀盤點）：

1. **資料散落在 20+ 張 Postgres table，且無任何 versioned data inventory**：backend migration 001–020 涵蓋 `agent_tasks`／`task_steps`／`task_events`／`idempotency_records`／`audit_events`／`business_effects`／`tool_executions`／`tool_execution_attempts`／`compensation_executions`／`result_references`／`permission_grants`／`permission_decisions`／`active_run_ownership`／`decision_records`／`decision_evidence_refs`／`context_refs`／`authorization_confirmations`／`interrupt_manifests`／`recovery_records`（`backend/src/runtime/persistence/migrations/`）；bff 另有 `identity_accounts`／`identity_users`／`identity_tenants`／`identity_credentials`／`identity_sessions`／`identity_account_tombstones`／`identity_anonymous_migrations`（`bff/src/migrations/001_consumer_identity.up.sql`）。沒有單一來源把每種資料 class 對映到 authoritative store、owner/subject、purpose、sensitivity、retention、export、deletion、legal/audit exception 與 derived copies。

2. **沒有 subject-right workflow**：沒有 data export、account deletion、deletion verification、consent withdrawal。X22 已建立 `identity_account_tombstones`、`deletion_pending` 狀態與帳號 tombstone，但「列舉所有 store 並實際刪除／匯出」的 durable workflow 不存在；目前刪除僅限 identity 層，未涵蓋 conversation／memory／event／audit／projection。

3. **沒有政策驅動 retention**：retention 目前是隱性的（無 per-data-class policy、無 retention expiry workflow）。memory 有 per-record `expiresAt`／native TTL（`backend/src/memory/store/postgres-adapter.ts`），但這是單筆 TTL，不是由 data inventory 統一治理的政策驅動留存。

4. **沒有 versioned consent record**：選擇性處理（personalization、evaluation contribution、proactive background work）尚未建模為 durable、versioned consent record；X35／X33 各自需要的 consent 沒有共享契約。

5. **memory 是 governed data class，但未納入治理**：memory store（`backend/src/memory/store-port.ts`，PostgresStore 依 tenant／principal／domain／scope namespace）已由 X18 建立，但不在任何 data inventory 內；X23 必須把 memory 註冊為 governed data class，而 personal-memory 的產品行為留給 X37。

6. **沒有 deletion coordinator／receipt／物件級 tombstone**：X22 的 tombstone 只覆蓋 identity（`identity_account_tombstones`）；其他 data class（task、memory、event、projection）沒有防止「replay／cache refill／late event 靜默重建已刪物件」的 tombstone；也沒有一份 deletion receipt 記錄 completed／skipped／retained-by-policy／failed。

7. **audit 證據最小化未明確定義**：`audit_events` 已用 redaction（`backend/src/runtime/audit/redaction.ts`）與 opaque principal hash，但沒有把「mutable user data」與「immutable minimum audit evidence」分離，也沒有 documented、identifier-minimized 的 retained audit 保留政策。

8. **cache／derived projection／backup 未納入治理**：Redis（`bff/src/redis-rate-limit.ts`、`backend/src/runtime/lock/`）與 Opik tracing（外部 observability）屬 cache／derived；backup 目前無既有實作（屬 X24），但 X23 必須定義 backup 的 expiry／crypto-erasure 參與政策，避免「刪除後又被 backup 還原」。

綜合而言，v4 runtime 已有 durable store、memory、event、audit、identity tombstone，但**沒有把隱私／留存轉為可查證、可列舉、可刪除的 governed workflow**——這正是 X23 issue 所述「Data rights are executable workflows」與 X23 Cross-Layer Invariant #3（Data rights are executable workflows）的缺口，也違反 AGENTS.md「不得以散落的一行 delete 當完成」「不得把 DB row delete 當成 cache／object／checkpoint／index 已刪」。

## 解決方案

以「單一 versioned data inventory + 單一 `GovernedDataStore` 註冊契約 + 單一 deletion coordinator + additive subject-right routes」收斂，不重造 v4 durable workflow：

1. **建立 versioned `DataInventoryRegistry`**：單一來源記錄每個 data class 的 authoritative store、owner/subject、purpose、sensitivity、retention policy、export behavior、deletion behavior、legal/audit exception、derived copies/caches；versioned 且 startup 驗證，unknown value fail-closed。

2. **定義 `GovernedDataStore` 契約（port）**：`exportSubjectData`／`deleteSubjectData`／`verifySubjectDeletion` 與 registration metadata；新 store 以 registration 被 discover，不改動無關 store 實作、不在中心 switch 逐一 hard-code。

3. **durable subject-right workflows**：export、account deletion、consent withdrawal、retention expiry、deletion verification 以既有 X20 durable resume、task/step/event、X14 side-effect ledger 承接；具 typed status、retry、deadline 與 terminal receipt，不把 DB row delete 當完成。

4. **deletion coordinator**：列舉並處理所有已註冊 store 與 projection；`deleteSubjectData` 為 idempotent、resumable、bounded、independently observable；產出 `DeletionReceipt`（completed／skipped／retained-by-policy／failed 的非敏感證據）。

5. **tombstone 一般化**：對 deleted subject／object 建立物件級 tombstone，防止 replay／cache refill／late event 靜默重建；tombstoned subject 的 late event 依政策 reject／quarantine／redact。

6. **policy-driven retention**：retention policy 為 versioned config（per data class，含 default 與驗證），不做 hardcoded per-table timer；retention expiry 為 idempotent、bounded sweep workflow（排程屬 X33，X23 只提供可觸發的 durable sweep 機制）。

7. **versioned consent records**：consent store（backend Postgres）承載 personalization／evaluation contribution／proactive background work 的選擇性處理；consent withdrawal 只改未來處理行為，不重寫歷史 facts。

8. **audit evidence minimization**：分離 mutable user data 與 immutable minimum audit evidence；retained audit evidence 最小化且 identifier-minimized（opaque／hashed ID），並以 inventory 記錄 legal/audit exception。

9. **cache／derived／backup 參與治理**：cache 與 derived projection 以「可重建、可清除、不承載唯一事實」原則納入 deletion／verification；backup 以 documented expiry／crypto-erasure 參與（實際 backup/restore 屬 X24，本 Change 只定義政策與 deletion-verification 對 backup 的期待）。

10. **additive subject-right BFF routes**：`POST /api/subject-rights/export`、`POST /api/subject-rights/deletion`、`POST /api/subject-rights/consent`、`GET /api/subject-rights/:workflowId` 皆 additive，不觸及既有 `/api/langgraph/*` proxy、Graph ID 或 error-code 語意。

## 受影響範圍

### 受影響套件

- `bff`：subject-right request API boundary（export／deletion／consent route、validation／auth／rate-limit／typed error mapping）；identity store 的 `GovernedDataStore` adapter（匯出與刪除 identity 資料、tombstone）；deletion receipt 的 non-sensitive 投影。
- `backend`：`DataInventoryRegistry`、`GovernedDataStore` 契約與各 backend store 註冊、deletion coordinator、subject-right durable workflows（export／deletion／retention expiry／deletion verification）、retention policy engine、consent records store、物件級 tombstone、audit evidence minimization、cache／derived 治理。
- `frontend`：subject-right 請求入口（export／deletion／consent）、workflow 狀態呈現、deletion receipt 顯示；不建 org admin UI。

### 受影響能力域

- Data governance（data inventory、data classification、retention、consent、subject rights、export、deletion、verification）。
- 資料歸屬與留存（conversation／checkpoint／memory／event／audit／usage／cache／projection 的 governed 生命週期）。
- 可觀測與審計（audit evidence minimization、deletion receipt、retention/consent 的 typed 事件與錯誤）。

### 既有能力原語（本 Change 接線、不重造）

- durable waiting／resume／terminal contract（`add-durable-hitl-and-conversation-recovery`，X20）與 versioned event envelope（`version-runtime-event-and-terminal-contract`，X19）。
- 統一 tool dispatch／side-effect ledger／idempotency（`unified-tool-dispatch-pipeline`、`side-effect-tool-execution-runtime`）。
- memory store port（`long-term-memory-governance`，X18）。
- consumer identity／tombstone／`deletion_pending`（`consumer-identity`，X22）。
- `ExecutionContext`／`RuntimeIdentityStatusPort` 與 opaque identity 傳播（`canonical-execution-context`、`consumer-identity`）。

## 目標

- 一份 versioned data inventory 覆蓋 X22 為止引入的每個 persistent store 與 derived projection。
- export 與 deletion 以 durable workflow 執行，具 status、retry、deadline 與 terminal receipt。
- 新 governed store 可經 registration 加入，不修改無關 store 實作。
- integration test 涵蓋 partial failure、retry、並行帳號活動、late event delivery。
- cross-user 與 cross-tenant export leakage test 通過。
- retained audit／accounting evidence 明確 documented 且 identifier-minimized。
- deletion verification 證明已註冊 store 不再暴露 deleted subject data。
- consent withdrawal 改變未來處理行為，而不重寫歷史 facts。

## 非目標

- ❌ 散落的一行 delete 且無 completion receipt。
- ❌ 把 DB row delete 當成 cache／object／checkpoint／search index 已刪。
- ❌ 用 consent 文字取代 versioned consent record。
- ❌ 在 user export 暴露 raw internal audit log。
- ❌ 在本 Change 實作 personal-memory ranking／inference policy（屬 X37）。
- ❌ 實作 backup／restore 機制（屬 X24）；本 Change 只定義 backup 參與 retention／deletion 的政策。
- ❌ 建立第二個 runtime、第二條 authorization 路徑、或第二個 scheduler（retention sweep 排程屬 X33）。
- ❌ 實作 org administration UI 或 marketplace／跨租戶管理介面。

## 風險

| 風險 | 緩解 |
|---|---|
| deletion 只刪了部分 store，留下 cache／object／checkpoint／index 殘留 | `GovernedDataStore` 註冊契約 + deletion coordinator 列舉 + `verifySubjectDeletion` 證明各 store 不再暴露；residual 未註冊 store 由 inventory completeness test 擋下 |
| 刪除與 active run ／ late event 競爭 | 物件級 tombstone + late event reject／quarantine／redact；deletion workflow 與 X20 resume 邊界協同 |
| export 洩漏其他 subject 資料（shared conversation／tenant record） | cross-user／cross-tenant leakage test；export handler 以 durable owner/subject 欄位過濾，不以顯示文字反推 |
| retention policy 變成散落的 per-table timer | 單一 versioned retention policy（inventory 內），sweep 由 coordinator 統一執行 |
| 刪除後又被 backup 還原 | inventory 記錄 backup expiry／crypto-erasure 政策；deletion-verification 對 backup 提出 documented 期待（實際實作 X24） |
| consent 撤銷重寫歷史 facts | consent record 為 append-only versioned facts；withdrawal 只改 future processing |
| audit 證據過度保留 PII | audit evidence minimization：mutable user data 與 immutable minimum audit 分離，identifier-minimized |
| subject-right workflow 失敗被誤當成功 | 失敗的 deletion part 讓整體 workflow incomplete 且 retryable；receipt 明確標記 failed／retained-by-policy |

## 回滾策略

本 Change 為 additive + registration 型變更：`DataInventoryRegistry`、`GovernedDataStore` port、subject-right routes、consent store 與 retention policy 皆為新增；既有 store 的實作行為不變，只是額外註冊為 governed store（export／delete／verify 為新增方法，不影響既有讀寫路徑）。deletion／retention sweep 由 feature flag／policy 啟用，可停用回到「不執行刪除／留存掃描」的既有行為。subject-right routes 為 additive，不觸及既有 `/api/langgraph/*`、Graph ID 或 error-code 語意。若驗證失敗，可逐套件 revert，不變更既有 durable schema 歷史、不改寫既有 facts。
