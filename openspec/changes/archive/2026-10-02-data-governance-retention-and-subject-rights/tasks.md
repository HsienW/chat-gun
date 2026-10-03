# Tasks：data-governance-retention-and-subject-rights

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。T0 先建立 cross-layer governance contract fixture，後續 Task 一律引用該 fixture，避免循環依賴。未完成的驗證如實標記，不假稱通過。live 驗證（真實 subject-right 對外部 IdP、正式 backup／restore 的 deletion-verification）屬後續 L 證據，於回報中明確列出未驗證項。

## T0 建立 cross-layer data-governance contract fixture

> 前置：無。本 Task 必須最先完成，T1–T10 的測試與驗證皆引用此 fixture。

- [x] 建立 single-source cross-layer fixture：`DataInventoryRegistry` entry schema（dataClassId、authoritativeStore、ownerSubject、purpose、sensitivity、retentionPolicy、exportBehavior、deletionBehavior、legalAuditException、derivedCopiesCaches）、`GovernedDataStore` 契約（`id`、`exportSubjectData`、`deleteSubjectData`、`verifySubjectDeletion`、`subjectKey`、resolution tier）、`SubjectDataRequest`／`SubjectDeletionRequest`／`SubjectDeletionVerification`、`DeletionPartResult`（`completed`／`skipped`／`retained_by_policy`／`failed`）、sensitivity enum、retention policy version、consent record schema、tombstone schema、subject correlation index schema（`correlationKey → accountId/tenantId/principalId`）。
- [x] 以 fixture 驗證 unknown sensitivity／retention／schema version fail-closed；request 只接受 opaque subject ID（client raw identity 不採納）。

驗證命令：

```bash
cd backend
npm run test
npm run build
```

## T1 `DataInventoryRegistry` 與 registration

> 依賴：T0。

- [x] 實作 versioned `DataInventoryRegistry`（single-source、startup 驗證、未知值 fail-closed）。
- [x] 實作 declarative registration：每個 store 於註冊點宣告自身 entry，coordinator 依 registry discover，不 hard-code 中心 switch。
- [x] 建立 inventory completeness test：列舉 backend migration table（001–020）與 bff identity table，證明每個持久化事實皆對應 entry；未註冊者回報為缺口；並以 **subject-reachability** 為維度（每個 data class 可依 direct column 或 correlation index 解析至 subject），unreachable 者回報為缺口。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/
npm run build
```

## T2 `GovernedDataStore` 契約與 runtime store 註冊

> 依賴：T0、T1。

- [x] 定義 `GovernedDataStore` 契約與 request/result 型別（strict runtime validation）。
- [x] 建立 subject correlation index（additive table）：runtime 寫入時由 `ExecutionContext`（X22 opaque identity）填充 `correlationKey → accountId/tenantId/principalId`；MUST NOT 從 metadata JSONB 反推。
- [x] 將既有 backend store 註冊為 governed store：tasks／steps／events／audit／memory／checkpoint／provenance（decision_records／decision_evidence_refs／context_refs）／authorization（permission_grants／permission_decisions）／side-effect（result_references／business_effects）／idempotency／recovery（recovery_records）／confirmations／interrupt_manifests／compensation／tool_executions。
- [x] 每個 store 註冊時宣告 `subjectKey`（direct column 或 correlation key）與 resolution tier；unreachable store 以 additive migration 補 subject column 或記錄 legal/audit exception，MUST NOT 靜默 skip。
- [x] 實作各 store 的 `exportSubjectData`／`deleteSubjectData`／`verifySubjectDeletion`，以 durable owner/subject 欄位過濾。
- [x] 新增 test：各 store 三個方法成功／失敗、idempotent、以 owner/subject 過濾不洩漏其他 subject。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T3 deletion coordinator 與 deletion receipt

> 依賴：T1、T2。

- [x] 實作 deletion coordinator：列舉 registry、對每個 store 呼叫 `deleteSubjectData`（idempotent、bounded、resumable、independently observable）。
- [x] 彙整 `DeletionReceipt`：記錄 completed／skipped／retained-by-policy／failed 的 non-sensitive 證據。
- [x] 新增 test：coordinator 列舉所有 store；單一 store 失敗不偽報成功；receipt 四類結果正確；receipt 不落 raw credential／PII。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T4 subject-right durable workflows（export／deletion／verification）

> 依賴：T3、X20 durable resume。

- [x] 實作 export／deletion／deletion-verification 為 durable workflow（承接 X20 resume），具 typed status（`requested → in_progress → completed | failed | expired`）與 retry、deadline。
- [x] 失敗 part 留下 retryable 記錄，讓整體 incomplete；verification 結果納入 receipt／terminal 狀態。
- [x] 新增 test：crash 後 resume 不重複處理已完成 store；部分失敗 retry；export 下載連結過期安全處理。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T5 retention policy engine 與 retention sweep

> 依賴：T1、T2。

- [x] 實作 versioned retention policy（per data class、default、validation、unknown fail-closed），不做 per-table timer。
- [x] 實作 retention expiry 為 idempotent、bounded sweep workflow，可 explicit 觸發與安全重入（排程屬 X33）。
- [x] 新增 test：policy 驅動到期；sweep 可重入且不重複；失敗留下 retryable；bounded scan。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T6 consent records 與 withdrawal enforcement

> 依賴：T0、T1。

- [x] 實作 versioned、append-only consent records store（consentId、accountId、policyVersion、status、scope、時間）。
- [x] 實作 consent withdrawal：只改 future processing，不改寫歷史 facts；依賴該 consent 的 background／evaluation contribution 於 resume 邊界檢查最新 consent。
- [x] 新增 test：consent append-only；withdrawal 只影響未來；以 record 而非文字判定。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T7 物件級 tombstone、late event 與 audit minimization

> 依賴：T0、T3。

- [x] 一般化物件級 tombstone（沿用 X22 最小保留欄位）；tombstone hit 回傳 `deleted`（非 `not_found`）；tombstone cache TTL ≥ active record TTL；cache miss 回源。
- [x] late event 攜帶 tombstoned subject → reject／quarantine／redact（依 policy）。
- [x] audit evidence minimization：分離 mutable user data 與 immutable minimum audit evidence，identifier-minimized，documented legal/audit exception。
- [x] 新增 test：tombstone 擋 replay／cache refill／late event；audit retained 最小化且不含 raw PII。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T8 bff subject-right routes 與 identity `GovernedDataStore` adapter

> 依賴：T0、T3、T4、T7（引用 fixture、workflow、identity tombstone）。

- [x] 新增 additive routes：`POST /api/subject-rights/export`、`POST /api/subject-rights/deletion`、`POST /api/subject-rights/consent`、`GET /api/subject-rights/:workflowId`（不觸及既有 `/api/langgraph/*`）。
- [x] auth／validation／rate-limit 沿用既有路徑；server-authoritative subject 由 X22 identity 解析，client `accountId`／`tenantId` 不採納。
- [x] 實作 identity store 的 `GovernedDataStore` adapter（export／delete／verify）；bff 為 identity table 唯一寫入者，backend coordinator 經**內部 HTTP 邊界**呼叫（internal-only endpoint、service-to-service auth、circuit breaker／timeout、idempotency key 穿透、typed failure）。
- [x] 映射 typed failure（store unavailable、workflow not found、export link expired、cross-tenant denied）為 stable error code + safe message；deletion receipt non-sensitive 投影。
- [x] 新增 test：routes auth／validation；identity adapter export/delete/verify；typed failure 映射；receipt 投影不落敏感資料。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T9 frontend subject-right UI

> 依賴：T0 fixture（frontend 引用 subject-right 狀態／receipt 契約）。

- [x] subject-right 請求入口（export／deletion／consent）與進行中／terminal 狀態。
- [x] deletion receipt 顯示（completed／skipped／retained-by-policy／failed），不以顯示文案反推狀態。
- [x] consent 開關與 withdrawal 確認；不建 org admin UI。
- [x] 新增 test：請求入口、狀態呈現、receipt 顯示、consent 互動。

驗證命令：

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## T10 cross-user / cross-tenant leakage 與 denial integration test

> 依賴：T2、T4、T8（需 backend 與 bff 兩入口皆就緒）。

- [x] 新增 integration test：export 不洩漏其他 subject 資料（shared conversation／tenant-wide record）；cross-user 與 cross-tenant export／deletion 被拒。
- [x] 覆蓋兩個入口：經 BFF（subject-right route 解析後拒絕）與 backend（deletion coordinator 於列舉前 deny）。
- [x] 斷言 deny 為 typed reason code 且不呼叫下游；receipt 不落其他 subject 資料。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/
cd ../bff
npm run test
```

## T11 三套件全量驗證

> 依賴：T1–T10 全數完成。

- [x] 執行 frontend／bff／backend 完整 lint／test／build。
- [x] 如實記錄 skipped／未驗證項與 live 驗證缺口（真實外部 IdP 的 subject-right、正式 backup／restore 的 deletion-verification 屬 L 證據）。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run build && npm run test
cd frontend && npm run lint && npm run test && npm run build
```
