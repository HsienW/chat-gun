# Design：data-governance-retention-and-subject-rights

## 定位

本 Change 是**跨 bff／backend／frontend 的資料治理邊界升級**：核心是「一個 versioned `DataInventoryRegistry` + 一個 `GovernedDataStore` 註冊契約 + 一個 deletion coordinator + 一套 durable subject-right workflows」，把散落各 store 的 export／deletion／retention／consent 收斂為可 machine-verify 的 governed 生命週期。實作以 **additive 組裝 + registration + feature-flag 啟用** 為主，不做破壞性遷移。

- `bff`：subject-right API boundary——additive export／deletion／consent routes、validation／auth／rate-limit／typed error mapping、identity store 的 `GovernedDataStore` adapter、deletion receipt 的 non-sensitive 投影。
- `backend`：governance authority——`DataInventoryRegistry`、`GovernedDataStore` 契約與 runtime store 註冊、deletion coordinator、subject-right durable workflows（export／deletion／retention expiry／deletion verification）、retention policy engine、consent records store、物件級 tombstone、audit evidence minimization。
- `frontend`：subject-right 請求入口、workflow 狀態呈現、deletion receipt 顯示（不建 org admin UI）。

本 Change 無 Tool／MCP 變更，故「Tool／MCP 安全與權限分析」不適用；但仍沿用既有 authorization（X13）與 identity status enforcement（X22）於 subject-right 入口 fail-closed。

## 現況盤點（已驗證的事實）

| 事實 | 位置 | 對本設計的意義 |
|---|---|---|
| backend durable store 有 20 張 migration table | `backend/src/runtime/persistence/migrations/001–020`（`agent_tasks`、`task_steps`、`task_events`、`idempotency_records`、`audit_events`、`business_effects`、`tool_executions`、`tool_execution_attempts`、`compensation_executions`、`result_references`、`permission_grants`、`permission_decisions`、`active_run_ownership`、`decision_records`、`decision_evidence_refs`、`context_refs`、`authorization_confirmations`、`interrupt_manifests`、`recovery_records`） | 每個 table 皆為 inventory data class 候選；completeness test 以此為對照事實 |
| bff identity store 有 7 張 table | `bff/src/migrations/001_consumer_identity.up.sql`（accounts／users／tenants／credentials／sessions／account_tombstones／anonymous_migrations） | identity 資料屬 governed data class；bff 為其單一寫入者 |
| memory store 為 governed 但未納入 | `backend/src/memory/store-port.ts`、`store/postgres-adapter.ts`（PostgresStore 依 tenant／principal／domain／scope namespace，native TTL） | 註冊為 governed data class；personal-memory 產品行為留 X37 |
| audit 已 redaction + opaque principal hash | `backend/src/runtime/audit/pg-audit-logger.ts`、`redaction.ts` | 分離 mutable user data 與 immutable minimum audit evidence |
| durable resume／event／side-effect ledger 已就緒 | `durable-hitl-conversation-recovery`、`runtime-event-contract`、`side-effect-tool-execution-runtime` | subject-right workflows 承接既有 durable 原語，不另造 runtime |
| identity tombstone 已就緒（僅 identity） | `bff/src/migrations/001_consumer_identity.up.sql`（`identity_account_tombstones`）、X22 | 一般化為物件級 tombstone |
| `deletion_pending` 狀態已於 X22 引入 | `openspec/specs/consumer-identity/spec.md` | subject-right deletion workflow 與帳號狀態機協同 |

## 治理所有權與跨層邊界

- **DataInventoryRegistry 與 GovernedDataStore 契約** 為 backend 的單一事實來源（如同 X22 的 `PrincipalKind` 契約）；每筆 entry 具 schema version、單一來源、未知值 fail-closed。
- **deletion coordinator 與 subject-right workflows 在 backend**：backend 是 durable workflow runtime（X20 resume、task/step/event、side-effect ledger）的唯一權威，不在 bff 重造第二個 workflow state machine。
- **identity 資料的刪除由 bff 單一寫入者執行**：identity store 以 bff-hosted `GovernedDataStore` adapter 註冊，backend coordinator 經**內部 governed-store 邊界**呼叫（bff 仍是 identity table 的唯一寫入者；backend MUST NOT 直接寫 identity table，沿用 X22「backend 不得直接寫 account/session store」）。transport 採**內部 HTTP 邊界**（詳見「GovernedDataStore transport」節，含選項評估與採用理由）；「bff 單一寫入者」與「backend 只協調」為不可協商的 authority 邊界。
- **feature flag**：subject-right deletion／retention sweep 由 config 啟用（如 `SUBJECT_RIGHTS_ENABLED`／`RETENTION_SWEEP_ENABLED`，runtime-config 單一來源、啟動驗證）；`false` 回退至「不執行刪除／留存掃描」的既有行為。停用路徑 MUST 有回歸測試。

## 契約

### `DataInventoryRegistry`

每筆 data class entry 至少含：

```text
dataClassId（stable ID）
authoritativeStore
ownerSubject（subject 維度：accountId/tenantId/principalId 歸屬欄位）
purpose
sensitivity（typed enum）
retentionPolicy（versioned ref）
exportBehavior
deletionBehavior
legalAuditException（optional, documented）
derivedCopiesCaches（清單）
```

- versioned、single-source；startup 驗證，未知 schema version／sensitivity／retention value fail-closed。
- registration 為 declarative：每個 store 於註冊點宣告自身 entry，deletion coordinator 依 registry discover，不改中心 switch。

### `GovernedDataStore`（port）

```ts
interface GovernedDataStore {
  readonly id: string;
  exportSubjectData(request: SubjectDataRequest): Promise<ExportPartResult>;
  deleteSubjectData(request: SubjectDeletionRequest): Promise<DeletionPartResult>;
  verifySubjectDeletion(request: SubjectDeletionVerification): Promise<VerificationResult>;
}
```

- `SubjectDataRequest`／`SubjectDeletionRequest`／`SubjectDeletionVerification` 皆以 opaque `accountId`／`tenantId`／`principalId` 表達 subject，MUST NOT 接受 client 提供的 raw identity。
- `DeletionPartResult` 為 discriminated union：`completed`／`skipped`／`retained_by_policy`／`failed`；`failed` 讓整體 workflow incomplete 且 retryable。
- idempotent、resumable、bounded：以 idempotency key（`subjectId + dataClassId + workflowId`）去重；單一 store 失敗不阻斷其他 store 的獨立結果記錄。

### Subject-right workflow 狀態

```text
export:    requested → in_progress → completed | failed | expired
deletion:  requested → in_progress → completed | failed
retention: sweep（per-item terminal，bounded）
verification: verifying → verified | failed
```

- 承接 X20 durable resume：crash 後可 resume，不重複處理已完成 store。
- 失敗 part 留下 retryable 記錄；deletion receipt 記錄 completed／skipped／retained-by-policy／failed 的 non-sensitive 證據。

### Retention policy（versioned config）

- per-data-class retention 為 versioned config（含 default、validation、unknown fail-closed）；不做 hardcoded per-table timer。
- retention expiry 為 idempotent、bounded sweep workflow，可 explicit 觸發與安全重入；**排程**不屬本 Change（屬 X33），sweep 本身可被外部觸發。

### Consent records（backend）

- versioned、append-only consent record（`consentId`、`accountId`、`policyVersion`、`status`、`grantedAt`／`revokedAt`、`scope`）。
- consent withdrawal 只改 future processing，不改寫歷史 facts；依賴該 consent 的 background／evaluation contribution 於 resume 邊界檢查最新 consent。

### Tombstone 一般化

- 對 deleted subject／object 建立物件級 tombstone（沿用 X22 最小保留欄位：opaque `id` hash、`deletedAt`、`tombstoneVersion`、`deletionReason`）。
- tombstone hit 回傳明確 `deleted`（非 `not_found`）；tombstone cache TTL ≥ active record TTL；cache miss 回源查 durable tombstone。
- late event 攜帶 tombstoned subject → 依 policy reject／quarantine／redact。

## Subject ownership resolution（回應 review PLAN-MAJOR-001）

多數 backend durable table 無直接 `accountId`／`principalId` 欄位，只以 `task_id`／`run_id`／`thread_id`／`step_id`／`tool_execution_id` 關聯。`GovernedDataStore` 的 export／delete／verify 以 subject 過濾時，MUST 依下列三層解析鏈，MUST NOT 解析 metadata JSONB 或 client 提供欄位：

1. **Tier 1 — direct subject column**：store 已具 `account_id`／`principal_id`／`tenant_id`（identity tables、`result_references`、`business_effects`、memory namespace 的 tenant／principal）→ 直接以 subject 欄位過濾。
2. **Tier 2 — correlation-key mediated**：store 只有 `task_id`／`run_id`／`thread_id`／`step_id`／`tool_execution_id`（`agent_tasks`、`task_steps`、`task_events`、`tool_executions`、`tool_execution_attempts`、`decision_records`、`interrupt_manifests`、`recovery_records`、`active_run_ownership`、`idempotency_records`）→ 經 **subject correlation index** 解析。此 index 為 additive table，於 runtime 寫入時由 `ExecutionContext`（X22 已傳播的 opaque identity）填充 `correlationKey → accountId/tenantId/principalId`，是 authoritative 事實，MUST NOT 從 metadata JSONB 反推。
3. **Tier 3 — unreachable**：既無 direct column 亦無 correlation key 的 store → MUST 以 additive migration 補 subject column，或明確記錄為 legal/audit exception；MUST NOT 靜默 skip。

每個 `GovernedDataStore` 註冊時 MUST 宣告其 `subjectKey`（direct 或 correlation）與 resolution tier；inventory completeness test MUST 以 subject-reachability 為維度（不單是「已註冊」，還必須「可解析至 subject」），unreachable 者回報為缺口。

## GovernedDataStore transport（回應 review PLAN-MAJOR-002）

backend coordinator 需呼叫 bff-hosted identity `GovernedDataStore`，是「backend 主動呼叫 bff」的反向通訊。方案評估：

| 方案 | 說明 | 取捨 |
|---|---|---|
| 共享 Postgres（backend 直接讀寫 identity table） | 零跨進程呼叫 | 違反 bff 單一寫入者（X22），backend 越權，**不採用** |
| **內部 HTTP 邊界（bff 暴露 internal governed-store endpoint，backend 呼叫）** | 同步 request/response、保留單一寫入者 | 需內部 auth／circuit breaker／timeout／typed failure；**採用** |
| 事件式（backend 發 deletion intent，bff 訂閱執行） | async、解耦 | 需 completion feedback、增加收據彙整複雜度，v1 過重，不採用 |

**採用內部 HTTP 邊界**，約束如下：

- endpoint 為 **internal-only**（非 public subject-right route），走獨立網路邊界，不經 public proxy 路徑。
- 認證為 service-to-service（short-lived、scoped 的內部 credential），但 subject 解析仍由 server-authoritative durable record 決定，MUST NOT 採納 client identity。
- idempotency key 由 deletion coordinator 穿透至 bff adapter，維持 idempotent、resumable。
- 失敗為 typed failure（沿用 X22 typed identity failure taxonomy），套用 circuit breaker／timeout，不造成死鎖（backend 等 bff 的呼叫為 bounded，bff 不反向依賴 backend deletion coordinator）。

## 分層設計

### bff

1. 新增 additive subject-right routes：`POST /api/subject-rights/export`、`POST /api/subject-rights/deletion`、`POST /api/subject-rights/consent`、`GET /api/subject-rights/:workflowId`（皆不觸及既有 `/api/langgraph/*`）。
2. auth／validation／rate-limit 沿用既有路徑；server-authoritative subject 由 X22 identity 解析，client 提供的 `accountId`／`tenantId` 不採納。
3. identity store 的 `GovernedDataStore` adapter：export（identity 資料）、delete（tombstone／刪除）、verify（identity 資料不再暴露）；bff 為 identity table 唯一寫入者。
4. 映射 typed failure（store unavailable、workflow not found、export link expired、cross-tenant denied）為 stable error code + safe message（non-leaking）。
5. deletion receipt 的 non-sensitive 投影（不暴露 raw identity、其他 subject 資料、unmasked PII）。

### backend

1. `DataInventoryRegistry`：versioned、startup 驗證、未知值 fail-closed、registration-based。
2. `GovernedDataStore` 契約 + 各 runtime store 註冊（tasks／steps／events／audit／memory／checkpoint／provenance／authorization／side-effect／idempotency／recovery／confirmations／interrupts／compensation／tool-executions／business-effects／result-references）。
3. deletion coordinator：列舉 registry、對每個 store 呼叫 `deleteSubjectData`（idempotent、bounded、observable）、彙整 receipt。
4. subject-right durable workflows（export／deletion／retention expiry／deletion verification）承接 X20 durable resume；typed status、retry、deadline、terminal receipt。
5. retention policy engine（versioned config）與 retention sweep workflow。
6. consent records store（versioned、append-only）與 consent withdrawal 於 resume 邊界的 enforcement。
7. 物件級 tombstone 與 late event reject／quarantine／redact。
8. audit evidence minimization：分離 mutable user data 與 immutable minimum audit evidence，identifier-minimized。
9. architecture test：backend 不得直接寫 identity table；deletion coordinator 不得 hard-code 中心 switch；retention 不得以 per-table timer 實作。

### 資料庫 migration（additive）

新增 governed 相關 table（皆 additive，不 drop 既有 table）：

- `subject_right_workflows`（workflowId、type、subjectId、status、deadline、receipt ref、timestamps）。
- `deletion_receipts`（receiptId、workflowId、per-store result、timestamps；non-sensitive）。
- `consent_records`（consentId、accountId、policyVersion、status、scope、timestamps）。
- `data_tombstones`（subjectId/objectId hash、deletedAt、tombstoneVersion、deletionReason）。
- 沿用既有 migration 慣例與 rollback 策略（additive down migration）；opaque ID 以 fixed-width/hashed 儲存，MUST NOT 存 raw token／PII。

### frontend

1. subject-right 請求入口（export／deletion／consent）與進行中／terminal 狀態。
2. deletion receipt 顯示（completed／skipped／retained-by-policy／failed），不以顯示文案反推狀態。
3. consent 開關與 withdrawal 確認；不建 org admin UI。

## 相容性設計

1. 既有 store 讀寫行為不變；`GovernedDataStore` 的 export／delete／verify 為新增方法。
2. subject-right routes 為 additive；不變更既有 Graph ID、既有 BFF route 語意或既有 error-code 語意。
3. 既有帳號 `deletion_pending`／tombstone（X22）語意不變；deletion workflow 與其協同，不取代。
4. feature flag 停用時回退至「不執行刪除／留存掃描」的既有行為。
5. 新 table／欄位為 additive，不 drop 既有 table；不變更既有 migration 歷史。

## 資料流

```text
Browser → BFF subject-right route（auth/validation/rate-limit）
  → server-authoritative subject 解析（X22 identity，client value 不採納）
  → 委派 backend subject-right durable workflow（export/deletion/consent）
  → deletion coordinator 列舉 DataInventoryRegistry 的 governed store
  → 對每個 store 呼叫 export/delete/verify（idempotent、bounded、observable）
  → identity store 經 bff GovernedDataStore adapter（bff 單一寫入者）
  → retention policy engine 判定到期；consent 於 resume 邊界 enforcement
  → 彙整 deletion receipt（completed/skipped/retained-by-policy/failed，non-sensitive）
  → tombstone 擋 replay/cache refill/late event；verification 證明不再暴露
  → BFF 投影 receipt 與 workflow status → frontend
```

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 散落的一行 delete | 零成本 | 無 receipt、無 verification、無法證 cache／object／checkpoint 已刪，違反 X23，不採用 |
| 中心 switch 逐一 hard-code store | 單一位置 | 新增 store 需改中心 switch，違反 registration 要求，不採用 |
| deletion workflow 放在 bff | 少一個跨層邊界 | 重造 durable workflow state machine，違反「單一 runtime」，不採用 |
| backend 直接寫 identity table | 少一個 port | 違反 bff identity 單一寫入者（X22），越權，不採用 |
| per-table hardcoded retention timer | 簡單 | 散落、不可 version、不可統一驗證，違反 policy-driven，不採用 |
| 本方案（registry + GovernedDataStore + coordinator） | 統一治理、registration、durable | 需跨層 governed-store 邊界；以 completeness test 與 cross-layer fixture 守護 |

## 風險與緩解

- **殘留資料（cache／object／checkpoint／index）**：`verifySubjectDeletion` + inventory completeness test；residual 未註冊 store 標記為缺口。
- **刪除與 active run／late event 競爭**：物件級 tombstone + late event reject／quarantine／redact；與 X20 resume 邊界協同。
- **export 洩漏其他 subject**：cross-user／cross-tenant leakage test；以 durable owner/subject 欄位過濾。
- **retention 散落**：單一 versioned retention policy；sweep 由 coordinator 統一執行。
- **backup 還原 deleted 資料**：inventory 記錄 backup expiry／crypto-erasure 政策（實際 backup/restore 屬 X24）。
- **consent 撤銷重寫歷史**：append-only versioned consent；withdrawal 只改 future。
- **audit 過度保留 PII**：audit evidence minimization，identifier-minimized。
- **workflow 失敗被誤當成功**：failed part 讓整體 incomplete 且 retryable；receipt 明確標記。

> **基於未驗證假設（沿用 X11 約束）**：backend coordinator 經內部 governed-store 邊界呼叫 bff identity 刪除的即時性，依賴「該內部邊界可用且可於 resume 邊界重入」。此為 D／V 支持但尚未取得 L（正式部署）證據的假設；本 Change 以 deterministic + mock integration 證明契約，live 驗證另列於 tasks，不宣稱正式部署已證實。
