# secret-broker Specification

## Purpose

本規格定義 `SecretBroker` boundary 的正式需求：以 opaque `SecretReference` 取代 plaintext credential 在 model context／tool schema／events／checkpoint 中的傳遞，只在最終授權執行端解析 secret value，並確保 secret 值不出現在任何 persisted state、model input、structured event、receipt、log、trace 或 error payload。

## Requirements

### Requirement: opaque `SecretReference` MUST 取代 runtime 中的 plaintext credential

Backend MUST 定義 opaque `SecretReference`（`secretRef`、`secretName`、`scope`、`lease?`）。tool 的 `secretRequirements` MUST 以 `SecretReference` 宣告，不得在 tool 定義或 model context 中攜帶 plaintext value。

#### Scenario: tool 宣告 secret requirement 而非 value

GIVEN 一個需要 API key 的 tool
WHEN 宣告其 secret 需求
THEN MUST 以 `SecretReference` 宣告
AND MUST NOT 於 tool schema 或 model context 攜帶 plaintext value

#### Scenario: 未宣告 secret 的 tool 不得 resolve

GIVEN 一個 tool 未宣告任何 `secretRequirements`
WHEN 執行時嘗試 resolve secret
THEN MUST 拒絕
AND MUST NOT 提供任何 credential

---

### Requirement: `SecretBrokerPort.resolve` MUST 只在最終授權執行端解析

Backend MUST 定義 `SecretBrokerPort.resolve(reference, executionContext)`，且只允許在最終授權執行端（final authorized execution edge）呼叫。不得於 composition root 預解析後將值廣播至多個消費端。

#### Scenario: resolve 成功回傳 scoped credential

GIVEN 一個合法的 `SecretReference` 與授權過的 `executionContext`
WHEN 於最終執行端呼叫 `resolve`
THEN MUST 回傳 scoped credential
AND credential 生命週期 MUST 受限於 reference 的 `lease`／scope

#### Scenario: reference 無法解析 deny

GIVEN 一個 `SecretReference` 對應的 credential 不存在或已過期
WHEN 於最終執行端呼叫 `resolve`
THEN MUST 回傳 typed failure
AND 該 tool 執行 MUST fail closed
AND MUST NOT 以空值或 placeholder 放行

#### Scenario: 預解析後廣播被禁止

GIVEN composition root 嘗試於執行前解析並把 secret value 寫入 shared state
WHEN 檢查其資料流
THEN MUST 被禁止
AND secret value MUST 只在最終執行端解析

---

### Requirement: secret value MUST 不得進入 model context、events、checkpoint、log、trace、receipt 或 error payload

Secret value MUST 被排除於：model prompts 與 tool schemas、structured events、checkpoints、logs 與 traces、receipts 與 error payloads、crash dumps 與 diagnostics。

#### Scenario: checkpoint 不保留 secret value

GIVEN 一次工具執行使用 secret
WHEN 寫入 checkpoint
THEN checkpoint 內容 MUST 不含 secret value
AND MUST 僅含 `SecretReference`

#### Scenario: log 與 trace 遮罩 secret

GIVEN 一次工具執行使用 secret
WHEN 產生 log／trace／audit
THEN secret value MUST 被 redact
AND 不得以未遮罩形式落於 console audit、Opik span、metrics 或 error message

#### Scenario: 自動化 leakage test 通過

GIVEN 一組含 secret 的執行
WHEN 執行 secret leakage test
THEN secret value MUST 不出現在 persisted state、model input、structured event、receipt、log、trace
AND MUST 不出現在 error payload

---

### Requirement: redaction MUST 覆蓋 console audit 與 checkpoint 邊界

既有 redaction（`redaction.ts`、`DefaultContextRedactor`、Opik redaction）MUST 擴充至 `ConsoleAuditLogger` 與 checkpoint write 邊界，不得存在無遮罩的旁路。

#### Scenario: console audit 亦遮罩

GIVEN `AUDIT_BACKEND` 為 console
WHEN 記錄 audit event
THEN payload MUST 經 redaction
AND MUST NOT 直接 `JSON.stringify` 未遮罩 payload

#### Scenario: checkpoint write 邊界遮罩

GIVEN 寫入 checkpoint 的資料含 secret-bearing 欄位
WHEN 執行 checkpoint write
THEN MUST 遮罩 secret-bearing 欄位
AND MUST NOT 以 raw value 落盤

---

### Requirement: secret resolution MUST 支援短暫與 scoped credential，並於取消或失敗時清理

SecretBroker MUST 在 provider 支援時提供 short-lived 與 scoped credential；cancellation 或 crash 後不得遺留 temporary credential。

#### Scenario: short-lived credential 到期後失效

GIVEN 一個 short-lived credential
WHEN 其 lease 到期
THEN MUST 失效
AND 後續 resolve MUST 回傳 typed failure

#### Scenario: cancellation 清理 temporary credential

GIVEN 一次使用 temporary credential 的執行被取消
WHEN 清理該執行
THEN MUST 撤銷或釋放 temporary credential
AND MUST 不遺留 orphan credential
