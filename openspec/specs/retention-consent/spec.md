# retention-consent Specification

## Purpose

定義 policy-driven retention、durable expiry workflow 與 versioned consent lifecycle 契約。

## Requirements

### Requirement: Policy-driven retention 取代 hardcoded per-table timer

retention MUST 由 versioned、single-source 的 retention policy（依 data class）驅動，MUST NOT 以散落的 per-table timer 或 hardcoded 常數實作。retention policy MUST 有 version、default、validation 與 unknown value fail-closed。

#### Scenario: retention 由 policy 驅動

- GIVEN 一個 data class 的 retention policy 定義了保留期限與到期行為
- WHEN retention expiry 執行
- THEN MUST 依該 policy 判定到期與刪除行為
- AND MUST NOT 在 store 內 hard-code per-table timer

#### Scenario: retention policy 為 versioned config

- GIVEN 需要變更某 data class 的 retention
- WHEN 更新 policy
- THEN MUST 以新 version 生效
- AND 歷史資料的到期判定 MUST 使用其建立時有效的 policy version（或明確記錄採行新 policy 的規則）

#### Scenario: 未知 retention policy value fail-closed

- GIVEN 一個未知的 retention policy 值或到期行為
- WHEN 解析 policy
- THEN MUST fail-closed 並回傳 typed error
- AND MUST NOT 以推導值補齊為「永久保留」或「立即刪除」

### Requirement: Retention expiry 為 durable、idempotent、bounded 的 workflow

retention expiry MUST 以 durable workflow 執行，具 idempotency、bounded scan、resumable 與 typed status；到期刪除的失敗 MUST 留下 retryable 記錄，MUST NOT 靜默跳過。retention sweep 的**排程**不屬本 Change（屬 X33），但 sweep 本身 MUST 可被 explicit 觸發並安全重入。

#### Scenario: retention expiry 可重入且 idempotent

- GIVEN 一次 retention expiry sweep 進行中被中斷
- WHEN 再次觸發
- THEN MUST 續跑且不重複處理已完成項目
- AND 已到期項目 MUST 有可追溯的 terminal 記錄

#### Scenario: retention 失敗留下 retryable 記錄

- GIVEN 某 data class 的到期刪除失敗
- WHEN 執行 expiry
- THEN MUST 記錄該失敗並保持 retryable
- AND MUST NOT 將該到期項目標記為已完成

#### Scenario: sweep 為 bounded scan

- GIVEN 大量待到期資料
- WHEN 執行 retention sweep
- THEN MUST 以 bounded 批次掃描與處理
- AND MUST NOT 造成無界全表掃描或 retry storm

### Requirement: Versioned consent records 承載選擇性處理

選擇性處理（personalization、evaluation contribution、proactive background work）MUST 以 versioned、append-only consent record 表達；consent record MUST 記錄 policy version、狀態與時間，MUST NOT 以 consent 文字取代 record。

#### Scenario: consent record 為 versioned 且 append-only

- GIVEN 使用者同意某選擇性處理
- WHEN 寫入 consent record
- THEN MUST 建立帶 policy version 的 record
- AND 後續變更 MUST 以新 record 表達，不 rewrite 既有 facts

#### Scenario: consent 以 record 而非文字為準

- GIVEN 一段 consent 描述文字
- WHEN 判定未來處理行為
- THEN MUST 依 versioned consent record 判定
- AND MUST NOT 依 natural-language 文字反推處理授權

### Requirement: Consent withdrawal 只改未來處理行為

consent withdrawal MUST 改變未來處理行為，MUST NOT 改寫歷史 facts；withdrawal 後的資料處理（含 background work 與 evaluation contribution）MUST 依新 consent 狀態停止或依政策降級，且已處理的歷史 record MUST 保留其當時 consent version。

#### Scenario: withdrawal 只影響未來

- GIVEN 一個已記錄的 consent 被撤回
- WHEN 執行後續選擇性處理
- THEN MUST 停止或依政策降級該處理
- AND MUST NOT 改寫先前處理的歷史 facts

#### Scenario: withdrawal 後 background work 不再處理

- GIVEN 一個依賴已撤回 consent 的 proactive background work
- WHEN 該 job 於 resume 邊界檢查 consent
- THEN MUST 停止執行或依政策約束
- AND MUST NOT 以排程時快照的 consent 為永久授權

### Requirement: Consent 記錄的留存與刪除納入 governance

consent record MUST 作為 governed data class 註冊進 inventory，具 retention、export、deletion 行為；撤銷後的 consent record 依最小化原則保留，僅保留必要的合規證據，且 identifier-minimized。

#### Scenario: consent record 可匯出與刪除

- GIVEN 一個 subject 的 consent records
- WHEN 執行 export 或 deletion
- THEN MUST 依 inventory 定義的行為匯出或刪除
- AND retained 證據 MUST 最小化且 identifier-minimized
