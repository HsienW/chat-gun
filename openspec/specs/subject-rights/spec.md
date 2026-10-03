# subject-rights Specification

## Purpose

定義 subject data export、deletion、verification、tombstone 與跨 subject 存取控制契約。

## Requirements

### Requirement: Export 為 durable workflow 且不洩漏其他 subject 資料

data export MUST 以 durable workflow 執行，具 typed status、retry、deadline 與 terminal receipt；export handler MUST 依 durable owner/subject 欄位過濾，MUST NOT 透過 shared conversation、group resource、log 或 tenant-wide record 洩漏其他 subject 資料。

#### Scenario: export 涵蓋 subject 自身資料

- GIVEN 一個 subject 的 export request
- WHEN 執行 export workflow
- THEN MUST 依 `GovernedDataStore.exportSubjectData` 列舉並匯出該 subject 資料
- AND MUST 產生 terminal receipt 記錄 completed／skipped／failed

#### Scenario: export 不洩漏其他 subject

- GIVEN 一個 subject 與他人共享 conversation 或同 tenant 有其他 subject 資料
- WHEN 執行 export
- THEN MUST NOT 匯出其他 subject 的資料
- AND MUST 通過 cross-user 與 cross-tenant leakage test

#### Scenario: export 部分失敗留下 retryable 記錄

- GIVEN 某 governed store 的 export 部分寫入失敗
- WHEN 執行 export
- THEN 整體 workflow MUST 保持 incomplete 且 retryable
- AND MUST NOT 回報成功

#### Scenario: export 下載連結過期安全處理

- GIVEN 一份 export 的下載連結已過期
- WHEN 存取該連結
- THEN MUST 回傳 typed、non-leaking 過期錯誤
- AND MUST NOT 以過期連結持續暴露資料

### Requirement: Deletion 經 deletion coordinator 列舉所有 store 且 idempotent

account deletion MUST 以 durable workflow 經 deletion coordinator 列舉並處理所有已註冊 store 與 projection；`deleteSubjectData` MUST 為 idempotent、resumable、bounded、independently observable，且 MUST NOT 因單一 store 失敗而偽報整體成功。

#### Scenario: coordinator 列舉所有 store

- GIVEN 一個 deletion request
- WHEN 執行 deletion workflow
- THEN deletion coordinator MUST 列舉 inventory 中所有 governed store 與 projection
- AND 對每個 store 呼叫其 `deleteSubjectData`

#### Scenario: 刪除 idempotent 且 resumable

- GIVEN deletion 進行中被中斷並重試
- WHEN 再次執行同一 deletion
- THEN MUST 續跑且不重複處理已完成 store
- AND 已處理 store 的結果 MUST 可追溯

#### Scenario: 單一 store 失敗不偽報成功

- GIVEN deletion 中某 store 失敗
- WHEN 該 store 的 `deleteSubjectData` 回傳 failed
- THEN 整體 workflow MUST 保持 incomplete 且 retryable
- AND receipt MUST 標記該 store 為 failed

### Requirement: Deletion receipt 提供非敏感完成證據

deletion MUST 產出 `DeletionReceipt`，以非敏感證據記錄 completed、skipped、retained-by-policy 與 failed 步驟；receipt MUST NOT 含 raw credential、token、unmasked PII 或其他 subject 資料。

#### Scenario: receipt 區分四類結果

- GIVEN 一次 deletion 完成
- WHEN 讀取 receipt
- THEN MUST 區分 completed／skipped／retained-by-policy／failed
- AND 每類 MUST 對應可追溯的 store 與步驟

#### Scenario: receipt 不含敏感資料

- GIVEN deletion receipt 產出
- WHEN 檢查其內容
- THEN MUST NOT 含 raw credential、token、unmasked PII
- AND MUST NOT 含其他 subject 資料

### Requirement: Tombstone 防止 deleted subject／object 被靜默重建

deleted subject 與 object MUST 具 tombstone，防止 replay、cache refill 或 late event 靜默重建；tombstone 查詢命中 MUST 回傳明確 `deleted` 結果（非 `not_found`），且 tombstone 的 cache TTL MUST ≥ active record TTL。

#### Scenario: tombstone 擋下 replay 重建

- GIVEN 一個已刪除 subject 的 late event 或 replay 企圖重建
- WHEN 寫入或恢復該 subject 資料
- THEN tombstone MUST 擋下重建
- AND MUST NOT 讓 deleted subject 重新具備資料歸屬

#### Scenario: tombstone 查詢區分 deleted 與 not_found

- GIVEN 查詢一個已刪除 subject
- WHEN 命中 tombstone
- THEN MUST 回傳明確 `deleted` 結果
- AND MUST NOT 回傳 `not_found`（避免 call site 誤判可新建）

#### Scenario: tombstone cache TTL ≥ active record TTL

- GIVEN tombstone 與 active record 皆有 cache
- WHEN 設定 TTL
- THEN tombstone TTL MUST ≥ active record TTL
- AND cache miss 時 MUST 回源查 durable tombstone 而非重建

### Requirement: Late event 對 tombstoned subject 依政策處理

tombstoned subject 的 late event MUST 依政策 reject、quarantine 或 redact；MUST NOT 靜默重建或放行該 event 的資料寫入。

#### Scenario: late event 被 reject／quarantine／redact

- GIVEN 一個攜帶 tombstoned subject 的 late event
- WHEN 處理該 event
- THEN MUST 依政策 reject／quarantine／redact
- AND MUST NOT 靜默重建 subject 資料

### Requirement: Deletion verification 證明不再暴露 deleted subject data

`verifySubjectDeletion` MUST 證明各已註冊 store 不再暴露 deleted subject data；verification 結果 MUST 可追溯並納入 deletion receipt 或 terminal 狀態。

#### Scenario: verification 證明 store 已清除

- GIVEN 一個已完成 deletion 的 store
- WHEN 執行 `verifySubjectDeletion`
- THEN MUST 證明該 store 不再暴露 deleted subject data
- AND 結果 MUST 納入 receipt 或 terminal 狀態

#### Scenario: verification 失敗標記 incomplete

- GIVEN 某 store 的 deletion 後仍暴露 subject data
- WHEN 執行 verification
- THEN MUST 回傳 failed
- AND 整體 deletion MUST 標記 incomplete 且 retryable

### Requirement: Cross-user 與 cross-tenant 存取於 subject-right 入口被拒

export／deletion／verification 入口 MUST 依 durable owner/subject 拒絕 cross-user 與 cross-tenant 存取；deny MUST 為 typed reason code 且不呼叫下游。

#### Scenario: cross-tenant export 被拒

- GIVEN principal 屬於 tenant `T1` 嘗試 export tenant `T2` subject
- WHEN 執行 export
- THEN MUST 回傳 deny（`CROSS_TENANT_DENIED` 或對應 reason code）
- AND MUST NOT 呼叫下游 export handler

#### Scenario: cross-account deletion 被拒

- GIVEN account `A` 嘗試對 account `B` 發起 deletion
- WHEN 執行 deletion
- THEN MUST 回傳 deny
- AND MUST NOT 觸發 deletion workflow

### Requirement: Subject-right workflows 覆蓋 partial failure、retry、並行活動與 late event

integration test MUST 覆蓋 partial failure、retry、並行帳號活動與 late event delivery；deletion 與 export MUST 在並行帳號活動下保持 idempotent 且不交叉連結或遺失歸屬。

#### Scenario: 並行帳號活動下 deletion 語意不變

- GIVEN deletion 進行中伴隨並行帳號活動
- WHEN 執行並重試 deletion
- THEN MUST 保持 idempotent 且不交叉連結不同 subject 歸屬
- AND MUST 不遺失已處理 store 的結果

#### Scenario: 失敗案例矩陣可回歸

- GIVEN 需要驗證 subject-right 契約
- WHEN 執行 contract tests
- THEN MUST 涵蓋：
  - export 部分失敗與 retry
  - deletion 部分失敗與 retry
  - 並行帳號活動
  - late event delivery 對 tombstoned subject
  - cross-user 與 cross-tenant leakage／deny
  - deletion verification 的 completed／failed
  - receipt 的 completed／skipped／retained-by-policy／failed
